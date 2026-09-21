# Typeset Reader

`notemd.typst-reader` 是 `*.typeset.md` 的只读分页视图。它保留 Markdown
作为源格式，使用 Typst 0.15.1、cmarker 0.1.10 与固定离线的
wonderous-book 0.1.2 排版。冷打开时先生成一个小型预览批次，首批页面完成即可
阅读，后续分页在后台动态生成；排版继续进行时，已生成页面仍可立即读取。全部页面
会持久缓存，相同正文、模板和本地图片再次打开时直接复用。

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

`bash scripts/dev-install-plugin.sh typst-reader` 可在明确需要时安装当前架构的
开发构建。`bash scripts/release-plugins.sh typst-reader` 会构建双架构安装包，
但不会上传或发布。

## 第三方组件

cmarker 与 wonderous-book 的固定离线副本位于 `backend/assets/`；来源、版本
与许可证见对应目录及 `THIRD_PARTY_LICENSES.txt`。其余 Rust 依赖的许可证由
Cargo 元数据记录。
