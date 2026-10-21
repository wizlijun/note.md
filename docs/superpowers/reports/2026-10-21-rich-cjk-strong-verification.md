# Rich 中文行内格式与编辑验证（2026-10-21）

## 范围与根因

原始复现：

```markdown
**用户怎么用 Tower.md，我们预测不了；人脑在哪里会出错，我们预测得了。**所以核心不预设任何场景，
```

用户随后要求将斜体、高亮等类似问题一起修复。最终覆盖 `**` / `__` 粗体、`*` / `_` 斜体、`~~` 删除线、`==` / `^^` 高亮，共 7 种写法。

旧解析器将 `。**所` 等边界判断为无法闭合；文本退化为字面标记后，补空格或删除句号又会突然改变解析语义，保真校验拒绝编辑。有效格式的边缘空白还有独立的映射/语义拒绝问题。

## 最终实现

- 在本编辑器的 inline State 上统一适配 `scanDelims`，使强调、删除线和等号高亮在 token 生成前共享中文标点边界；普通解析和源码捕获使用同一规则，不增加第二套解析器。
- 下划线邻接中文时允许词内强调，保持 ASCII `foo_bar_baz` / `foo__bar__baz` 的原行为。遵守 `posMax`，不读取递归内联范围之外的字符。`^^` 沿用原有递归规则。
- 在首次候选解析前，识别格式边缘插入/替换的空白，以及删除首尾文字后露出的空白，使用已有 inline recipe。普通替字仍走原精确文本路径；不放宽 `semantic-mismatch` 门禁。
- 必要时将边缘空白编码为实体并保护邻接字符，保留命名/十六进制实体的原拼写；下划线序列化与新解析规则一致。
- 加载原文不改字节。明确编辑边缘空格时可能写入 `&#32;` 及必要邻字实体，用于保持显示文字与格式。代码、数学、转义及 ASCII 标点边界未放宽。
- 底层直接删除原始示例四个星号均可成功，未将报告扩大为“所有星号不可删除”。浏览器覆盖非法字面星号删除，以及有效格式的取消操作。

## 提交与依赖

内核最终提交：`f3c08082430d4414fc3311b9feb85eee6dbe0e44`（`../moraya-core`），包含最初加粗修复提交 `601f1dbea2f1e25784f02adaf2ff6a9cb8f1edb5`。源码、回归、未发布日志及已跟踪 dist 一并提交。

宿主沿用 `file:../moraya-core` 和既有 `pnpm run sync:core`。对本轮生成的旧 hashed DTS，先与前驱提交 601f1db 的字节核对再精确移除；安装 dist 与最终内核 dist 全部 64 文件的清单及字节一致。宿主使用 markdown-it 14.3.3。

## 最终验证

| 检查 | 结果 |
| --- | --- |
| 扩展前宿主格式矩阵 | 38 失败 / 11 通过（49 项），证明新增范围缺陷 |
| 核心全量，单 worker | 68 文件 / 1634 项通过 |
| 核心 TypeScript、tsup | 通过 |
| 宿主 Editor Kit v1/v2、Rich anchors/focus | 39 文件 / 514 项通过 |
| 宿主 svelte-check | 0 errors / 31 既有 warnings |
| 宿主生产 build | 通过，包括分享编辑器及构建检查 |
| Chromium 140.0.7339.16 | 57 组编辑通过，pageErrors 为空 |

浏览器使用实际 `mountFileEditor`、真实 Backspace/空格及撤销重做键盘操作：原文 strong DOM/字重、斜体 font-style、删除线 text-decoration、高亮背景；格式内/外空格、替换句号为空格、删除首尾文字、取消格式和 4 个非法字面星号删除。每组断言 generation/onChange 增长、PM 可见正文、保存 flush、Source/Rich 切换、精确源码恢复、撤销/重做及重新挂载。取消格式矩阵走生产 owner 命令，原文取消加粗另有实际快捷键验收。已查看粗体及 7 种格式截图。

可复现入口：`scripts/check-file-editor-browser.mjs --case cjk`。最终本机证据目录：`.superpowers/sdd/2026-10-14-file-bindings-history/cjk-all-formats-20261021-visual/`（JSON、截图）。最终 browser core index.js SHA256：`ed92fb27c17f8b05ff0c6e39944151077f304449fafd40c6fdc6b840e13ab2c0`。

最终日志：`/tmp/notemd-cjk-all-formats-core-verified.log`、`/tmp/notemd-cjk-all-formats-build.log`、`/tmp/notemd-cjk-all-formats-host.log`、`/tmp/notemd-cjk-all-formats-browser-visual.log`、`/tmp/notemd-cjk-all-formats-host-build.log`、`/tmp/notemd-cjk-all-formats-host-check.log`。宿主测试和构建使用空 envDir。

## 中间失败与交付边界

- 初次 Playwright runtime 缺对应浏览器，改用已有 1.55.0 / Chromium 140 后通过，未安装浏览器。
- 一次并行核心测试出现未修改的 Mermaid theme spy 次数失败；最终单 worker 全量通过，未放宽断言。日志 `/tmp/notemd-cjk-core-tests-final.log` 保留。
- 扩展边界替换后，4 项既有测试发现普通替字被过度路由到 fragment-render。已将条件收窄为实际露出空白，恢复原 exact-text 行为，原测试不变且全量通过。
- 宿主单测有既有 happy-dom 样式获取日志；Vite 依赖扫描有无关虚拟分享模块提示，实际页面运行无异常。
- 验收为浏览器生产编辑器和保存接口，不是原生 macOS 安装包或真实 Vault 写盘。没有安装、push 或发布，未改用户文档；原有 7 个未跟踪路径保留。
