import { hostname } from 'node:os';
import { existsSync, readdirSync } from 'node:fs';
import Docker from 'dockerode';
import type { Instance } from './store.js';

const WECHAT_IMAGE = process.env.WOC_WECHAT_IMAGE || 'ghcr.io/gloridust/wechat-on-cloud:latest';
const FIREFOX_IMAGE = process.env.WOC_FIREFOX_IMAGE || 'ghcr.io/gloridust/cc-firefox:latest';
const GAMING_IMAGE = process.env.WOC_GAMING_IMAGE || 'ghcr.io/gloridust/cc-gaming:latest';
function instanceImage(inst: Instance): string {
  switch (inst.appType) {
    case 'firefox': return FIREFOX_IMAGE;
    case 'gaming': return GAMING_IMAGE;
    default: return WECHAT_IMAGE;
  }
}
const PUID = process.env.PUID || '1000';
const PGID = process.env.PGID || '1000';
const TZ = process.env.TZ || 'Asia/Shanghai';
const SHM_SIZE = 1024 * 1024 * 1024; // 1gb

const docker = new Docker(); // 默认连 /var/run/docker.sock

// 面板自身所在的 docker 网络名；新实例都 attach 到它，便于按容器名互访。
let networkName: string | null = process.env.WOC_DOCKER_NETWORK || null;

export type RuntimeState = 'running' | 'stopped' | 'missing';

// 启动时探测面板自身网络（容器内 hostname = 容器短 id）。失败不致命：
// 退回 WOC_DOCKER_NETWORK 或 null（null 时用 docker 默认 bridge，靠 IP 不靠名字会有问题，故尽量探测成功）。
export async function ensureNetwork(): Promise<string | null> {
  if (networkName) return networkName;
  try {
    const self = docker.getContainer(hostname());
    const info = await self.inspect();
    const nets = Object.keys(info.NetworkSettings?.Networks || {}).filter((n) => n !== 'none' && n !== 'host');
    if (nets.length > 0) networkName = nets[0];
  } catch (e: any) {
    console.warn('[docker] 无法探测面板网络（本地开发或缺少 docker.sock 时正常）:', e?.message || e);
  }
  return networkName;
}

// 摄像头直通：把宿主的 v4l2 视频设备映射进实例容器
function videoDevices(): string[] {
  const explicit = (process.env.WOC_VIDEO_DEVICES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (explicit.length) return explicit;
  for (const dir of ['/host-dev', '/dev']) {
    try {
      if (!existsSync(dir)) continue;
      const vids = readdirSync(dir)
        .filter((n) => /^video\d+$/.test(n))
        .map((n) => `/dev/${n}`);
      if (vids.length) return vids;
    } catch {
      /* 无权限/不可读，忽略 */
    }
  }
  return [];
}

function envList(inst: Instance): string[] {
  return [
    `PUID=${PUID}`,
    `PGID=${PGID}`,
    `TZ=${TZ}`,
    `CUSTOM_USER=${inst.kasmUser}`,
    `PASSWORD=${inst.kasmPassword}`,
  ];
}

// 确保实例镜像在本地存在；缺失则从 GHCR 拉取。
async function ensureImage(inst: Instance): Promise<void> {
  const img = instanceImage(inst);
  try {
    await docker.getImage(img).inspect();
    return;
  } catch {
    /* 本地没有，下面拉取 */
  }
  await pullImage(inst);
}

// 创建并启动一个实例容器。若同名容器已存在则先移除（仅容器，不动卷）。
export async function runInstance(inst: Instance): Promise<void> {
  const net = await ensureNetwork();
  await ensureImage(inst);
  try {
    const existing = docker.getContainer(inst.containerName);
    await existing.inspect();
    await existing.remove({ force: true });
  } catch {
    /* 不存在，正常 */
  }
  const vids = videoDevices();
  const hostConfig: Docker.HostConfig = {
    Binds: [`${inst.volumeName}:/config`],
    NetworkMode: net || undefined,
    SecurityOpt: ['seccomp=unconfined', 'apparmor:unconfined'],
    ShmSize: SHM_SIZE,
    RestartPolicy: { Name: 'unless-stopped' },
    // Steam 需要 user namespaces + bubblewrap (privileged 模式)
    ...(inst.appType === 'gaming' ? { UsernsMode: 'host', Privileged: true } : {}),
  };
  // Gaming 实例直通 GPU
  // 面板通过 /host-dev 看到宿主 /dev，但传给 Docker 必须用宿主真实路径
  const gpuDevs: Docker.DeviceMapping[] = [];
  if (inst.appType === 'gaming') {
    const probeDir = existsSync('/host-dev/dri') ? '/host-dev/dri' : '/dev/dri';
    if (existsSync(probeDir)) {
      const driFiles = readdirSync(probeDir).filter((n) => n.startsWith('card') || n.startsWith('render'));
      for (const f of driFiles) {
        // 使用宿主真实路径 /dev/dri/...，而非面板内的 /host-dev/dri/...
        gpuDevs.push({ PathOnHost: `/dev/dri/${f}`, PathInContainer: `/dev/dri/${f}`, CgroupPermissions: 'rwm' });
      }
    }
  }
  if (vids.length || gpuDevs.length) {
    hostConfig.Devices = [...vids.map((d) => ({ PathOnHost: d, PathInContainer: d, CgroupPermissions: 'rwm' })), ...gpuDevs];
    hostConfig.GroupAdd = ['video', 'render'];

    console.log(`[docker] 实例 ${inst.id} 挂载摄像头设备: ${vids.join(', ')}`);
  }
  const container = await docker.createContainer({
    name: inst.containerName,
    Image: instanceImage(inst),
    Hostname: inst.containerName,
    Env: envList(inst),
    ExposedPorts: { '3000/tcp': {} },
    HostConfig: hostConfig,
  });
  await container.start();
}

// 确保实例容器在运行：缺失则按需创建（不会重建已有卷），停止则启动。
export async function ensureRunning(inst: Instance): Promise<void> {
  try {
    const c = docker.getContainer(inst.containerName);
    const info = await c.inspect();
    if (!info.State?.Running) await c.start();
  } catch {
    await runInstance(inst);
  }
}

// 升级实例：拉取最新镜像后重建容器（保留数据卷）。
// 拉取失败则用本地现有镜像重建，不阻断。
export async function upgradeInstance(inst: Instance): Promise<void> {
  try {
    await pullImage(inst);
  } catch (e: any) {
    console.warn('[docker] 升级时拉取镜像失败，改用本地镜像重建:', e?.message || e);
  }
  await runInstance(inst);
}

// 停止实例容器（保留容器与数据卷，可再启动）。
export async function stopInstance(inst: Instance): Promise<void> {
  try {
    await docker.getContainer(inst.containerName).stop({ t: 5 } as any);
  } catch {
    /* 已停止或不存在 */
  }
}

export async function removeInstance(inst: Instance, purgeVolume: boolean): Promise<void> {
  try {
    const c = docker.getContainer(inst.containerName);
    await c.remove({ force: true });
  } catch {
    /* 容器可能已不存在 */
  }
  if (purgeVolume) {
    try {
      await docker.getVolume(inst.volumeName).remove({ force: true } as any);
    } catch {
      /* 卷可能不存在 */
    }
  }
}

export async function instanceRuntime(inst: Instance): Promise<RuntimeState> {
  try {
    const info = await docker.getContainer(inst.containerName).inspect();
    return info.State?.Running ? 'running' : 'stopped';
  } catch {
    return 'missing';
  }
}

// 在实例容器内执行命令，返回 stdout（demux 后只取标准输出）。
async function execCapture(inst: Instance, cmd: string[]): Promise<string> {
  const c = docker.getContainer(inst.containerName);
  const exec = await c.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false, User: 'abc' });
  const stream = await exec.start({ hijack: true, stdin: false });
  return await new Promise<string>((resolve, reject) => {
    let out = '';
    let err = '';
    const stdout = { write: (b: Buffer) => { out += b.toString('utf8'); } } as any;
    const stderr = { write: (b: Buffer) => { err += b.toString('utf8'); } } as any;
    docker.modem.demuxStream(stream, stdout, stderr);
    stream.on('end', () => resolve(out || err));
    stream.on('error', reject);
  });
}

// 触发微信下载/安装（仅 wechat 类型实例）。firefox 等无需下载步骤。
export async function triggerWechat(inst: Instance, cmd: 'install' | 'update'): Promise<void> {
  if (inst.appType !== 'wechat') return; // 非微信类型无需此操作
  const c = docker.getContainer(inst.containerName);
  const exec = await c.exec({
    Cmd: ['/woc/wechat-ctl.sh', cmd === 'update' ? 'update' : 'install'],
    AttachStdout: false,
    AttachStderr: false,
    User: 'abc',
  });
  await exec.start({ Detach: true });
}

export interface WechatStatus {
  phase: string;
  percent: number;
  installed: boolean;
  version: string;
  message: string;
  updatedAt: number;
}

const DEFAULT_STATUS: WechatStatus = { phase: 'idle', percent: 0, installed: false, version: '', message: '未安装', updatedAt: 0 };

export async function wechatStatus(inst: Instance): Promise<WechatStatus> {
  if (inst.appType !== 'wechat') {
    return { ...DEFAULT_STATUS, phase: 'done', installed: true, message: '已就绪', percent: 100 };
  }
  try {
    const raw = await execCapture(inst, ['/woc/wechat-ctl.sh', 'status']);
    const json = JSON.parse(raw.trim());
    return { ...DEFAULT_STATUS, ...json };
  } catch {
    return DEFAULT_STATUS;
  }
}

// 拉取实例对应镜像（首次部署/更新镜像用）。
export async function pullImage(inst: Instance, onProgress?: (line: any) => void): Promise<void> {
  const img = instanceImage(inst);
  return await new Promise((resolve, reject) => {
    docker.pull(img, (err: any, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(
        stream,
        (e: any) => (e ? reject(e) : resolve()),
        (ev: any) => onProgress?.(ev),
      );
    });
  });
}

// ---------- 文件中转（上传/下载） ----------
const TRANSFER_DIR = '/config/Desktop';

function tarSingleFile(name: string, content: Buffer): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0001750\0', 108);
  h.write('0001750\0', 116);
  h.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = (512 - (content.length % 512)) % 512;
  return Buffer.concat([h, content, Buffer.alloc(pad, 0), Buffer.alloc(1024, 0)]);
}

function safeName(name: string): boolean {
  return !!name && name.length <= 200 && !name.includes('/') && !name.includes('\0') && name !== '.' && name !== '..';
}

export async function uploadToInstance(inst: Instance, name: string, content: Buffer): Promise<void> {
  if (!safeName(name)) throw new Error('文件名不合法');
  await execCapture(inst, ['sh', '-c', `mkdir -p ${TRANSFER_DIR}`]);
  const c = docker.getContainer(inst.containerName);
  await c.putArchive(tarSingleFile(name, content), { path: TRANSFER_DIR });
}

export interface TransferFile {
  name: string;
  size: number;
}
export async function listInstanceFiles(inst: Instance): Promise<TransferFile[]> {
  const out = await execCapture(inst, [
    'sh',
    '-c',
    `find ${TRANSFER_DIR} -maxdepth 1 -type f -printf '%f\\t%s\\n' 2>/dev/null`,
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, size] = line.split('\t');
      return { name, size: Number(size) || 0 };
    });
}

export async function deleteInstanceFile(inst: Instance, name: string): Promise<void> {
  if (!safeName(name)) throw new Error('文件名不合法');
  await execCapture(inst, ['rm', '-f', `${TRANSFER_DIR}/${name}`]);
}

export async function downloadFromInstance(inst: Instance, name: string): Promise<Buffer> {
  if (!safeName(name)) throw new Error('文件名不合法');
  const c = docker.getContainer(inst.containerName);
  const stream = (await c.getArchive({ path: `${TRANSFER_DIR}/${name}` })) as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (d: Buffer) => chunks.push(d));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  const tar = Buffer.concat(chunks);
  if (tar.length < 512) return Buffer.alloc(0);
  const sizeStr = tar.toString('ascii', 124, 135).replace(/\0/g, '').trim();
  const size = parseInt(sizeStr, 8) || 0;
  return tar.subarray(512, 512 + size);
}

// 实例容器名（供反代构造 target）。
export function instanceTarget(inst: Instance): string {
  return `http://${inst.containerName}:3000`;
}

export { instanceImage };
