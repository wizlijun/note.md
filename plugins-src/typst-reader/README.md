# Typeset Reader

`notemd.typst-reader` 是 `*.typeset.md` 的只读分页视图。它保留 Markdown
作为源格式，使用 Typst 0.15.1、cmarker 0.1.10 与固定离线的
wonderous-book 0.1.2 排版。冷打开时先生成一个小型预览批次，首批页面完成即可
阅读，后续分页在后台动态生成；排版继续进行时，已生成页面仍可立即读取。全部页面
会持久缓存，相同正文、模板和本地图片再次打开时直接复用。

0.2.0 改用官方 `FontStore` 与离线 `World`：系统字体只发现一次、按需加载一次，
模板与编译结果跨批复用。单个后台工作器负责准备、编译和缓存写入，逐批轮转任务，
重复文档共享编译；协议线程只读取进度及页面。每个阅读视图有独立订阅，关闭或
切换后在批次间取消，失败时保留已完成页供继续阅读。队列与订阅数量有上限。

首批目标为 16 KiB，续批目标为 64 KiB，只在完整顶层 Markdown 块之间分割；
引用定义和脚注内容跨批补齐，列表、代码、表格与 HTML 容器保持完整。单个超大
不可分割块允许超预算，因此不承诺硬实时响应。各批独立分页，批末可能留白，
脚注编号可能在新批重新开始。前端只挂载视口附近页面，并及时释放离屏 SVG。

实现参考了 [Typst 的字体缓存](https://github.com/typst/typst/blob/0b258bd7eebdd648ffefc529fdc9d5dc201ed528/crates/typst-kit/src/fonts.rs)、
[Tinymist 的常驻渲染任务](https://github.com/Myriad-Dreamin/tinymist/blob/f3b00eb553d6b7a35b5d59cce529c8d0d774cfce/crates/typst-preview/src/actor/render.rs)
和 [typst.ts 的可视区渲染](https://github.com/Myriad-Dreamin/typst.ts/blob/1189a2f17527467e2f41e78b04e9d7f58a122cdf/crates/conversion/vec2svg/src/frontend/incremental.rs)。

需要 note.md `6.921.2` 或更高版本。当前发布包提供 macOS Apple Silicon 与
Intel 两种架构；Windows 尚无原生插件包。

模板统一保存在后端资源目录。自动模式根据正文字符比例选择模板：CJK 正文使用
`templates/aiwriter-book.typ`，其他正文使用 wonderous-book；语言元数据只用于很短
的 CJK 内容，避免错误的 `language` 字段影响整本英文书。阅读视图右键菜单可手动
固定为任一模板，选择会持久保存。模板规则会进入缓存版本，不会误用旧页面。

选择 `typeset` 作为语义后缀，是因为文件本身仍是 Markdown，而不是 Typst
源代码。电子书导入器的新文件名是 `book.typeset.md`；旧 `book.md` 不会自动
改名，仍由普通 Markdown 视图打开。

## 开发验证

```sh
cargo test --manifest-path plugins-src/typst-reader/backend/Cargo.toml
pnpm --filter typst-reader test
pnpm --filter typst-reader check
pnpm --filter typst-reader build
```

真实书籍的 release 协议基准（使用临时缓存，不修改书籍）：

```sh
python3 scripts/benchmark-typst-reader.py \
  --binary plugins-src/typst-reader/backend/target/release/notemd-typst-reader \
  --source /vault/books/Example/book.typeset.md --vault /vault \
  --timeout 120 --output /tmp/typst-benchmark.json
```

报告包含首批可读时间、全书时间、热缓存命中、排版期间页面 RPC 耗时及采样峰值内存。

`bash scripts/dev-install-plugin.sh typst-reader` 可在明确需要时安装当前架构的
开发构建。`bash scripts/release-plugins.sh typst-reader` 会构建双架构安装包，
但不会上传或发布。

## 第三方组件

cmarker 与 wonderous-book 的固定离线副本位于 `backend/assets/`；来源、版本
与许可证见对应目录及 `THIRD_PARTY_LICENSES.txt`。其余 Rust 依赖的许可证由
Cargo 元数据记录。
