import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';

export type Role = 'admin' | 'sub';
export type AppType = 'wechat' | 'firefox' | 'gaming';

export interface User {
  id: string;
  username: string;
  role: Role;
  passwordHash: string;
  disabled: boolean;
  createdAt: string;
  // 该账户可访问的实例 id 列表。admin 隐式全部，忽略此字段。
  allowedInstances: string[];
  // 仍在使用初始默认密码时为 true，前端据此提示尽快改密；任意一次改密/重置后清除。
  mustChangePassword?: boolean;
  // 离线密码找回：在 accounts.json 手动把某用户置为 true，重启面板即重置其密码并清除此标记。
  // 兼容下划线写法 reset_password。
  resetPassword?: boolean;
  reset_password?: boolean;
}

// 初始默认管理员密码；管理员仍在用它时强烈提示改密。
const DEFAULT_ADMIN_PASSWORD = 'wechat';

export interface Instance {
  id: string; // 短 id，用于容器/卷命名
  name: string; // 显示名
  appType: AppType; // 'wechat' | 'firefox'，决定镜像与行为
  containerName: string; // cc-app-<id>
  volumeName: string; // cc-data-<id>
  kasmUser: string; // 随机生成，服务端注入反代，永不下发前端
  kasmPassword: string;
  createdAt: string;
  createdBy: string; // userId
}

interface Data {
  users: User[];
  instances: Instance[];
}

const FILE = process.env.PANEL_DATA || '/data/panel/accounts.json';

let data: Data = { users: [], instances: [] };

function persist() {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, FILE);
}

function makeUser(username: string, password: string, role: Role): User {
  return {
    id: randomUUID(),
    username,
    role,
    passwordHash: bcrypt.hashSync(password, 10),
    disabled: false,
    createdAt: new Date().toISOString(),
    allowedInstances: [],
  };
}

export function initStore() {
  if (existsSync(FILE)) {
    data = JSON.parse(readFileSync(FILE, 'utf8'));
  } else {
    data = { users: [], instances: [] };
  }
  // 迁移：补齐新增字段，兼容旧账号文件
  if (!Array.isArray(data.instances)) data.instances = [];
  for (const u of data.users) {
    if (!Array.isArray(u.allowedInstances)) u.allowedInstances = [];
  }
  // 迁移：旧实例无 appType → 默认 wechat
  for (const i of data.instances) {
    if (!(i as any).appType) (i as any).appType = 'wechat';
  }
  if (!data.users.some((u) => u.role === 'admin')) {
    const username = process.env.PANEL_ADMIN_USER || 'admin';
    const password = process.env.PANEL_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
    const admin = makeUser(username, password, 'admin');
    // 用默认密码初始化时标记，提醒尽快改密
    if (password === DEFAULT_ADMIN_PASSWORD) admin.mustChangePassword = true;
    data.users.push(admin);
    console.log(`[store] 已初始化管理员账号 '${username}'`);
  } else {
    // 兼容旧账号文件：管理员若仍能用默认密码登录，补打"需改密"标记
    for (const u of data.users) {
      if (u.role === 'admin' && u.mustChangePassword === undefined) {
        u.mustChangePassword = bcrypt.compareSync(DEFAULT_ADMIN_PASSWORD, u.passwordHash);
      }
    }
  }
  // 离线密码找回：忘记超管密码时，停掉面板 → 在 accounts.json 给该用户加 "resetPassword": true
  // → 重启面板。这里把其密码重置为 PANEL_ADMIN_PASSWORD（默认 wechat）、解禁，并清除标记。
  for (const u of data.users) {
    if ((u as any).resetPassword === true || (u as any).reset_password === true) {
      const pw = process.env.PANEL_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
      u.passwordHash = bcrypt.hashSync(pw, 10);
      u.mustChangePassword = pw === DEFAULT_ADMIN_PASSWORD; // 重置成默认密码则提示尽快改密
      u.disabled = false;
      delete (u as any).resetPassword;
      delete (u as any).reset_password;
      console.log(`[store] 已重置用户 '${u.username}' 的密码（resetPassword 标记，密码=PANEL_ADMIN_PASSWORD 或默认 wechat）`);
    }
  }
  persist();
}

// ---------- 用户 ----------
export function publicUser(u: User) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    disabled: u.disabled,
    createdAt: u.createdAt,
    allowedInstances: u.role === 'admin' ? [] : u.allowedInstances,
    mustChangePassword: !!u.mustChangePassword,
  };
}

export function findByUsername(username: string) {
  return data.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
}

export function findById(id: string) {
  return data.users.find((u) => u.id === id);
}

export function listUsers() {
  return data.users
    .slice()
    .sort((a, b) => (a.role === b.role ? a.createdAt.localeCompare(b.createdAt) : a.role === 'admin' ? -1 : 1))
    .map(publicUser);
}

export function verifyPassword(u: User, password: string) {
  return bcrypt.compareSync(password, u.passwordHash);
}

export function createSub(username: string, password: string, allowedInstances: string[] = []) {
  if (findByUsername(username)) throw new Error('用户名已存在');
  const u = makeUser(username, password, 'sub');
  u.allowedInstances = sanitizeInstanceIds(allowedInstances);
  data.users.push(u);
  persist();
  return publicUser(u);
}

export function setDisabled(id: string, disabled: boolean) {
  const u = findById(id);
  if (!u) throw new Error('用户不存在');
  if (u.role === 'admin') throw new Error('不能禁用管理员');
  u.disabled = disabled;
  persist();
  return publicUser(u);
}

export function resetPassword(id: string, password: string) {
  const u = findById(id);
  if (!u) throw new Error('用户不存在');
  u.passwordHash = bcrypt.hashSync(password, 10);
  u.mustChangePassword = false; // 改过密就不再提示
  persist();
  return publicUser(u);
}

export function deleteUser(id: string) {
  const u = findById(id);
  if (!u) throw new Error('用户不存在');
  if (u.role === 'admin') throw new Error('不能删除管理员');
  data.users = data.users.filter((x) => x.id !== id);
  persist();
}

// 设置某账户可访问的实例（账户侧编辑）
export function setUserInstances(id: string, instanceIds: string[]) {
  const u = findById(id);
  if (!u) throw new Error('用户不存在');
  if (u.role !== 'admin') u.allowedInstances = sanitizeInstanceIds(instanceIds);
  persist();
  return publicUser(u);
}

// ---------- 实例 ----------
function sanitizeInstanceIds(ids: string[]): string[] {
  const valid = new Set(data.instances.map((i) => i.id));
  return [...new Set((ids || []).filter((x) => valid.has(x)))];
}

export function publicInstance(i: Instance) {
  return { id: i.id, name: i.name, appType: i.appType, createdAt: i.createdAt, createdBy: i.createdBy };
}

export function listInstances() {
  return data.instances.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function findInstance(id: string) {
  return data.instances.find((i) => i.id === id);
}

// 当前用户可见的实例（admin 全部，sub 按 allowedInstances）
export function userInstances(u: User) {
  if (u.role === 'admin') return listInstances();
  const allowed = new Set(u.allowedInstances);
  return listInstances().filter((i) => allowed.has(i.id));
}

export function userCanAccess(u: User, instanceId: string) {
  if (u.role === 'admin') return !!findInstance(instanceId);
  return u.allowedInstances.includes(instanceId) && !!findInstance(instanceId);
}

export function createInstance(name: string, createdBy: string, allowedUserIds: string[] = [], appType: AppType = 'wechat') {
  const id = randomBytes(5).toString('hex'); // 10 hex chars
  const inst: Instance = {
    id,
    name: name.trim() || `${appType === 'firefox' ? '火狐' : '微信'}-${id.slice(0, 4)}`,
    appType,
    containerName: `cc-app-${id}`,
    volumeName: `cc-data-${id}`,
    kasmUser: 'woc',
    // 用 hex（仅 0-9a-f）：容器内 init 脚本以 `openssl passwd -apr1 ${PASSWORD}` 未加引号方式生成 .htpasswd，
    // base64url 可能含前导 '-' 而被 openssl 当作命令行选项，导致密码哈希为空、所有鉴权失败。hex 不含任何 shell 特殊字符。
    kasmPassword: randomBytes(24).toString('hex'),
    createdAt: new Date().toISOString(),
    createdBy,
  };
  data.instances.push(inst);
  // 把访问权限写到选中的账户上
  for (const uid of allowedUserIds || []) {
    const u = findById(uid);
    if (u && u.role !== 'admin' && !u.allowedInstances.includes(id)) {
      u.allowedInstances.push(id);
    }
  }
  persist();
  return inst;
}

export function renameInstance(id: string, name: string) {
  const inst = findInstance(id);
  if (!inst) throw new Error('实例不存在');
  const n = (name || '').trim();
  if (!n || n.length > 30) throw new Error('实例名称为 1-30 个字符');
  inst.name = n;
  persist();
  return publicInstance(inst);
}

export function removeInstance(id: string) {
  const inst = findInstance(id);
  if (!inst) throw new Error('实例不存在');
  data.instances = data.instances.filter((i) => i.id !== id);
  // 从所有账户的可访问列表里移除
  for (const u of data.users) {
    u.allowedInstances = u.allowedInstances.filter((x) => x !== id);
  }
  persist();
  return inst;
}

// 设置某实例可被哪些账户访问（实例侧编辑）
export function setInstanceUsers(id: string, userIds: string[]) {
  const inst = findInstance(id);
  if (!inst) throw new Error('实例不存在');
  const allow = new Set(userIds || []);
  for (const u of data.users) {
    if (u.role === 'admin') continue;
    const has = u.allowedInstances.includes(id);
    if (allow.has(u.id) && !has) u.allowedInstances.push(id);
    if (!allow.has(u.id) && has) u.allowedInstances = u.allowedInstances.filter((x) => x !== id);
  }
  persist();
  return inst;
}

// 已登记一个实例（迁移用：复用旧 ./data 卷）。返回是否新建。
export function registerExistingInstance(opts: {
  name: string;
  containerName: string;
  volumeName: string;
  kasmUser: string;
  kasmPassword: string;
  createdBy: string;
}) {
  const id = randomBytes(5).toString('hex');
  const inst: Instance = { id, appType: 'wechat', createdAt: new Date().toISOString(), ...opts };
  data.instances.push(inst);
  persist();
  return inst;
}
