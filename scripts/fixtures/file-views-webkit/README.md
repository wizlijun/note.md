# File views：隔离原生 WebKit 验收

在 macOS 仓库根目录运行：

```sh
node scripts/check-file-views-webkit.mjs
```

脚本重新构建 Timeline 生产包，以生产模式编译真实 `FilePluginView.svelte`，再编译独立 Swift AppKit helper。Rust 协议测试从真实 `handle_parsed` 导出 HTML、同源外部 `__notemd_bridge__.js` 与完整 CSP。`WKURLSchemeHandler` 分别提供 `tauri://localhost` 和 `plugin://notemd.timeline`；不通过 `WKUserScript` 预置 `window.notemd`，无私有 WebKit scheme 注册和额外 CORS 放宽。

两个场景检查原生 MessageEvent 双向 origin/source、ready 握手、宿主 Rich/Source/插件视图控件、非法时间解析回退，以及回退保留原文字节。分类保存、日期导航与 CSP 表单边界由 `check-timeline-browser.mjs` 的生产 bundle 双源浏览器验收覆盖。截图、JSON 结果、bundle SHA-256 和编译结果保存在输出提示的临时目录。

隔离边界：使用 `WKWebsiteDataStore.nonPersistent()`，阻止 HTTP/HTTPS 请求；仅加载生产插件包、编译后的测试宿主页及内存文档。插件通过真实外部 bridge 的 `fetch('/__rpc__')` 调用 Swift 内存 JSON-RPC fixture，`host.settings.get/set` 不触及真实设置。不会启动 note.md 主应用、读取或写入用户 Vault/设置，不访问真实 Tauri RPC。本验收不代表完整安装的宿主进程、真实设置落盘、系统 IME 或 VoiceOver 验收。
