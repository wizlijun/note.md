# Typeset Reader

`notemd.typst-reader` 是 `*.typeset.md` 的只读分页视图。它保留 Markdown
作为源格式，使用 Typst 0.15.1、cmarker 0.1.10 与固定离线的
wonderous-book 0.1.2 排版。冷打开时先生成一个小型预览批次，首批页面完成即可
阅读，再用较大的续排批次避免反复编译的开销；全部页面会持久缓存，相同正文、
模板和本地图片再次打开时直接复用。

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
