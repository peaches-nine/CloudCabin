# CloudCabin · 云舱

> Forked from [Gloridust/WechatOnCloud](https://github.com/Gloridust/WechatOnCloud)（云微 WOC）.
> WOC 在 NAS/服务器上跑服务端微信，多端浏览器共享同一微信会话。
> **CloudCabin 将这套架构泛化为通用「容器化 GUI 应用串流平台」——微信只是第一个 App。**

## 核心架构

```
浏览器 ──▶ panel(:36080) ──┬─ /               SPA 前端（React + Vite + PWA）
            cookie session  ├─ /api/*           REST API（账号/实例/权限）
                            └─ /desktop/:id/*   反代 → 实例容器 KasmVNC（服务端注入 Basic Auth）

panel ──(docker.sock)──▶ Docker 引擎 ──▶ 按需创建/销毁 cc-app-<id> 实例容器
                                          每个实例 = 独立容器 + 独立数据卷 + 独立 GUI 会话
                                          实例仅在 docker 网络内暴露，面板反代到浏览器
```

**两容器角色：**
| | 面板容器 | 实例容器 |
|---|---|---|
| 镜像 | `cc-panel` | 按 App 类型不同（`cc-wechat`、`cc-firefox` 等） |
| 启动方式 | `docker compose up -d` | 面板动态 `docker run` |
| 对外端口 | 宿主 36080→8080 | 无（仅 docker 网络内） |
| 数据 | `./data-panel` | 独立卷 `cc-data-<id>` |
| 生命周期 | 常驻 | 面板增删启停 |

**技术栈：**
- 后端：Fastify (TypeScript) + dockerode + bcryptjs + cookie session
- 前端：React + TS + Vite + PWA
- 串流：linuxserver KasmVNC base 镜像（Xvfb + openbox + noVNC）
- 存储：JSON 文件（`accounts.json`）+ Docker 命名卷

## 关键源文件

### panel/server/src/ — 后端核心
| 文件 | 职责 |
|------|------|
| `index.ts` | Fastify 入口：路由注册、鉴权中间件、HTTP→WS 反代、启动时恢复实例 |
| `store.ts` | 用户/实例 CRUD、RBAC、JSON 文件持久化（原子 write → rename） |
| `docker.ts` | dockerode 封装：容器生命周期、镜像拉取、exec 触发脚本、文件中转 |
| `sessions.ts` | 内存 session 管理（cookie → userId） |

### panel/web/src/ — 前端
| 文件 | 职责 |
|------|------|
| `App.tsx` | 路由 + 登录守卫 |
| `AppShell.tsx` | 微信 PC 式布局（左侧实例栏 + 右侧内嵌桌面 iframe） |
| `api.ts` | fetch 封装（自动抛 401 → 跳登录） |
| `auth.tsx` | AuthContext（当前用户 + 登录/登出） |
| `pages/Admin.tsx` | 管理员：用户/实例管理 |
| `pages/Dashboard.tsx` | 实例网格（卡片列表） |
| `pages/Desktop.tsx` | 内嵌 KasmVNC iframe + 操作控制权软锁 |
| `pages/Login.tsx` | 登录表单 |

### docker/ — 实例镜像
| 文件 | 职责 |
|------|------|
| `Dockerfile` | 基于 `lscr.io/linuxserver/baseimage-kasmvnc:debianbookworm`，装中文字体 + 微信依赖 + 默认 IME 模式 |
| `autostart` | openbox 会话启动脚本：等待 App 就绪 + 常驻拉起 + 最小化自动复原看守 |
| `wechat-ctl.sh` | 微信下载/解压/安装 → 状态 JSON 上报（面板轮询）；架构自动检测 |
| `woc-update-autostart` | 启动钩子：用镜像内最新 autostart 覆盖卷里旧副本 |

## 变成通用平台要改什么

**已有通用能力（不用改）：**
- 容器生命周期管理（创建/启停/升级/删除）
- KasmVNC 反代 + 鉴权注入
- RBAC 用户/实例权限
- 多端协作软锁（心跳持锁 + 10s TTL）
- 文件上传/下载/删除
- PWA 前端

**微信耦合点（需要泛化）：**
1. `docker/autostart` — 启动命令写死 `wechat` 二进制路径
2. `docker/Dockerfile` — 依赖列表是微信专用的（`libxcb-*`、`libgtk-3-0` 等）
3. `docker/wechat-ctl.sh` — 下载/安装逻辑写死腾讯 CDN + deb 解压
4. `panel/server/src/index.ts` — `/api/admin/instances/:id/wechat/install` 和 `update` 端点
5. `panel/server/src/docker.ts` — `triggerWechat()` / `wechatStatus()` 函数名

**第二个 App（Firefox）验证路径：**
- Dockerfile：加一行 `firefox-esr`
- autostart：把 `WECHAT_BIN` 换成 `firefox --no-sandbox`
- wechat-ctl.sh：可删（Firefox 不需要运行时下载）
- 面板不改

## 命名约定

- 面板容器：`cc-panel`
- 实例容器：`cc-<app>-<id>`（如 `cc-wechat-a1b2c3`）
- 数据卷：`cc-data-<id>`
- Docker 网络：`cc-net`（compose 自动创建）
- 面板数据：`./data-panel`

## Agent skills

### Issue tracker

GitHub Issues — `peaches-nine/CloudCabin`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` at repo root, ADRs in `docs/adr/`. See `docs/agents/domain.md`.
