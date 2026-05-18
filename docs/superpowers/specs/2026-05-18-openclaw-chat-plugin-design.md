# OpenClaw Chat 插件 — 设计

日期: 2026-05-18
状态: Draft

## 概述

在 M↓ (mdeditor) 中加入 OpenClaw 对话能力，使 M↓ 成为本机 OpenClaw 实例的官方
"channel"，同时通过 Cloudflare Worker 中继让远程的 M↓ 设备也能复用同一个
OpenClaw 后端，全程不要求 OpenClaw 对外暴露任何 web 端口。

本设计跨三个仓库 / 模块：

1. **OpenClaw** —— 新增 in-process channel plugin `mdeditor`
2. **mdeditor** —— 新增独立 chat 窗口、host 模式 (UDS) / remote 模式 (WSS) 自动切换、与 vaultgitsync 的链接联动
3. **mdrelay** —— mdeditor 仓库内新增的 Cloudflare Worker（与 mdshare 同级），做 WSS 中继与 pairing

## 目标

- M↓ 内嵌的 chat UI 能完整使用 OpenClaw 的对话能力（含 streaming、agent 路由、附件）
- OpenClaw 进程不监听任何 TCP / web 端口；本机 IPC 走 Unix Domain Socket
- 远程 M↓ 客户端不需要 VPN / 隧道 / 端口转发，通过 cf worker 双向 WSS 即可使用
- 同一个 OpenClaw 的对话历史在所有 device 之间共享（host + 多个 remote 看到同一组 sessions）
- chat 中相对路径的 md 链接能自动解析到本地 vault；本地副本缺失时能触发 vaultgitsync 同步
- chat 窗口与 M↓ 编辑器主窗口生命周期解耦，关闭其一不影响另一

## 非目标

- 端到端加密（host ↔ remote）—— 本设计只用 WSS 保护传输，CF Worker 看得到明文
- 跨机器实时 P2P 资源访问（如直接读对方文件系统）—— vault 之间的同步走 vaultgitsync (git remote)，不另造 mesh
- 替代 OpenClaw 自家 macOS / iOS SwiftUI WebChat —— 本设计平行于它
- 浏览器作为 client —— remote 端是 M↓ desktop binary，不是网页
- 多 OpenClaw 后端（一个 M↓ 同时接多台 OpenClaw 服务器）

## 总拓扑

```
┌──────────────────────────────────────────────────────────────────┐
│  Host Machine (OpenClaw 所在机器)                                │
│                                                                  │
│  ┌──────────────────┐         ┌────────────────────────────┐     │
│  │  OpenClaw        │   UDS   │  M↓ (host 模式)            │     │
│  │  in-process JS   │◄───────►│  ① UDS channel client      │     │
│  │  ┌────────────┐  │ (本机)  │  ② 本机 chat 窗口          │     │
│  │  │ channel    │  │         │  ③ Relay bridge: 出站 WSS  │     │
│  │  │ "mdeditor" │  │         │  ④ vaultgitsync            │     │
│  │  └────────────┘  │         └────────────┬───────────────┘     │
│  │  无 inbound 端口 │                      │ 出站 WSS            │
│  └──────────────────┘                      │ (mdrelay/ws/host)   │
└────────────────────────────────────────────┼─────────────────────┘
                                             ▼
                              ┌──────────────────────────────┐
                              │  Cloudflare Worker mdrelay   │
                              │  WSS 转发器 + Durable Object │
                              │  (一对 pairing 一个 DO)      │
                              │  无 E2E，看明文              │
                              │  不持久化消息内容            │
                              └──────────────┬───────────────┘
                                             ▲ 出站 WSS
                                             │ (mdrelay/ws/remote)
                              ┌──────────────┴───────────────┐
                              │  M↓ (remote 模式)            │
                              │  ① chat 窗口                 │
                              │  ② 可选本地 vault            │
                              │     (vaultgitsync 跟同一     │
                              │      git remote 同步)        │
                              └──────────────────────────────┘
```

## Section 1 — M↓ 客户端外壳

### 1.1 单一 binary，运行时切模式

启动时探测 `~/.openclaw/mdeditor.sock`：

| 探测结果 | 模式 | 行为 |
|---|---|---|
| 存在且能 `connect()` | **Host** | 起 UDS channel client + Relay bridge（对 mdrelay 出站长连） |
| 不存在或连不上 | **Remote** | 起 WSS client，连 mdrelay；不起 UDS client、不起 relay bridge |

Settings 提供覆盖：
- `openclaw.mode`: `"auto" | "host" | "remote"` (default `"auto"`)
- `openclaw.socketPath`: 覆盖默认 UDS 路径
- `openclaw.relayUrl`: 覆盖默认 mdrelay endpoint

### 1.2 Chat 窗口

独立 Tauri WebView 窗口，与编辑器主窗口共享同一个 binary / Rust 后端，但 UI、生命周期完全独立。

- 入口 HTML: `chat.html` (Vite 多入口配置，需要扩展现有 `vite.config.ts` 的 `rollupOptions.input`)；Svelte root 独立于 `App.svelte`
- 窗口默认尺寸: 480 × 720
- 单实例：再次触发"打开 OpenClaw"时 focus 现有窗口，不再开第二个
- 关闭 chat 窗口 → 不影响编辑器主窗口；反之亦然
- "Quit M↓" (tray) → 退出整个 app（两个窗口都关）
- 位置 / 尺寸记忆到 settings，下次开恢复

### 1.3 Tray 入口

现有 tray 菜单插入一条 `OpenClaw`：

```
Show M↓
─────────
OpenClaw                  ← 新增
─────────
Vault Sync: …             (已有)
  Start / Stop / Sync Now / View Log…
─────────
Quit M↓
```

点击 → 若 chat 窗口已开则 focus；否则启动 chat 窗口。无论 M↓ 编辑器主窗口在不在跑都能用。

## Section 2 — OpenClaw `mdeditor` channel plugin

### 2.1 部署位置 / 文件结构

属于 OpenClaw 仓库（不在 mdeditor 仓库内），按 OpenClaw 的 extension 约定：

```
openclaw/extensions/mdeditor/
├── openclaw.plugin.json     # 注册 channel id, JSON schema
├── package.json
├── index.ts                 # api.registerChannel({ plugin }) 入口
└── src/
    ├── channel.ts           # OpenClaw channel 接口实现
    ├── uds-server.ts        # UDS 监听 + 连接生命周期
    ├── protocol.ts          # 帧编解码 + 路由
    ├── config-schema.ts     # 派生自 openclaw.plugin.json
    └── session.ts           # 单 account session 池管理
```

`openclaw.plugin.json` 字段:

```json
{
  "id": "mdeditor",
  "name": "M↓ Chat",
  "description": "Native M↓ chat client via local UDS + cf worker relay",
  "channels": ["mdeditor"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "socketPath":   { "type": "string", "default": "~/.openclaw/mdeditor.sock" },
      "accessToken":  { "type": "string" },
      "maxClients":   { "type": "integer", "default": 1, "minimum": 1, "maximum": 1 }
    }
  }
}
```

`maxClients = 1` 因为每台 host 只跑一个 M↓ host；多 remote 是 M↓ host 自己 fan-out 通过 mdrelay，不是同时多 UDS。

### 2.2 UDS 协议

- 路径: `~/.openclaw/mdeditor.sock`，权限 `0600`
- 鉴权三重:
  1. Peer-UID check（同 uid 才接受）
  2. Access token 握手
  3. 每帧 HMAC
- 帧格式: **line-delimited JSON** (一行一对象，`\n` 分隔)

握手:

```jsonc
// host → plugin
{"v": 1, "type": "hello", "token": "...", "device": "host-local"}
// plugin → host
{"v": 1, "type": "welcome", "channel_caps": ["text","attachments","markdown","streaming"]}
```

### 2.3 双向消息

```jsonc
// plugin → host (agent 输出，支持 streaming)
{"type": "agent.message.delta", "session": "s1", "msg_id": "m1", "text": "..."}
{"type": "agent.message.end",   "session": "s1", "msg_id": "m1", "stop_reason": "end_turn"}
{"type": "agent.attachment",    "session": "s1", "msg_id": "m1", "media_type": "...", "url": "..."}
{"type": "agent.tool_call",     "session": "s1", "msg_id": "m1", "tool": "...", "args": {...}}
{"type": "agent.file_content",  "session": "s1", "path": "...", "content": "...", "media_type": "..."}

// host → plugin (用户输入)
{"type": "user.message",       "session": "s1", "text": "...", "attachments": []}
{"type": "user.cancel",        "session": "s1", "msg_id": "m1"}
{"type": "user.attach.upload", "session": "s1", "blob_id": "b1", "filename": "...", "bytes_b64": "..."}
{"type": "user.request_file",  "session": "s1", "path": "./notes/foo.md"}   // web 模式：拉 vault 文件
{"type": "user.push_file",     "session": "s1", "path": "...", "content": "..."}  // web 模式：写回 vault

// session 管理
{"type": "session.list"}
{"type": "session.list.result", "sessions": [{"id":"s1","title":"...","updated_at":"..."}]}
{"type": "session.new", "title": "..."}
{"type": "session.open", "id": "s1"}
{"type": "session.replay", "id": "s1", "after_msg_id": "m37"}
```

每帧带 `"v": 1`；未来 breaking change 升 `v: 2`，旧路径保留至少一个 release 周期。

### 2.4 Account / Session 模型

**单 account**：channel plugin 在 OpenClaw 内只注册一个 default account。所有 device（host-local + 各 remote）映射到同一 account，看到**同一组 sessions**。任一 device 发消息 → broadcast 到所有当前在线 device。

OpenClaw session 是 source of truth；channel plugin 通过 OpenClaw 的 sessions API 持久化。

### 2.5 Channel 能力声明

向 OpenClaw register 的 capabilities:

- ✅ `text`
- ✅ `attachments` (单文件 5MB；更大走切片)
- ✅ `markdown` (agent 回复保持原文 md，不转纯文本)
- ✅ `streaming`
- ❌ `reactions`, `read-receipts`, `voice`, `video`（YAGNI，将来按需加）

### 2.6 离线 / 重连

- M↓ host 断 UDS → plugin 把发往 mdeditor channel 的消息标 "pending"；M↓ host 重连 → plugin 用 `session.replay` 回放
- OpenClaw 重启 → UDS sock 消失 → M↓ host 每 5 秒重连，封顶 60s 指数退避

## Section 3 — Cloudflare Worker `mdrelay`

### 3.1 部署位置

新建 `mdrelay/` 目录（与 `mdshare/` 同级，**不复用** mdshare）：独立 wrangler、独立域名、独立 Durable Object namespace。

### 3.2 结构

```
mdrelay/
├── wrangler.toml
├── package.json
└── src/
    ├── index.ts              # 路由
    ├── pair.ts               # /pair/create, /pair/claim
    ├── relay-do.ts           # Durable Object: 一对 pairing 的 WS 集线器
    └── auth.ts               # device token (HMAC) 签发 / 校验
```

### 3.3 加密

只 WSS。Cloudflare 看得到明文 chat 内容；接受此风险作为简化代价（参见"非目标"）。

### 3.4 公开 API

```
POST   /pair/create        host 拿 pairing code (6 段 hex, 2 分钟过期) + DO id
POST   /pair/claim         remote 用 code 换 device_token + DO endpoint
GET    /ws/host?token=…    host 长连
GET    /ws/remote?token=…  remote 长连
POST   /device/revoke      host 撤销 device_token (HMAC 签名校验调用者)
GET    /health
```

WS 帧（worker 直接看到的）：

```jsonc
{
  "to": "host" | "remote:<device_id>" | "broadcast",
  "from": "host" | "remote:<device_id>",
  ... Section 2.3 的字段 ...
}
```

Worker / DO 只做 envelope 路由；不缓存内容（除非离线暂存，参见 3.5）。

### 3.5 Durable Object 模型

一个 pairing（host + N remote）对应一个 DO 实例：

- 内部维护 1 个 host WebSocket + N 个 remote WebSocket
- Host 离线时，发往 host 的 envelopes 暂存（上限：累计 1MB / 50 条 / 24 小时；超限丢弃最早）
- Remote 离线时，发往该 remote 的 envelopes 暂存（同上限）
- Worker 重启不丢：上限内的 pending envelopes 存 DO transactional storage

### 3.6 Pairing 流程

1. Host 端：M↓ chat 窗口 → settings → Devices → "Add device" → `POST /pair/create` → 拿 6 段 hex code + DO id；UI 同时显示 code 文本和 QR
2. Remote 端：M↓ 首次启动且无 device_token → onboarding → 扫码或手输 code → `POST /pair/claim` → 拿 device_token（HMAC 签名的不透明字符串，含 pairing_id + device_id + role）
3. Host 收到 worker push "新 device claim 完成"（device_id, hostname, IP）→ 主动弹模态："**New device wants to connect** — `bruce-laptop` (192.0.2.7) at 14:32. [Allow] [Reject]"
4. Allow → device_token 升级为持久；Reject → 立即 `/device/revoke`
5. Pairing code 单次兑换、2 分钟过期；过期后只能 host 重新生成

### 3.7 失败行为

| 情况 | 行为 |
|---|---|
| Host 进程退出 | mdrelay 标 host offline，缓冲发往 host 的 envelopes；host 重启后回放 |
| OpenClaw 退出 | M↓ host UDS 重连循环，对 mdrelay 仍保持 WSS；remote 看到 "OpenClaw offline" |
| Host 机器关机 | mdrelay 缓冲 24h；host 上电后回放 |
| Worker / DO 故障 | 两端报错重试 (30s 起跳)；host-local 用户不受影响 |
| 网络中断 | 双方重连；DO 是最终一致的 |
| Pairing code 过期 / 输错 | 报错，让 host 重生成；无尝试次数限制（worker rate-limit 兜底） |

## Section 4 — Vault 联动

### 4.1 两种 client 模式

| 模式 | 触发 | md 在哪 |
|---|---|---|
| **Bound** | M↓ 配置了本地 vault + vaultgitsync (跟 host 同一个 git remote) | 每台机器本地副本 |
| **Web** | M↓ 没配本地 vault | 只在 host 服务器 vault |

模式由 `settings.openclaw.localVault.enabled` 决定 (default: host 模式自动开；remote 默认关，用户主动配)。

### 4.2 相对路径基准

agent 回复里的 `[note](./notes/2026/foo.md)` —— **始终相对 vault root** (git repo 根目录)。

- 绝对路径、`http(s)://`、`mdeditor://` 等带 scheme 的 URL：按字面，不做 vault 解析
- 未来可选支持 `{{vault}}/...` 显式语法；MVP 不实现

### 4.3 Bound 模式：打开 md

```
点击 [note](./notes/2026/foo.md)
  → 解析: $vault_root + "./notes/2026/foo.md"
  → 检查本地文件
     ├── 存在: 唤起编辑器主窗口（若未开则启动）→ 在其中开 tab → 完成
     └── 不存在: 提示 [Sync now & retry] [Open empty] [Cancel]
                 ├── Sync: 调用 vault_sync_now → 重新检查
                 └── 仍不存在: chat inline 报 "host 也没有此文件"
```

Settings: `openclaw.autoSyncBeforeResolve` (默认 ON) → 点 link 时先自动 sync 一次。

"唤起编辑器主窗口"行为：若主窗口存在但 hidden / minimized → show + focus；若主窗口未启动（仅 chat 窗口在跑）→ 启动主窗口。这套行为通过新增 Tauri command `editor_show_and_open_path(path)` 提供。

### 4.4 Web 模式：打开 md

```
点击 [note](./notes/2026/foo.md)
  → channel: {"type":"user.request_file","path":"./notes/2026/foo.md"}
  → host plugin 读 host vault → 回 {"type":"agent.file_content", ...}
  → M↓ 唤起编辑器主窗口（若未开则启动）→ 在其中开一个 untitled tab，预填内容，标题 "[remote] foo.md"
  → tab 默认 read-only
     ├── Save As local: 保存到本机
     └── Push back to host: channel: {"type":"user.push_file", ...}
        → host 写 vault → vaultgitsync 自动同步到 git remote
```

### 4.5 附件上传（Web 模式）

拖拽 / 按钮上传 → base64 → `user.attach.upload` → host 写到 `<vault>/inbox/attachments/<date>/<filename>` → channel plugin 把附件挂到当前 OpenClaw session，让 agent 可读。

单文件 5MB；超过走切片分帧。

### 4.6 mdblock 引用

`((path/to/file.md#b-xxxxxx))` 引用 → 同样按 4.2 规则解析路径 → 唤起编辑器主窗口 → 开 tab 并定位到 block id（复用现有 `Cmd+Enter on citation in source mode` 的目标定位机制）。

### 4.7 vaultgitsync 重用

不重写同步逻辑；调用现有 Tauri command `vault_sync_now`（声明于 `src-tauri/src/vault_sync/mod.rs`）。状态查询 / 启停同样复用 `vault_sync_status` / `vault_sync_start` / `vault_sync_stop`。

## Section 5 — Pairing / 设备管理 / 历史

### 5.1 Devices Settings 页

Settings → "OpenClaw" → Devices:

```
Devices
─────────────────────────────────────
○ host-local                this machine (OpenClaw direct)
● bruce-laptop              Last seen 2 min ago        [Revoke]
● bruce-phone               Last seen 3 days ago       [Revoke]
○ work-imac (revoked)                                  [Forget]

[ + Add device ]
```

- device 名: remote 首次连接时上报 (OS hostname，可在 settings 改)
- Revoke: `POST /device/revoke` → 立即踢下线
- Forget: 从本地列表删除 (revoked 才显示)

### 5.2 历史存储

| 层 | 内容 | 寿命 |
|---|---|---|
| OpenClaw session storage (server) | 完整 session 历史 | 持久 (跟 OpenClaw 配置) |
| Host M↓ | 不缓存 (直走 UDS) | n/a |
| Remote M↓ (SQLite) | 最近 N session × 最近 M 消息 | 本地缓存；上线后 `session.replay` 拉差 |
| Worker DO | 仅离线期间未送达 envelopes | ≤ 24h，上限 1MB / 50 条 |

缓存文件: `~/Library/Application Support/com.laobu.mdeditor/openclaw-cache.db`

### 5.3 多设备 session 语义

**单 account / 共享 session pool**。所有 device 看同一组 sessions；任一 device 发的消息 broadcast 到所有 subscribed device。语义近似 iMessage / Telegram 多端。

### 5.4 离线汇总

参见 3.7。补充：

- Remote 上线 → 先显示本地 SQLite 缓存 → 后台拉 `session.list` + 各 session 的 `session.replay` → 覆盖缓存
- Host 重启 (M↓ 进程) → UDS 重连 → 已打开的 chat 窗口透明续连，不丢失光标 / 输入框状态

## 协议版本

UDS 与 WSS 帧均带 `"v": 1`。新增字段一律 optional。Breaking change → `"v": 2`，旧 path 保留 1 个 release 周期；不兼容时 chat UI 报 "Host plugin version mismatch, please update"。

## 验收标准

- [ ] 在装有 OpenClaw 的 host 机器上启动 M↓，chat 窗口能跟 OpenClaw agent 完整对话（含 streaming）
- [ ] OpenClaw `lsof -p $PID` 不显示任何 listen 端口；只有 UDS
- [ ] 在 remote 机器输入 host 给的 pairing code 后能在 chat 里继续同一 OpenClaw 实例的对话
- [ ] Host 端 Allow 模态出现，Reject 后 remote 不能继续；Revoke 后 remote 立刻断
- [ ] 同一 session 在 host 本机和 remote 同时打开时，任一端发的消息双方都看到
- [ ] Bound 模式: chat 里点相对路径 md 链接 → 编辑器主窗口正确开 tab；本地缺失能触发 sync
- [ ] Web 模式: chat 里点相对路径 md 链接 → 主窗口开 [remote] untitled tab，内容来自 host vault
- [ ] Chat 窗口关闭不影响编辑器主窗口；反之亦然
- [ ] Host 进程 kill 后 remote 看到 offline；host 重启后自动续上
- [ ] Worker 限流 / DO 缓冲上限按 1MB / 50 条 / 24h 工作
- [ ] OpenClaw 重启 / M↓ 重启都能自动重连，已发消息不丢

## 开放问题（实现阶段再决）

1. UDS 的 access token 旋转触发条件 (周期? 手动? OpenClaw 重启时?)
2. Pairing code 的字符集 / 段数 / 长度选定 (现写 "6 段 hex"，待定具体格式)
3. SQLite 缓存的具体 schema 与上限策略 (按 session 还是按消息总数 LRU)
4. Chat 窗口的具体 Svelte 组件树（消息渲染、附件上传 UI、tool_call 展示）
5. Remote 的 hostname 上报是否允许用户在 onboarding 改名（防 OS hostname 含个人信息）
6. mdrelay 的 Cloudflare 账户 / 域名归属（用 mdshare 同账号还是分账）

## 相关文档

- 现有插件系统设计: `docs/superpowers/specs/2026-05-08-plugin-system-design.md`
- vaultgitsync 集成设计: `docs/superpowers/specs/2026-05-12-vaultgitsync-integration-design.md`
- mdshare worker (作为 mdrelay 的参考): `mdshare/`
- OpenClaw channel plugin 文档: `<openclaw>/docs/plugins/manifest.md`, `<openclaw>/docs/cli/channels.md`, `<openclaw>/docs/web/webchat.md`
- OpenClaw mac IPC 参考 (UDS 安全模式): `<openclaw>/docs/platforms/mac/xpc.md`
