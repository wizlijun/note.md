# md2pdf 插件 — 设计

**Status**: Brainstorm complete; pending implementation plan
**Date**: 2026-05-08
**Owner**: bruce@hemory.com
**Driving use case**: 把现有内置的 "Export to PDF" 功能整体迁出主程序，按
现有插件机制重新落地，让"不导出 PDF 的用户"完全不为这部分功能付出资源。

## Goal

将当前作为 Tauri 内置命令的 PDF 导出（`src-tauri/src/pdf.rs` + 前端
`src/lib/pdf-export.ts` + 静态 `Cmd+Shift+E` 菜单）整体重构为符合
现有插件契约（`docs/superpowers/specs/2026-05-08-plugin-system-design.md`）
的独立插件 **md2pdf**。形态与已有的 `mdshare` 插件完全对齐：

- 独立 Cargo crate（`md2pdf/`）
- 由 release 脚本编译并以 Developer ID 签名
- 打包进 M↓ 的 `.app` 资源目录（`<Resources>/plugins/md2pdf/`）
- 一次性子进程：stdin JSON 进、stdout JSON 出、跑完即退

同时为插件机制做两处必要扩展，并新增最小的"插件管理" Preferences UI：

1. manifest 的 `menus[]` 项支持 `prompt: { kind: "save-dialog", … }`，由
   host 在调用插件之前弹保存对话框，路径作为 `context.output_path` 传给
   插件。
2. `enabled_when` mini-expression 增加 `==` / `!=` 比较运算符，使
   "PDF 仅支持 markdown/html tab" 这类规则能完全在 manifest 中表达。
3. settings.json 新增 `plugins.enabled.<id>: bool`；Preferences 新增
   "Plugins" tab，用户可以勾选启用/禁用，重启生效。

## Driving principle: 真正的减负

用户的核心目标是：**不使用 PDF 导出功能时，主程序应当不为这部分代码
付出任何运行成本**。这条原则贯穿所有取舍：

- Rust 端：`pdf.rs` 整段移除；`objc2-pdf-kit` / `objc2-web-kit` 从
  `src-tauri/Cargo.toml` 删除。主程序二进制不再链接 PDFKit/WebKit FFI
  bindings 的代码段；不触发 PDF 导出时，md2pdf 子进程根本不存在
  → 0 内存、0 CPU。
- 前端端：纯 PDF wrapping 资源（`pdf.css`、`wrapInPrintTemplate`
  对应的 HTML 模板）搬到 md2pdf CLI 内部 —— 主 bundle 不再含
  这些字节。通用渲染管线（marked 实例、KaTeX、hljs、diagrams、
  image-inline、`hasMathContent`、`extractH1FromMarkdown`、
  `buildPdfTitle`、`htmlEscape`）抽到共享模块
  `src/lib/plugins/host-render-html.ts`，share 与 md2pdf 共用
  同一份；`src/lib/pdf-export.ts` 整文件删除。原 PDF 端有自己的
  `printMarked` 实例 —— 删除，统一走 host-render-html 内部的
  单一 marked 实例。
- 启动期 V8 解析开销（即使 md2pdf 被禁用，主 bundle 里仍有
  `host-render-html.ts`）暂不优化 —— 等真有 profiling 数据再说。

## Non-goals (v1)

- ❌ 用户级第三方插件目录（如 `~/Library/Application Support/com.bruce.mdeditor/plugins/`）
  —— 沿用既有约定：所有插件随 `.app` 一起 ship。
- ❌ 启用/禁用状态实时生效。改动需要重启 M↓ 才生效；动态加/删
  Tauri 菜单的复杂度不在 v1 范围。
- ❌ "在 Finder 中显示"导出后的 PDF / 自动打开 PDF。现有 toast 已
  足够；新增 capability 是另一份 spec 的事。
- ❌ 插件版本兼容性矩阵 / 自动升级。
- ❌ Windows / Linux 支持。md2pdf 本来就 macOS-only（沿用主程序定位）。

## Architecture

### 文件布局

#### 新增文件

```
md2pdf/                                       # 新 crate（与 mdshare/ 平级）
  Cargo.toml                                  # 重依赖（objc2-pdf-kit / objc2-web-kit）落在此处
  src/
    main.rs                                   # one-shot：read stdin → render PDF → write stdout
    ipc.rs                                    # Request / Response / Action 类型
    pdf.rs                                    # 现有 src-tauri/src/pdf.rs 的核心搬过来
                                              # （NSApplication + WKWebView + PDFKit 流水线）
    template.rs                               # 拼 self-contained HTML：<!doctype><style>{pdf.css}</style>{body}
                                              # title 由 host 通过 context.tab.title 传过来，
                                              # CLI 不再单独算 H1 / basename
  assets/
    pdf.css                                   # 从 src/styles/pdf.css 搬过来；include_str! 嵌入
  tests/
    smoke.rs                                  # 喂一段 HTML → 断言生成的 PDF 文件 ≥ 1KB

scripts/build-md2pdf.sh                       # 镜像 build-mdshare.sh：rustup target × 2 +
                                              # cargo build × 2 + strip + Developer ID 签名

src-tauri/plugins/md2pdf/                     # bundle 后的插件资源（git-tracked，release 脚本更新）
  manifest.json
  bin-aarch64-apple-darwin                    # 由 build-md2pdf.sh 产出
  bin-x86_64-apple-darwin

src/lib/plugins/
  host-render-html.ts                         # 新增：marked + KaTeX + hljs + diagram-render +
                                              # image inline（共享给 share 与 md2pdf）
  host-render-html.test.ts                    # vitest 单元
  prompt.ts                                   # save-dialog prompt 求值（filename 模板）
  prompt.test.ts
```

#### 修改文件

```
src-tauri/src/
  pdf.rs                                      # 删除
  lib.rs                                      # 删 mod pdf；删 invoke_handler 里 export_pdf；
                                              # 删 Cmd+Shift+E 静态菜单项
  plugin_host.rs                              # 加 PromptSpec、output_path 字段；
                                              # init 时按 plugins.enabled.<id> 过滤；
                                              # 新增 get_all_plugin_manifests 命令

src-tauri/Cargo.toml                          # 删 objc2-pdf-kit / objc2-web-kit
                                              #（搬到 md2pdf/Cargo.toml）

src-tauri/tauri.conf.json                     # 不变（bundle.resources: "plugins/**/*" 已覆盖）

src/lib/
  pdf-export.ts                               # 删除整文件
  pdf-export.test.ts                          # 删除整文件
  commands.ts                                 # 删 cmdExportPdf 函数及其 import
  plugins/
    types.ts                                  # 加 PromptSpec、扩展 Context.output_path
    registry.ts                               # 解析 prompt 块；按 plugins.enabled 过滤
    menu-registry.ts                          # dispatch 前若有 prompt 则先弹 save dialog
    host.ts                                   # 调 host-render-html.ts 处理 renderer.html
                                              # capability；context 多带 output_path
    enabled-when.ts                           # grammar 增 == / != 比较；evaluation 处理之
    enabled-when.test.ts                      # 增 case
    share-baker.ts                            # 改用 host-render-html.ts；移除自带 marked 实例
                                              # 与 image inline 逻辑

src/components/
  SettingsDialog.svelte                       # tab strip 最左加 "Plugins" tab
  PluginsSettingsTab.svelte                   # 新增子组件（manifest 列表 + checkbox）

src/styles/
  pdf.css                                     # 删除（搬到 md2pdf/assets/pdf.css）

src/lib/settings.svelte.ts                    # 加 plugins.enabled.<id> 的读写 helper

scripts/release.sh                            # 新增 pnpm build:md2pdf；
                                              # git add 列表加 src-tauri/plugins/md2pdf/bin-*

package.json                                  # 加 "build:md2pdf": "bash scripts/build-md2pdf.sh"
```

### 进程模型

完全沿用现有 plugin system spec 的 one-shot 子进程模型：

- 一次菜单点击 = 一次 `Command::spawn`
- stdin 写一行 JSON 请求 → stdout 读一行 JSON 响应 → 等待 exit
- timeout 60 秒（manifest 中可配；md2pdf 给比 share（30s）更宽的 60s，
  因为 mermaid 多图 + 大文档可能更慢）
- 不缓存、不预热、不长驻

### IPC 协议扩展

#### Request（host → plugin，stdin，单行 UTF-8 JSON）

新增 `context.output_path` 字段（仅当对应菜单项 manifest 声明
`prompt.kind == "save-dialog"` 时存在）：

```jsonc
{
  "command": "export",
  "context": {
    "tab": {
      "path": "/Users/bruce/notes/foo.md",
      "filename": "foo.md",
      "extension": "md",
      "kind": "markdown",                     // 新增：tab.kind 对外暴露给插件 / enabled_when
      "is_dirty": false,
      "is_untitled": false,
      "title": "Foo"                          // 新增：host 计算好的标题（H1 优先，basename 兜底）
    },
    "rendered_html": "<h1>Foo</h1><p>…</p>",  // inline 化的 body（图片已转 data:URL）
    "output_path": "/Users/bruce/Desktop/foo.pdf"  // 新增；用户在 save dialog 里选的路径
  },
  // settings 字段不存在 —— md2pdf manifest 未声明 settings.read，
  // 沿用现有 spec 的"按需注入"规则
  "host_version": "0.4.0",
  "plugin_api_version": 1
}
```

`plugin_api_version` 仍为 1；`output_path` 字段对未声明 prompt 的插件不出现，
向后兼容。`tab.kind` 与 `tab.title` 是新增字段，对老插件 ignore 即可。

#### Response（plugin → stdout）

无协议改动。md2pdf 只发 `toast` action：

```json
{
  "success": true,
  "actions": [
    { "type": "toast", "level": "success",
      "message": "✅ 已导出到 /Users/bruce/Desktop/foo.pdf" }
  ]
}
```

失败时：

```json
{
  "success": false,
  "actions": [
    { "type": "toast", "level": "error",
      "message": "❌ md2pdf: 写入失败",
      "detail": "Permission denied (os error 13)" }
  ]
}
```

### Manifest（md2pdf 完整草稿）

```jsonc
{
  "id": "md2pdf",
  "name": "Export to PDF",
  "version": "0.1.0",
  "description": "Export the current Markdown or HTML tab to a typographically-clean A4 PDF",

  "binary": "bin",

  "menus": [
    {
      "location": "file",
      "label": "Export to PDF…",
      "shortcut": "Cmd+Shift+E",
      "command": "export",
      "enabled_when": "currentTab.kind == 'markdown' || currentTab.kind == 'html'",
      "prompt": {
        "kind": "save-dialog",
        "default_filename": "{stem}.pdf",
        "filters": [{ "name": "PDF", "extensions": ["pdf"] }]
      }
    }
  ],

  "host_capabilities": ["renderer.html", "toast"],
  "timeout_seconds": 60
}
```

### Manifest 协议扩展细节

#### `prompt` 块

```ts
type PromptSpec = {
  kind: "save-dialog";                        // v1 唯一支持的 kind
  default_filename: string;                   // 模板字符串；占位符见下
  filters: Array<{ name: string; extensions: string[] }>;
}
```

模板占位符（仅在有 active tab 时可解；无 active tab 时菜单项必然
被 `enabled_when` 拦掉）：

| 占位符 | 含义 | 例（tab.path = `/u/b/foo.md`）|
|---|---|---|
| `{basename}` | 文件名（含扩展名）| `foo.md` |
| `{stem}` | 去掉最后一个扩展名的文件名（点文件如 `.env` 保留全名）| `foo` |
| `{ext}` | 最后一个扩展名（不含点）| `md` |
| `{dir}` | 父目录（不含尾斜杠）| `/u/b` |

未识别的 `{xxx}` 占位符按字面量保留（容错；不抛错）。

`prompt` 仅对带 `prompt` 字段的菜单项生效；未声明 prompt 的菜单项
依旧走"直接 invoke"路径。

#### `enabled_when` 比较运算符

现有 grammar：

```
expr  := atom | "!" atom | atom "&&" atom | atom "||" atom
atom  := path | "(" expr ")" | "true" | "false"
```

扩展为：

```
expr  := compare ( ("&&" | "||") compare )*
compare := atom ( ("==" | "!=") atom )?
atom  := path | "(" expr ")" | "true" | "false" | quoted-string
```

- 字符串字面量用单引号或双引号（与既有 `path` 的 quoted-string segment
  一致）
- `==` / `!=`：值比较（字符串比字符串、布尔比布尔；类型不匹配时
  按 JS 宽松等价语义判定，false fallback）
- `currentTab` 为 null 时所有 `currentTab.x == 'y'` 求值为 false
  （短路；与既有 path-not-found → falsy 一致）

实现位置：`src/lib/plugins/enabled-when.ts` 的 hand-written
recursive-descent 解析器扩展约 30 行。

#### 启用/禁用：`plugins.enabled.<id>`

settings.json 新键：

```jsonc
{
  "plugins": {
    "enabled": {
      "share":   true,
      "md2pdf":  true
    }
  }
}
```

**默认值规则**：未在 `plugins.enabled` 出现的插件视为 `true`
（向后兼容：老 settings 文件没有这一段，新装的内置插件默认启用）。

**生效路径**：
- `plugin_host::init` 扫描 manifest 时读 settings → 命中 `false`
  的整体 **不加入 STATE**（不仅是"标记禁用"）。其副作用：
  - `get_plugin_manifests` 不返回它 → 菜单不出现、Settings tab 不出现、
    快捷键不挂载
  - `enabled_when` 求值不会触发
  - `dispatchPluginCommand` 收到禁用插件 id 时返回 `unknown plugin: <id>`
- 新增 `get_all_plugin_manifests` Tauri command：返回**所有**发现到的
  manifest（含 `enabled: bool` 字段），仅供 Preferences "Plugins" tab 使用。

## Data Flow

### 启动期

```
M↓ 进程启动
   ↓
plugin_host::init(&app)
   ↓
扫描 <resource_dir>/plugins/*/manifest.json
   ↓
对每个 manifest：
   - 解析、JSON Schema 校验
   - 读 settings.plugins.enabled.<id>（默认 true）
   - enabled = true → 加入 STATE
   - enabled = false → 仅记入"全集"列表（供 get_all_plugin_manifests）
   ↓
前端 App.svelte onMount:
   - get_plugin_manifests() → registry.ts → 注册菜单 / 快捷键 / settings tab
```

整个过程仍只读 manifest.json，**不打开任何插件二进制**，跟现有 spec
的"启动开销 < 20ms"约束一致。

### 触发期（Cmd+Shift+E 或 File → Export to PDF…）

```
用户按 Cmd+Shift+E
   ↓
Tauri menu-event "plugin:md2pdf:export"
   ↓
dispatchPluginCommand('md2pdf', 'export')
   ↓
host.ts:
  1. 查 manifest 找到 menus[command='export']
  2. 命中 prompt.kind='save-dialog':
       activeTab → 渲染 default_filename "{stem}.pdf"
       saveDialog({ defaultPath, filters })
       用户取消 → 静默 return
  3. 构造 context（含 output_path）：
       - tab metadata（path/filename/extension/kind/title/is_dirty/is_untitled）
       - 命中 'renderer.html' capability →
           host-render-html.renderTabAsHtml(tab) →
             markdown → marked → KaTeX → hljs → renderDiagrams →
             inline images（fs::readBinaryFile + base64 → data:URL）→
             hasMathContent 判定后按需 prepend KaTeX CSS →
             计算 title（H1 优先，basename 兜底）→
             返回 { body, title }
       - settings：md2pdf 未声明 settings.read，request 不含 settings 字段
  4. invoke('invoke_plugin', { pluginId: 'md2pdf', request_json })
   ↓
plugin_host.rs (Rust 主进程):
  - manifest 已校验在 STATE 内（启动时筛过）
  - tokio::process::Command::spawn bin-<arch>-apple-darwin
  - 写 stdin（request + '\n'），关闭 stdin
  - 读 stdout 第一行（≤ 60s）
  - 读 stderr 至 EOF（cap 16KB）
  - wait exit
   ↓
md2pdf CLI 子进程:
  1. read_to_string(stdin) → parse Request
  2. template.wrap_html(body, title) → self-contained HTML
       <!doctype><html>...
         <style>{include_str!("../assets/pdf.css")}</style>
         <body data-pdf-title="{title}">{body}</body>
       </html>
  3. NSApplication.sharedApplication() + 设置 activation policy = prohibited
       （CLI 不出现在 Dock）
  4. 离屏 WKWebView 加载 HTML（baseURL 用 file:///tmp/，因为图片已 inline）
  5. WKNavigationDelegate.didFinish →
       evaluateJavaScript("document.documentElement.scrollHeight")
  6. 按 INNER_H 切页 → 循环 createPDFWithConfiguration({ rect: ... })
  7. PDFKit merge → expand_to_a4_with_margins → JPEG 优化
  8. fs::write(output_path, bytes)
  9. emit Response { success: true,
                     actions: [toast{ level: success,
                                      message: "✅ 已导出到 <path>" }] }
  10. NSApp.stop(nil) → exit 0
   ↓
plugin_host.rs:
  - 拿到 stdout JSON、exit code = 0、success = true
  - 返回 InvokeResult 给前端
   ↓
host action handlers:
  - 跑每个 action：toast → 用户看到 "✅ 已导出到 ..." 自动消失
```

### 失败路径

| 失败 | 检测点 | 用户看到 |
|---|---|---|
| save dialog 取消 | host (prompt 处理) | 静默退出，无 toast |
| `enabled_when` 求值假被绕过（理论上不该发生）| host (dispatch 前再核一次) | 静默退出 |
| `output_path` 父目录不可写 / 磁盘满 | CLI fs::write | toast `❌ md2pdf: 写入失败` + detail = OS error |
| WKWebView 加载失败 | CLI nav delegate didFail | toast `❌ md2pdf: 渲染失败` + detail = NSError msg |
| WKWebView createPDF 失败 | CLI capture loop | toast `❌ md2pdf: 渲染失败` + detail = NSError msg |
| CLI 自身 panic | host | toast `❌ md2pdf: 异常退出（code N）` + last 1KB stderr |
| CLI 超时（>60s）| host plugin_host.rs | toast `❌ md2pdf: 未响应（60s）` |
| CLI stdout 不是合法 JSON | host action handler | toast `❌ md2pdf: 协议错误` + first 1KB stdout |
| 插件被禁用但快捷键被按 | menu-registry 校验 | 不会发生（禁用时 manifest 不入 STATE，shortcut 不挂载）|

## Preferences UI: Plugins tab

`SettingsDialog.svelte` 的 tab strip 在最左侧加固定的 **"Plugins"** tab
（位于 "Core" 之前），新建 `PluginsSettingsTab.svelte`：

布局：

```
Plugins
─────────────────────────────────────────────────────
☑ Share                                        0.1.0
  Publish current file as a shareable web page
  Capabilities: renderer.html, settings.*,
                clipboard.write, toast, dialog

☑ Export to PDF                                0.1.0
  Export the current Markdown/HTML tab to A4 PDF
  Capabilities: renderer.html, toast
─────────────────────────────────────────────────────
ⓘ 改动需要重启 M↓ 后生效
```

实现要点：
- onMount 调 `get_all_plugin_manifests()` → 拿到全集 + 当前 enabled 状态
- 每行一个 `<input type="checkbox">`，`onchange` →
  `mergePluginScoped({ 'plugins.enabled.<id>': bool })` 写入 settings.json
- Capabilities 摘要直接渲染 manifest.host_capabilities 数组（透明性）
- 底部固定一行小灰字：`改动需要重启 M↓ 后生效`，避免用户期待立即生效

## CLI 实现要点

### NSApplication runloop（CLI vs Tauri 进程的差异）

现有 `pdf.rs` 借助 `app.run_on_main_thread` 进入 Tauri 已经初始化好的
AppKit 主线程；CLI 进程没有这层基础设施，需要自己拉起：

```rust
// md2pdf/src/main.rs（伪代码）
fn main() {
    let mtm = MainThreadMarker::new().unwrap();        // 主线程
    let app = unsafe { NSApplication::sharedApplication(mtm) };
    unsafe {
        app.setActivationPolicy(NSApplicationActivationPolicyProhibited);
    }

    let request = read_stdin_and_parse();
    let response_cell = Rc::new(RefCell::new(None));

    spawn_pdf_pipeline(mtm, request, response_cell.clone(), move |result| {
        // result 写入 response_cell；通过 NSApp.stop 让 run() 返回
        unsafe { app.stop(None) }
    });

    unsafe { app.run() };                              // 阻塞至 stop

    let response = response_cell.borrow().clone()
        .unwrap_or_else(|| Response::fail(...));
    emit(response);
}
```

`spawn_pdf_pipeline` 内部沿用 `pdf.rs` 已有的
`NavDelegate` + `WKWebView` + `createPDFWithConfiguration` + PDFKit
merge 流水线 —— 那段代码原样搬过来，仅把"成功/失败回调"从
`tokio::oneshot` 改为同步 `Rc<RefCell<…>>`。

### `pdf.css` 嵌入

```rust
// md2pdf/src/template.rs
const PDF_CSS: &str = include_str!("../assets/pdf.css");

pub fn wrap(body: &str, title: &str) -> String {
    let title = html_escape(title);
    format!("<!doctype html>\n<html lang=\"en\">\n<head>\n\
             <meta charset=\"utf-8\">\n<title>{title}</title>\n\
             <style>{PDF_CSS}</style>\n</head>\n\
             <body data-pdf-title=\"{title}\">\n{body}\n</body>\n</html>")
}
```

KaTeX CSS 的处理：md2pdf 不再做 `hasMathContent` 启发式 → 渲染端
（host）已经把 KaTeX 输出 inline 化为 HTML（含 `<span class="katex">`
之类节点），但 KaTeX 字体 CSS 没 inline。两个选项：
- (a) host 在 `host-render-html` 里**总是** inline 一份 KaTeX CSS（约 70KB minified）
- (b) host 检测 markdown 是否含数学，按需 inline

为减小 PDF 体积，沿用现有 `hasMathContent` 启发式由 host 决定是否
将 KaTeX CSS 一并塞进 inline body 顶部 `<style>` 标签 —— 函数搬到
`host-render-html.ts`。md2pdf CLI 再把 body 直接套到模板里，KaTeX
CSS 自然位于 body 顶部、对 WKWebView 正常生效。

> 决策：v1 沿用启发式，由 host 端决定。后续如果出现误判可以加
> manifest 配置项或全局 inline。

### 二进制大小

预期：`mdshare` 当前发布二进制约 5-7 MB（`opt-level=z` + LTO + strip）。
md2pdf 因为引入 `objc2-pdf-kit` / `objc2-web-kit` 会更大，估 8-12 MB。
universal binary（aarch64 + x86_64）双份打包到 `.app` 里，最终多约
20MB。可以接受 —— 与现状（这些代码本来就在主二进制里）相比，**总分发
体积持平或略增**，但代价是主程序运行时大幅减负。

## Build & Release

### `scripts/build-md2pdf.sh`（新增）

完整复制 `scripts/build-mdshare.sh`，将其中：

- `mdshare` → `md2pdf`
- `share` → `md2pdf`（plugin 子目录名）

其余（rustup target add、cargo build × 2、strip、Developer ID 签名 +
hardened runtime + secure timestamp、key 自动发现、缺签名时降级警告）
保持不变。

### `package.json`

```jsonc
{
  "scripts": {
    "build:mdshare": "bash scripts/build-mdshare.sh",
    "build:md2pdf":  "bash scripts/build-md2pdf.sh"
  }
}
```

### `scripts/release.sh`

在现有 `pnpm build:mdshare` 之后插入：

```bash
say "building md2pdf plugin binaries"
pnpm build:md2pdf
```

`git add` 列表追加：

```
src-tauri/plugins/md2pdf/bin-aarch64-apple-darwin
src-tauri/plugins/md2pdf/bin-x86_64-apple-darwin
```

### bundle.resources

`src-tauri/tauri.conf.json` 现有 `bundle.resources: ["plugins/**/*"]`
已覆盖；无需改动。`.app` 包内代码签名时 `plugins/md2pdf/bin-*` 会被
naturally 包含 → notarization 通过。

## Testing

### Rust 单元（`md2pdf/tests/smoke.rs`）

- `smoke_render_one_page`：spawn md2pdf binary，stdin 喂一段 Request
  JSON（context.rendered_html = `<h1>Hi</h1><p>x</p>`，
  output_path = 临时文件），断言：
  - 进程退出码 0
  - stdout 第一行是合法 JSON 且 success = true
  - output_path 文件存在且 size ≥ 1KB
- `smoke_render_multipage`：长文档（200 段 `<p>x</p>`）→ 输出 PDF
  能被 PDFKit 打开且页数 > 1（用 `lopdf` 或简单 magic bytes 检查）

### 前端单元（vitest）

- **`host-render-html.test.ts`**（新）：
  - markdown tab → marked + KaTeX + hljs 输出符合预期
  - html tab → 直接返回 body
  - 含 `<img src="./foo.png">` → 转 data:URL（用 mock fs.readBinaryFile）
  - 含 mermaid block → 渲染为 SVG（mock renderDiagrams）
  - `hasMathContent` 启发式
- **`prompt.test.ts`**（新）：
  - default_filename 模板渲染 `{stem}.pdf`、`{basename}.bak`、
    `{dir}/x.pdf` 各种组合
  - 未识别的占位符按字面量保留
  - tab.filePath 为空时 fallback 到 `untitled.<ext>`
- **`enabled-when.test.ts`**（增）：
  - `currentTab.kind == 'markdown'`、`!= 'code'`、混合 `&&` `||` 优先级
  - currentTab 为 null 时 `currentTab.kind == 'markdown'` 求值 false
- **`registry.test.ts`**（增）：
  - settings.plugins.enabled.foo = false → init 后该 manifest 不在 enabled set
  - 默认值（缺 key）→ enabled

### Rust 集成（`src-tauri/tests/`）

- 新增 `plugin_host_disabled` 测试：fixture manifest + settings 标记
  `plugins.enabled.foo = false`；调 `init_from`；断言 STATE 不含 foo
  但 `get_all_plugin_manifests` 仍返回（含 enabled = false 标记）
- 现有 `plugin_host` 测试增加："prompt 字段存在时 manifest 解析正常"

### 手动冒烟（README）

现有 31-39 项（PDF 导出）保留 —— 行为对用户不变，依旧 `Cmd+Shift+E`、
依旧弹 save dialog、依旧得到典雅 A4 PDF。

新增 6 项（追加到 plugin platform 段尾）：

```
58. **Disable md2pdf** — Preferences → Plugins → uncheck "Export to PDF"
    → restart M↓ → File 菜单不再有 "Export to PDF…"，Cmd+Shift+E 不响应
59. **Re-enable md2pdf** — re-check → restart → 菜单恢复，Cmd+Shift+E 工作
60. **Disable share** 同样验证一次（确保不止 md2pdf 被正确处理）
61. **Default-on for new plugin** — 删除 settings.json 中 plugins.enabled
    整段 → 重启 → md2pdf 与 share 仍可用（默认 true 规则生效）
62. **md2pdf timeout** — 临时把 manifest 中 timeout_seconds 改为 1，
    导出大文档 → toast `❌ md2pdf: 未响应（1s）`，主程序保持响应
63. **md2pdf 写入失败** — 在只读目录里点 Save → toast
    `❌ md2pdf: 写入失败`，主程序保持响应
```

## Migration / Compat 注意事项

### 用户数据

无 schema migration 需求：
- 用户 settings.json 没有 plugins.enabled 段时，按"全部启用"处理
- 默认配置下（md2pdf 启用），快捷键 `Cmd+Shift+E` 行为对用户不变
  （manifest shortcut 与原 hardcoded shortcut 相同；只是触发路径
  从静态菜单改为 `dispatchPluginCommand('md2pdf', 'export')`）。
  用户主动禁用 md2pdf 后 `Cmd+Shift+E` 不响应 —— 这是新引入的、
  预期内的行为。

### 开发者工作流

- `pnpm tauri dev` 期间，要确保 md2pdf 二进制也存在于
  `src-tauri/plugins/md2pdf/`，否则 manifest 加载但 invoke 时报
  "binary not found"。开发文档在 build-mdshare 处加一句：第一次
  开发或拉新分支后跑 `pnpm build:md2pdf` 一次。
- `release.sh` 已自动跑两份 build；CI/release 流程无需手动管插件。

## Open questions

无。

## 后续工作（明确不在 v1）

- 启用/禁用实时生效（动态加/删 Tauri 菜单与快捷键）
- 用户级第三方插件目录 + 信任策略
- "在 Finder 中显示" / "用默认应用打开" 的 host capability
- 第二种 prompt kind（如 `pick-folder`、`text-input`）
- 启动期 V8 模块解析的动态 import 优化（profiling 后再说）
- KaTeX CSS inline 由启发式改为 manifest 配置（仅在确实出现误判时再做）
