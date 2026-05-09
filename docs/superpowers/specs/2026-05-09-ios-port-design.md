# iOS Port —— 设计稿

> 把现有 macOS Tauri 应用扩展为 Universal（iPhone / iPad / macOS）三端共享一份代码的 Tauri 工程，iOS 18+ 与 macOS 11+ 同代码树同 release。

## §1 —— 整体策略 & 代码复用模型

**一句话目标**：把现在这个 macOS Tauri 应用扩展成 Universal（iPhone / iPad / macOS）三端共享一份代码的 Tauri 工程，iOS 18+ 与 macOS 11+ 同代码树同 release。

**复用层级**（从高到低）：

| 层 | 复用率 | 说明 |
|---|---|---|
| `src/styles/` 全部（含 skins） | 100% | 纯 CSS，零改动 |
| `src/lib/*.ts`（tabs / settings / fs / autosave / hash / commands / dialogs / external-state / file-watcher / toast / skin / code-fence / cursor-preserve） | ~95% | 仅 `fs.ts` 和 `file-watcher.svelte.ts` 在路径处理上加 platform 分支 |
| `src/lib/plugins/share-baker.ts` + `host-render-html.ts` | 100% | 烘焙逻辑本来就在 TS |
| `src/components/*.svelte`（除 TabBar） | 100%，靠 CSS `@media` 适配 | RichEditor / EditorPane / SourceView / HtmlPreview / SettingsDialog / Toast / EmptyState / ExternalChangeBanner / ModeToggle 全部不动 |
| `src/components/TabBar.svelte` | 窄屏分支重写 | iPhone 用抽屉 |
| `src-tauri/src/lib.rs` | 菜单 / 托盘 / LSSetDefault 走 cfg 屏蔽 | Rust 端按 `target_os` 分支 |
| 新增 `src/lib/share/`（TS 重写 mdshare 的 publish / unpublish / copy-link / image-upload） | 新代码，约 200 行 | 替换原 Rust 二进制；macOS 后续也可切到这里 |

**砍掉的东西**（前端 + Rust 都对应屏蔽）：插件宿主（subprocess）、md2pdf、tray icon、菜单栏（File/Edit/View/Window/Help）、`set_default_app_for_extensions`、`single-instance` 插件、设置面板的 "Plugins" 标签。

**形态映射**：
- **macOS**：行为完全不变（这是关键，不能因为加 iOS 就让现有 Mac 用户体验回退）。
- **iPad（with/without 外接键盘）**：UI 结构 ≈ macOS 简化版，标签栏、键盘快捷键、外部修改 banner 都在；菜单栏没了，对应命令挪到工具栏 + 长按；外接键盘时 `Cmd+O/S/W//` 经 `UIKeyCommand` 复活。
- **iPhone**：单文档全屏 + 顶部 hamburger 抽屉，抽屉里是"最近文件 + 打开 + 设置"。多文档数据结构（`tabs.svelte.ts`）保留，UI 只渲染当前活动 tab。

### 1.1 框架技术栈

Tauri 2 iOS = "Rust 核心 + Swift 壳 + WKWebView 渲染"。

| 层 | 具体技术 | 谁来写 |
|---|---|---|
| UI 渲染 | WKWebView（Svelte 5 / Vite 产物在里头跑） | 不写新代码，沿用现有前端 |
| iOS App 壳 | Swift + UIKit（Tauri 在 `src-tauri/gen/apple/` 自动生成 Xcode 工程、`AppDelegate`、`SceneDelegate`、`UIViewController`） | Tauri 模板生成 |
| Rust 核心 | 当前 `src-tauri/src/*.rs` 编译为 iOS 静态库，链进 Swift 壳 | 改少量 `cfg!(target_os = "ios")` 分支即可 |
| 文件选择 / 对话框 / 剪贴板 / 深链 / 文件读写 | Tauri 官方 plugin（`fs` / `dialog` / `clipboard-manager` / `deep-link` / `opener` / `store`），底层封装 `UIDocumentPickerViewController`、`UIPasteboard`、`UIApplicationDelegate.openURL`、UserDefaults | 不用碰 Swift |
| 文档类型注册 | `Info.plist` 的 `CFBundleDocumentTypes` + `UTImportedTypeDeclarations`，配合 `LSSupportsOpeningDocumentsInPlace = YES` | 在 `tauri.ios.conf.json` 的 iOS 段配，Tauri 写 plist |
| iOS 分享（外链复制后调用系统分享面板） | `UIActivityViewController` | 少量 Swift（一个自定义 Tauri 命令，~30 行） |
| iPad 外接键盘快捷键 | `UIKeyCommand`，挂在根 `UIViewController` | 少量 Swift（一个 Tauri 自定义命令注册一组 keycommand → emit JS event） |

**整个 UI 都是 Svelte，不引入 SwiftUI**。Swift 代码总共大概 50–80 行。

---

## §2 —— 仓库与构建结构

**核心原则**：单仓 / 单 workspace / 单一 `tauri.conf.json` 主配置 + 平台覆盖文件，三端共享一份 release。不分 fork、不开新分支永久托管 iOS。

### 2.1 目录变化

```
mdeditor/
├── src/                         # 前端（Svelte），三端共用
│   ├── lib/
│   │   ├── platform.ts          # 新增：platform() / isIOS / isMacOS / formFactor
│   │   ├── share/               # 新增：TS-native mdshare 替代
│   │   │   ├── publish.ts
│   │   │   ├── unpublish.ts
│   │   │   ├── copy-link.ts
│   │   │   ├── upload-image.ts
│   │   │   ├── slug.ts
│   │   │   ├── records.ts       # 读写 settings 里 share.records
│   │   │   └── client.ts        # fetch 封装、API Key 注入、错误归一
│   │   ├── ios/                 # 新增：iOS 专属轻量适配
│   │   │   ├── share-sheet.ts   # invoke('present_share_sheet')
│   │   │   ├── keycommand.ts    # invoke('register_key_commands') + 事件桥
│   │   │   └── document-picker.ts
│   │   ├── plugins/             # 保留，但 iOS 编译时 pluginRuntime.manifests = []
│   │   └── …(其余文件不动)
│   ├── components/
│   │   ├── TabBar.svelte        # 加窄屏分支：iPhone 抽屉
│   │   ├── DrawerNav.svelte     # 新增：iPhone 抽屉组件
│   │   ├── MobileToolbar.svelte # 新增：iPhone/iPad 顶部工具栏（取代菜单栏）
│   │   ├── SettingsDialog.svelte # 在 iOS 上隐藏 Plugins 和 Default App 两个 tab
│   │   └── …(其余不动)
│   └── styles/
│       ├── responsive.css       # 新增：@media 断点（iPad / iPhone）
│       └── …(skin / base 不动)
│
├── src-tauri/
│   ├── tauri.conf.json          # 维持现状（macOS 专属字段保留）
│   ├── tauri.ios.conf.json      # 新增：iOS 覆盖（CFBundleDocumentTypes、最小版本、图标）
│   ├── Info.plist               # macOS 专属，不变
│   ├── src/
│   │   ├── lib.rs               # 加 cfg(target_os) 分支：iOS 不建菜单、不建托盘、不注册 LSSetDefault
│   │   ├── plugin_host.rs       # iOS 编译时整体 cfg(not(target_os = "ios")) 屏蔽
│   │   └── ios.rs               # 新增：present_share_sheet、register_key_commands 命令
│   ├── plugins/                 # share/ 和 md2pdf/ 二进制目录在 iOS 包不打入（resources 配置）
│   ├── gen/
│   │   └── apple/               # 新增：Tauri 生成的 Xcode 工程（iOS 构建产物）
│   └── Cargo.toml               # tauri-plugin-* 的 iOS 兼容版本
│
├── docs/superpowers/
│   ├── specs/2026-05-09-ios-port-design.md   # 这个文档
│   └── plans/2026-05-09-ios-port.md          # 下一步出
│
└── package.json
    └── scripts:
        - tauri ios dev          # 真机/模拟器
        - tauri ios build        # 出 IPA
        - tauri ios init         # 一次性生成 gen/apple/
```

### 2.2 构建命令

```bash
# 一次性初始化
pnpm tauri ios init

# 开发（连真机或 simulator）
pnpm tauri ios dev

# 出 release IPA（需 Apple Developer 账号 + 签名证书 + provisioning profile）
pnpm tauri ios build
```

`tauri.ios.conf.json` 关键字段示意：

```json
{
  "bundle": {
    "iOS": {
      "minimumSystemVersion": "18.0",
      "fileAssociations": [
        { "ext": ["md", "markdown", "mdown", "mkd"], "name": "Markdown", "role": "Editor" },
        { "ext": ["html", "htm"], "name": "HTML", "role": "Editor" }
      ]
    }
  }
}
```

外加在 Tauri 生成的 `Info.plist`（`gen/apple/`）补：

- `LSSupportsOpeningDocumentsInPlace = YES`（在 Files App 里就地打开磁盘上的文件）
- `UIFileSharingEnabled = YES`（App 自己的 Documents 目录在 Files App 中可见）
- `UIRequiresFullScreen = NO`（支持 iPad Split View）
- `UIBackgroundModes` —— 不加（不申请后台权限，避免审核风险）

### 2.3 CI / 发布

- macOS release 流程不变（沿用 `pnpm tauri build --target universal-apple-darwin`）。
- iOS 暂不接 CI 自动发布（签名 / TestFlight 需要 Apple Developer 账号配置）；v1 先支持本机 `tauri ios build` 出 IPA 手动上传 TestFlight。
- **版本号同步**：iOS 与 macOS 共用 `tauri.conf.json` 的 `version`。

---

## §3 —— 前端架构变化

**总思路**：现有 95% 的 Svelte/TS 代码不动，新增一层 platform 抽象 + 三个窄屏 UI 组件 + 一组 CSS 断点。所有 iOS-only 代码集中在 `src/lib/platform.ts`、`src/lib/ios/`、`src/components/Drawer*.svelte`，搜 `isIOS` 就能找到全部分支。

### 3.1 platform 抽象层（`src/lib/platform.ts`）

```ts
import { platform as tauriPlatform } from '@tauri-apps/plugin-os'

export type Platform = 'macos' | 'ios' | 'unknown'

let cached: Platform | null = null
export async function platform(): Promise<Platform> {
  if (cached) return cached
  const p = await tauriPlatform()  // 'macos' | 'ios' | 'linux' | 'windows' | 'android'
  cached = p === 'macos' || p === 'ios' ? p : 'unknown'
  return cached
}

export const isIOS = async () => (await platform()) === 'ios'
export const isMacOS = async () => (await platform()) === 'macos'

// 同步快照，供顶层模块在 platform() 异步 resolve 后使用
export const platformSnapshot = $state<{ value: Platform }>({ value: 'unknown' })

// 表单分类（iPad 视为"宽屏 iOS"，与桌面共用大部分布局）
export type FormFactor = 'desktop' | 'tablet' | 'phone'
export const formFactor = $state<{ value: FormFactor }>({ value: 'desktop' })

// 在 main.ts 启动时 resolve 一次：
//   formFactor.value = isIOS && innerWidth < 768 ? 'phone' : isIOS ? 'tablet' : 'desktop'
// + 监听 resize（iPad Split View 切换会改变可视宽度）
```

调用点（搜 `platform()` / `isIOS()` 即可定位）：

- `App.svelte`：菜单事件监听在 iOS 上不挂；下拉文件、深链监听照旧。
- `src/lib/fs.ts`：iOS 下走 `tauri-plugin-fs` 的 document-picker 路径，路径形如 `<security-scoped-bookmark>` 而非真实磁盘 path。
- `src/lib/file-watcher.svelte.ts`：iOS 关掉"间隔轮询 stat"的实现，只保留"焦点切回时再 stat"分支（沙箱外文件后台无法监视）。
- `src/lib/plugins/runtime.svelte.ts`：iOS 下 `manifests = []`，永远不调用 `get_plugin_manifests`。

### 3.2 表单适配（CSS 优先，组件最小改动）

新增 `src/styles/responsive.css`：

```css
/* 三个断点：phone < 768 ≤ tablet ≤ 1024 < desktop */
:root { --tabbar-display: flex; }

@media (max-width: 767px) {
  :root { --tabbar-display: none; --toolbar-display: flex; }
}
@media (min-width: 768px) and (max-width: 1024px) {
  :root { --toolbar-display: flex; }  /* iPad 也显示工具栏 */
}

/* iOS 安全区（home indicator / Dynamic Island） */
.app-shell {
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
  padding-left: env(safe-area-inset-left);
  padding-right: env(safe-area-inset-right);
}

/* 触摸目标尺寸（≥ 44pt）*/
@media (pointer: coarse) {
  button, .tab, .menu-item { min-height: 44px; min-width: 44px; }
}

/* 字号在小屏放大一档 */
@media (max-width: 767px) {
  .src textarea, .rich-wrap { font-size: 17px; }
}
```

### 3.3 新增组件

**`MobileToolbar.svelte`**（iPad + iPhone 都用，取代菜单栏）

- 左：☰（仅 iPhone 显示，打开 `DrawerNav`）
- 中：当前文件名 + dirty 点
- 右：Source/Rich 切换 + 三点菜单（保存 / 另存 / 设置 / 分享）
- iPad 上点三点菜单弹 `UIPopoverPresentationController` 风格菜单（CSS 实现，不用原生）

**`DrawerNav.svelte`**（仅 iPhone）

- 从左侧滑入，宽度 `min(85vw, 320px)`
- 内容：
  1. 📂 Open File（调用 `cmdOpen()` → document picker）
  2. Recent 列表（来自 `settings.recent`，最多 10 条）
  3. 分隔线
  4. ⚙️ Settings
- 切换 tab 时若旧 tab 脏 → 复用现有 `confirmDirtyClose`

**`TabBar.svelte`** 改造

- 加 `if formFactor.value === 'phone'` 直接 `return null`（不渲染）
- 桌面 + iPad 行为不变
- iPad 上点 tab 标题长按 → 弹"Close / Close Others / Share This Tab"（替代右键菜单）

### 3.4 命令派发（取代菜单事件）

现状：菜单事件经 Rust → `emit('menu-event', id)` → `App.svelte` 监听派发。

iOS 上没菜单，但**保留同一份命令注册表**：

```ts
// src/lib/commands.ts —— 已存在，扩展为命令对象
export const commands = {
  open: cmdOpen,
  save: cmdSave,
  'save-as': cmdSaveAs,
  'close-tab': cmdCloseActive,
  'toggle-mode': cmdToggleMode,
  'preferences': () => openSettings(),  // 把现 App.svelte 里的 `showSettings` $state 提到模块级，导出 openSettings/closeSettings 两个函数
  'share': () => sharePublishCurrent(),       // 新增
  'unshare': () => shareUnpublishCurrent(),   // 新增
  'copy-share-link': () => shareCopyLink(),   // 新增
} as const

export function dispatch(id: keyof typeof commands) {
  commands[id]?.()
}
```

**路由**：

- macOS：菜单事件 → `dispatch(id)`，行为与当前一致
- iOS：`MobileToolbar` 按钮、`DrawerNav` 项、`UIKeyCommand`（iPad 键盘）全部 → `dispatch(id)`

### 3.5 设置面板裁剪

`SettingsDialog.svelte` 加 `if (!isIOS)` 隐藏：

- "Plugins" tab（iOS 没有插件宿主）
- "Default App for Extensions" 整段（iOS 不允许）

iOS 上保留：Core（皮肤、自动保存、字号）+ Share（baseUrl / apiKey / 默认有效期 / slug 后缀）。

---

## §4 —— Rust + Swift 端改动

### 4.1 Rust 端（`src-tauri/src/lib.rs`）—— 用 cfg 屏蔽

把现在 lib.rs 里的 "菜单 / 托盘 / 默认 App" 全部框进 `#[cfg(not(target_os = "ios"))]`，iOS 编译时整段消失：

```rust
// 1. setup() 内的 build_menu / set_menu / TrayIconBuilder 整体包起来
#[cfg(not(target_os = "ios"))]
{
    let plugin_items = plugin_host::collect_top_menu_items();
    let menu = build_menu(&app.handle(), &plugin_items)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| { /* … */ });

    let _tray = TrayIconBuilder::with_id("main") /* … */ .build(app)?;
}

// 2. set_default_app_for_extensions —— iOS 实现返回错误（已有 #[cfg(not(target_os = "macos"))] 分支可复用）

// 3. plugin_host 模块整体 cfg 屏蔽
#[cfg(not(target_os = "ios"))]
pub mod plugin_host;
#[cfg(target_os = "ios")]
pub mod plugin_host {
    use serde_json::Value;
    #[tauri::command] pub fn get_plugin_manifests() -> Vec<Value> { vec![] }
    #[tauri::command] pub fn get_all_plugin_manifests() -> Vec<Value> { vec![] }
    #[tauri::command] pub async fn invoke_plugin(_id: String, _command: String, _payload: Value) -> Result<Value, String> {
        Err("plugins not supported on iOS".into())
    }
}

// 4. tauri_plugin_single_instance::init 也包 cfg —— 仅桌面注册

// 5. iOS 专属命令模块
#[cfg(target_os = "ios")]
mod ios;
```

`Cargo.toml` 调整：

- `tauri-plugin-single-instance` 的依赖加 `[target.'cfg(not(target_os = "ios"))'.dependencies]`，仅 desktop。
- 其余 plugin（`fs / dialog / clipboard-manager / deep-link / opener / store`）三端通用，不动。

### 4.2 Swift 端

只写两个 Tauri 命令的 iOS 桥。Swift 文件放在 `src-tauri/gen/apple/Sources/Plugins/IOSBridge/IOSBridge.swift`，由 `tauri ios init` 后手动建一次：

```swift
import UIKit
import Tauri
import WebKit

class IOSBridgePlugin: Plugin {
  // 1. 弹系统分享面板（外链 / 文本 / URL / 图片 都支持）
  @objc public func presentShareSheet(_ invoke: Invoke) throws {
    struct Args: Decodable {
      let text: String?
      let url: String?
    }
    let args = try invoke.parseArgs(Args.self)

    var items: [Any] = []
    if let url = args.url, let u = URL(string: url) { items.append(u) }
    if let text = args.text { items.append(text) }
    guard !items.isEmpty else { invoke.reject("nothing to share"); return }

    DispatchQueue.main.async {
      let vc = UIActivityViewController(activityItems: items, applicationActivities: nil)
      // iPad 必填 popoverPresentationController 锚点；这里取 keyWindow 中心
      if let pop = vc.popoverPresentationController,
         let win = UIApplication.shared.connectedScenes
           .compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first {
        pop.sourceView = win
        pop.sourceRect = CGRect(x: win.bounds.midX, y: win.bounds.midY, width: 0, height: 0)
        pop.permittedArrowDirections = []
      }
      UIApplication.shared.connectedScenes
        .compactMap { ($0 as? UIWindowScene)?.windows.first?.rootViewController }
        .first?.present(vc, animated: true)
      invoke.resolve()
    }
  }

  // 2. iPad 外接键盘 UIKeyCommand —— 注册一组绑定，触发时通过事件桥 emit 回 JS
  @objc public func registerKeyCommands(_ invoke: Invoke) throws {
    DispatchQueue.main.async {
      KeyCommandRouter.shared.bind([
        ("o",  .command,           "open"),
        ("s",  .command,           "save"),
        ("s",  [.command, .shift], "save-as"),
        ("w",  .command,           "close-tab"),
        ("/",  .command,           "toggle-mode"),
        (",",  .command,           "preferences"),
        ("l",  [.command, .shift], "share"),
      ])
      invoke.resolve()
    }
  }
}

// KeyCommandRouter —— 单例，把 UIKeyCommand 的 action 转成 emit("menu-event", id)
// ~40 行 Swift，由 AppDelegate 在启动时把 router 挂到根 VC 的 keyCommands 属性。
```

### 4.3 `Info.plist`（在 `src-tauri/gen/apple/` 内手改一次，提交进 git）

新增：

- `LSSupportsOpeningDocumentsInPlace` = `YES`
- `UIFileSharingEnabled` = `YES`
- `UISupportedInterfaceOrientations` = 4 个方向都开（iPad 横竖屏；iPhone 默认竖屏 + 全屏阅读时允许横屏）
- `UIRequiresFullScreen` = `NO`
- `CFBundleDocumentTypes`：与 macOS 一致的扩展名集合（`.md` `.html` `.txt` `.json` 等），`LSHandlerRank` = `Alternate`（不抢注 markdown 默认 App）
- `UTImportedTypeDeclarations`：声明对 `net.daringfireball.markdown` 的支持

Tauri 2 的 `tauri.ios.conf.json.bundle.iOS.fileAssociations` 会生成大部分上述字段，但 `LSSupportsOpeningDocumentsInPlace` 等"平台行为"字段需要手填一次到 `gen/apple/<App>_iOS/Info.plist`，提交进 git。

### 4.4 不做的事（重申）

- 不引入 SwiftUI
- 不写自定义 WKWebView 子类（Tauri 已经管 webview 生命周期）
- 不写后台任务 / push notification / Core Data / KeyChain（`tauri-plugin-store` 已能存 secret）

---

## §5 —— TS-native Share 实现

**目标**：把现在跑在 macOS 上的 Rust `mdshare` 二进制，整体用 TS 重写到 `src/lib/share/`，三端共用。Worker 端协议保持不变（已部署的 Cloudflare Worker 不用动）。

### 5.1 协议梳理

`mdshare` 二进制对外只有 3+1 个能力：

| 命令 | 入参 | Worker 端点 | 出参 |
|---|---|---|---|
| `publish` | `{ html, slug?, expiry?, prevSlug? }` | `POST /publish` | `{ slug, url }` |
| `unpublish` | `{ slug }` | `DELETE /share/:slug` | `{ ok }` |
| `copy-link` | `{ path }` | （本地，读 `share.records`） | `{ url }` |
| `upload-image` | `{ imageBytes, mime, filename }` | `POST /r2-upload` | `{ url }` |

所有调用都带 `Authorization: Bearer <apiKey>`。

### 5.2 模块结构

```
src/lib/share/
├── client.ts        # fetch 封装 + 错误归一（网络错 / 401 / 413 / 5xx）
├── slug.ts          # 文件名 → slug（kebab-case + ASCII fallback + 可选 3 字符随机后缀）
├── records.ts       # 读写 settings["share.records"]：{ [absPath]: { slug, url, lastSharedAt } }
├── publish.ts       # bake → guardSize → upload → 写 records → 复制链接 → toast
├── unpublish.ts     # delete → 删 records → toast
├── copy-link.ts     # 查 records → 复制 → toast
├── upload-image.ts  # 读 image bytes → multipart POST → 复制 URL + present_share_sheet
└── index.ts         # 对外导出 5 个高层入口（sharePublishCurrent / shareUnpublishCurrent / shareCopyLink / shareImageCurrent）
```

### 5.3 高层入口（被 commands.ts 调用）

```ts
// src/lib/share/index.ts
import { activeTab } from '../tabs.svelte'
import { settings } from '../settings.svelte'
import { pushToast } from '../toast.svelte'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { isIOS } from '../platform'
import { invoke } from '@tauri-apps/api/core'
import { bakeShareHtml, guardSize } from '../plugins/share-baker'
import { post } from './client'
import { generateSlug } from './slug'
import { getRecord, putRecord } from './records'

export async function sharePublishCurrent() {
  const tab = activeTab()
  if (!tab || !tab.filePath) return  // 未保存的文件先提示存盘
  try {
    const html = await bakeShareHtml(tab)
    guardSize(html)  // > 25MB 抛错
    const prev = getRecord(tab.filePath)
    const slug = prev?.slug ?? generateSlug(tab.title, settings.share?.slugRandomSuffix ?? true)
    const { url } = await post('/publish', { html, slug, expiry: settings.share?.defaultExpiry ?? 'never' })
    putRecord(tab.filePath, { slug, url, lastSharedAt: Date.now() })
    await writeText(url)
    pushToast({
      level: 'success',
      message: prev ? '✅ 内容已更新（链接已复制）' : '✅ 分享成功（已复制）',
      detail: url,
    })
    if (await isIOS()) {
      // iOS 上额外弹一次系统分享面板，方便发到微信/AirDrop
      await invoke('present_share_sheet', { url, text: tab.title })
    }
  } catch (e) {
    handleShareError(e, '分享')
  }
}

export async function shareUnpublishCurrent() { /* … 对称结构 … */ }
export async function shareCopyLink()         { /* 仅查 records + 复制 */ }
export async function shareImageCurrent()     { /* 调 upload-image */ }
```

### 5.4 错误处理（与 macOS Rust 二进制对齐）

```ts
// src/lib/share/client.ts
async function call(method: 'POST'|'DELETE', path: string, body?: any): Promise<any> {
  const cfg = settings.share
  if (!cfg?.baseUrl || !cfg?.apiKey) throw new ShareError('not_configured')
  const url = cfg.baseUrl.replace(/\/$/, '') + path
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: { 'authorization': `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    })
  } catch { throw new ShareError('network') }
  if (res.status === 401) throw new ShareError('auth')
  if (res.status === 413) throw new ShareError('too_large')
  if (!res.ok) throw new ShareError('server', `HTTP ${res.status}`)
  return res.json()
}
```

错误展示与现有 macOS toast 文案一致：`❌ Share: 网络错误` / `❌ Share: 鉴权失败` / `❌ Share: 文档过大（X MB / 上限 25 MB）` / `❌ Share: 服务端错误`。

### 5.5 Settings schema 兼容

延用现有 `share.baseUrl` / `share.apiKey` / `share.defaultExpiry` / `share.slugRandomSuffix` / `share.records` 五个键。从 macOS 装 share 插件的用户切到 iOS 后，**Worker 和已发布链接完全互通**（同一个用户的 Mac 和 iPhone 用同一个 Worker、同一个 R2，share.records 各自本地维护）。

### 5.6 macOS 是否同步切到 TS 实现

**v1 不切**。原因：macOS 现在的 Rust 二进制工作正常、有插件宿主隔离的稳定性优势，没必要在 iOS port 同时改 macOS 行为，避免一个 PR 改两件事。**留作后续清理任务**：当 iOS 版上线稳定后，再把 macOS 也切到 TS-native，删掉 `mdshare` crate 和插件宿主里 share 这一段（届时 macOS 的 `Cmd+Shift+L` 直接走 `commands.ts.share`）。这件事独立排期。

### 5.7 图片分享流程（iOS）

1. 用户在 Files App 选一张 `.png`（或拍照后从相册分享到 M↓）→ 进 M↓ 的图片预览 tab。
2. 工具栏 → "分享"。
3. `shareImageCurrent()`：`tauri-plugin-fs` 读 bytes → `POST /r2-upload`（multipart）→ 拿到 `https://your-r2.../<slug>.<ext>` URL → 复制 + `present_share_sheet`。
4. 失败：超过 R2 单文件上限 → toast `❌ Share: 图片过大`；其他错与 markdown 分享一致。

---

## §6 —— 功能砍除清单

iOS v1 一次性砍掉的能力，**前端 + Rust 都要确保对应代码不在 iOS 包里**。

| 能力 | 来源代码 | iOS 处理 |
|---|---|---|
| 菜单栏（File / Edit / View / Window / Help） | `src-tauri/src/lib.rs::build_menu` | `#[cfg(not(target_os = "ios"))]` 包裹 `build_menu` 调用与定义 |
| 菜单栏托盘图标（M↓ 系统状态栏图标） | `src-tauri/src/lib.rs::TrayIconBuilder` | 同上 |
| `set_default_app_for_extensions`（LaunchServices） | `src-tauri/src/lib.rs` | 已有 `cfg(not(target_os = "macos"))` 兜底分支，iOS 命中后返回错误；前端 SettingsDialog 隐藏整段 UI |
| `tauri-plugin-single-instance` | `Cargo.toml`, `lib.rs::Builder.plugin(...)` | 依赖加 `[target.'cfg(not(target_os = "ios"))'.dependencies]`；`lib.rs` 的 `.plugin(single_instance::init(...))` 用 cfg 包 |
| 插件宿主（subprocess 协议） | `src-tauri/src/plugin_host.rs`, `src/lib/plugins/host.ts` 等 | Rust：`plugin_host` 模块 iOS 替换成空桩；前端：`pluginRuntime.manifests = []`，`get_plugin_manifests` 永远返回空 |
| `md2pdf` 二进制及 "Export to PDF…" 菜单项 | `src-tauri/plugins/md2pdf/`, `scripts/build-md2pdf.sh`, `tauri.conf.json::resources` | iOS 包不打入 `plugins/md2pdf/`（在 `tauri.ios.conf.json` 的 resources 中排除）；前端 SettingsDialog 的 Plugins tab 整体隐藏 |
| `mdshare` 二进制 | `src-tauri/plugins/share/`, `scripts/build-mdshare.sh` | iOS 包不打入；功能由 §5 的 TS-native share 替代 |
| 设置面板 → "Plugins" tab | `src/components/SettingsDialog.svelte`, `PluginsSettingsTab.svelte` | iOS 下 `if (!isIOS)` 隐藏 |
| 设置面板 → "Default App for Extensions" 段 | `src/components/SettingsDialog.svelte` | 同上 |
| 文件外部修改的"间隔轮询"分支 | `src/lib/file-watcher.svelte.ts` | iOS 下只保留"窗口前台化时 re-stat"分支，关掉间隔 setInterval（iOS 沙箱外的文件后台无法 stat） |
| 自定义关闭流程 / `quit_app` Tauri 命令 | `src-tauri/src/lib.rs::quit_app`, `App.svelte::onCloseRequested` | iOS 上不调 `quit_app`（iOS App 不显式退出）；`onCloseRequested` 监听器仅 desktop 注册 |

**保留但行为差异**（避免 iOS 上的 surprise）：

- **自动保存**：保留 opt-in 设置项；iOS 上写回 security-scoped bookmark 路径。如果 bookmark 失效（用户删了原文件 / 移动了位置），落到现有的"外部删除 banner"流程。
- **拖拽文件**：iPad 支持 `UIDropInteraction`（Tauri webview 默认就转成 webkit drop 事件）；iPhone 上没有 multitasking drop，直接靠 Files App "Open With" 进入。
- **深链 `file://`**：iOS 上 Files App 长按 → "用 M↓ 打开" → 走 `tauri-plugin-deep-link` 的 `onOpenUrl`，路径是 security-scoped URL。

---

## §7 —— 测试与 Smoke Test

### 7.1 单元测试（Vitest，沿用现有 `*.test.ts` 套路）

新增/扩展：

- `src/lib/platform.test.ts` —— `formFactor` 计算、resize 监听
- `src/lib/share/slug.test.ts` —— ASCII fallback、随机后缀稳定性
- `src/lib/share/records.test.ts` —— put/get/delete + settings 持久化往返
- `src/lib/share/client.test.ts` —— 401 / 413 / 5xx / 网络错的归一（mock fetch）
- `src/lib/share/publish.test.ts` —— 首发 vs 更新（带 prev slug）路径

现有测试**不动**（fs / hash / external-state / file-watcher / settings / tabs / toast / cursor-preserve / code-fence / share-baker / host-render-html）。

### 7.2 iOS 真机 / 模拟器 Smoke Test

在 README 的现有 70 项之后新增 iOS 段（编号续上），先列代表性 25 条；其余可按需扩展：

```
71. iPad 模拟器：Files App 选一个 .md → "用 M↓ 打开" → 进入编辑器，顶部工具栏可见。
72. 编辑内容 → 工具栏 Save → 文件就地写回（用 Files App 检查时间戳）。
73. 关闭 App → 重开 → "Recent" 抽屉里看到上一份文件 → 点击 → 直接打开（bookmark 续期成功）。
74. 删除原文件（在 Files App 里）→ 回到 M↓ → 红色"已删除"banner。
75. iPhone 真机：单文档全屏；点 ☰ → 抽屉滑出；选 Settings → 皮肤切到"shuyuan" → 编辑器立即应用。
76. iPhone：连续 Open File 三个不同 .md → `tabs.svelte` store 应当持有 3 个 tab 但 UI 只渲染当前活动 tab；从 ☰ 抽屉的 Recent 切换不同文件时编辑历史保留（用 console 验证 tabs.length === 3）。
77. iPhone：长按 ☰ 上的最近文件项 → 出现"删除最近"。
78. iPad 接外接键盘：Cmd+O 打开 picker；Cmd+S 保存；Cmd+/ 切 source/rich；Cmd+Shift+S 另存。
79. iPad：Cmd+Shift+L → 调 share publish → toast "✅ 分享成功（已复制）" → 同时弹系统分享面板。
80. iOS：分享一个含 Mermaid 的文档 → 在 Safari 里打开链接 → 流程图渲染为 SVG（与 macOS 行为一致）。
81. iOS：分享一个含 KaTeX 的文档 → recipient 页公式渲染正确。
82. iOS：再次编辑后 Cmd+Shift+L（或工具栏分享）→ toast "✅ 内容已更新（链接已复制）"，链接不变。
83. iOS：取消分享 → 链接 410。
84. iOS：在 Files App 选一张 .png → 用 M↓ 打开 → 工具栏分享 → 复制到剪贴板 + 弹系统分享面板，链接在 Safari 打开能显示原图。
85. iOS：网络断开 → 分享 → toast "❌ Share: 网络错误"。
86. iOS：share.apiKey 未配置 → 工具栏分享 → toast 引导去 Settings → Share。
87. iOS：超过 25MB 的 Markdown → 分享 → toast "❌ Share: 文档过大（X MB / 上限 25 MB）"。
88. iOS：从其他 App（邮件附件）"用 M↓ 打开"一个 .md → 进入编辑器；rich 模式渲染 KaTeX。
89. iOS：暗黑模式切换 → 编辑器 + skin（含 effie）正常切换。
90. iOS：旋转 iPad 横竖屏 → 工具栏与编辑器布局重排，无重叠。
91. iPad Split View（M↓ 占一半屏）→ 抽屉 / 工具栏布局收窄但不破。
92. iOS：开启"自动保存"→ 编辑 1s 后文件就地写回（Files App 时间戳）。
93. iOS：源码模式编辑一个 .py → rich 模式正确显示语法高亮（dockerfile / py / ts 三种代表）。
94. iOS：HTML 文件默认 rich 模式 → 沙箱 iframe 预览正常。
95. iOS：插件相关的 UI（设置里的 Plugins tab、Export to PDF 菜单、Default App 段）**完全不可见**。
```

### 7.3 macOS 回归 Smoke Test

iOS 改动后，**现有 70 条 macOS smoke test 全部跑一遍**，重点验证：

- 27、28、44–48、49–57、66、67：插件宿主、share、md2pdf 在 macOS 上仍然行为一致（被 cfg 屏蔽不能误伤桌面）。
- 1–9、21、22：菜单栏 / Cmd 快捷键 / 关窗逻辑保持不变。
- 68–70：皮肤系统（共享 CSS）不被 iOS 改动污染。

---

## §8 —— 已知风险 & 未决项

### 8.1 风险

| 风险 | 缓解 |
|---|---|
| Tauri 2 iOS 在 `tauri-plugin-fs` 的 security-scoped bookmark 续期上偶有 issue | 提前用 fixture 测试"杀进程后重开" + "重启设备后重开"两个场景；若 plugin-fs 行为不稳，在 `src/lib/fs.ts` 的 iOS 分支里手写一层 bookmark cache |
| iOS App Store 审核对"自有 Worker 服务"的隐私描述要求 | 设置面板的 Share 段加一行 link 到 Worker 隐私政策页（你部署的 Worker 同站可加 `/privacy` 页面）；App 内不收集分析数据，避免审核问题 |
| iPad Split View 下 webview 重排可能闪烁 | 现有 `RichEditor.svelte` 的渲染层用了 `requestAnimationFrame` 节流，理论上够；先验证再决定要不要加防抖 |
| Tauri 生成的 Xcode 工程在升级 Tauri 版本时可能 diff 巨大 | 把 `gen/apple/` 提交进 git，但**只手改少数 plist 字段**；其余文件让 `tauri ios init` 重新生成，diff 时人工 review |
| iOS 的"用 M↓ 打开"在大文件（> 50MB）上可能 OOM | 沿用现有 `fs.ts` 的"6MB 大文件确认对话框"逻辑，移动端把阈值降到 4MB |

### 8.2 未决项（不在本 spec 范围，留作后续）

1. **macOS 的 share / mdshare 二进制是否切到 TS-native**：v1 后单独排期，删 `mdshare` crate。
2. **Worker 的 MCP endpoint** 在 iOS 上是否暴露：v1 无关联（MCP 是给 LLM agent 用的，iOS 内不调）。
3. **iCloud Documents 容器**（让用户的 M↓ 文档自动跨设备同步）：v1 不做，靠 Files App 的 iCloud Drive 间接支持已经够用。后续可加 `NSUbiquitousContainerIdentifiers`。
4. **iOS Share Extension**（让任何 App 的"分享"目标里出现 M↓，把文本/Markdown 推进来）：v1 不做，先靠 Files App "Open With"。后续单独 PR。
5. **App Store 上架的图标 / 截图 / 描述文案**：超出本 spec，发版前单独准备。
6. **iPhone 上的"多窗口"模拟**：暂以"单文档 + 抽屉切换"承担，不模拟桌面多 tab。

### 8.3 验收标准（DoD）

- [ ] `pnpm tauri ios dev` 在 iPhone 17 Pro 模拟器和 iPad Pro 13" 模拟器都能跑起来
- [ ] `pnpm tauri ios build` 出可签名 IPA
- [ ] §7.2 的 25 条 iOS smoke 全过
- [ ] §7.3 的现有 70 条 macOS smoke 回归全过
- [ ] §7.1 的所有单元测试 + 既有测试 `pnpm test` 全绿
- [ ] iOS 包内无 `mdshare` / `md2pdf` 二进制（用 `unzip -l app.ipa | grep -E '(mdshare|md2pdf)'` 验证）
- [ ] iOS 包大小 < 30MB（webview 内容 + Rust 静态库）
