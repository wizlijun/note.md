# Typeset Reader 渲染性能重构

## 问题与证据

`*.typeset.md` 的首次阅读长期停在“Typst 正在排版”。旧实现并未保证首批工作量：下一 H1 优先于 16 KiB 预算；320 KiB 续批仍可能长时间编译。`prepare` 在协议线程扫描字体，重复打开先创建引擎才查任务。更根本的是 typst-as-lib 0.16.0 的 `FontEnum::FontPath::get` 每次执行 `fs::read` 和 `Font::new`，并默认在每批后 `comemo::evict(0)`。

## 参考与取舍

- [Typst FontStore](https://github.com/typst/typst/blob/0b258bd7eebdd648ffefc529fdc9d5dc201ed528/crates/typst-kit/src/fonts.rs#L24-L115)：用 OnceLock 缓存首次字体加载。
- [Typst SystemWorld](https://github.com/typst/typst/blob/0b258bd7eebdd648ffefc529fdc9d5dc201ed528/crates/typst-cli/src/world.rs#L25-L151)：字体库跨编译复用，文件按编译快照管理。
- [Tinymist RenderActor](https://github.com/Myriad-Dreamin/tinymist/blob/f3b00eb553d6b7a35b5d59cce529c8d0d774cfce/crates/typst-preview/src/actor/render.rs#L36-L167)：常驻工作器与合并重复渲染需求。
- [typst.ts 可视区渲染](https://github.com/Myriad-Dreamin/typst.ts/blob/1189a2f17527467e2f41e78b04e9d7f58a122cdf/crates/conversion/vec2svg/src/frontend/incremental.rs#L133-L205)：离屏保留尺寸占位，限制实际页面内容驻留。

采用这些机制，保留原生 Typst、离线模板和逐页 SVG；不引入完整 LSP/WebSocket/WASM 客户端栈。

## 契约

1. 后端使用进程级 FontStore + 最小 World，字体懒加载一次；源文件、模板、图片在任务中保持一致快照；保留有限代数的编译缓存。
2. `render` 创建独立 `render_id` 并立即返回。单后台工作器负责校验、图片 hash、字体准备、编译和落盘。任务逐批轮转；相同实际缓存键可共享正在进行的渲染。
3. `render-next` 只读取状态，不发起编译。状态包含 stage、完成批次/总批次、已完成页数和错误。准备前 cache_key 为空，准备后为内容寻址键。`page` 保留 cache_key + page 协议。
4. `cancel` 只取消一个 render_id 的订阅；不存在读者时在批次间停止。当前 Typst 编译不做危险线程中断，超大单块不是硬实时保证。
5. 首批目标 16 KiB，续批目标 64 KiB。仅完整顶层 Markdown 块可分割，保留跨块引用/脚注语义；单个超过预算的块保持完整，不截断语法。模板风格与只读语义不变。
6. 前端收到任何已有页面立即显示；切文档、切模板、卸载和迟到响应释放旧订阅。限制挂载页数、释放离屏 SVG URL，失败仍保留已经完成的页面和重试入口。
7. 缓存版本递增，完整提交原子化。读取单页不再逐次 stat 所有分页；打开时验证完整性，损坏缓存允许重建。

## 验证计划

- 保留旧 release，真实书籍在独立临时缓存通过 NDJSON 测量：准备/首屏/全书/热开、续排时单页延迟、峰值 RSS。
- 回归：超长第一章、嵌套列表/代码/表格/HTML、字体一次加载、图片漂移、损坏缓存、并行读者/取消/异常保页、关闭后无轮询与 URL 泄漏。
- Rust 测试与 release 构建；Svelte 测试、检查和生产构建；真实 UI 阅读与滚动验证。
- 不修改 Vault 原文；用户后续已授权将 0.2.0 发版并推送。已存在的其他插件工作区改动保持原样。
