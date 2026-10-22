# Rich checkbox 点击修复验证（2026-10-22）

## 复现与原因

用户报告 Markdown rich 模式 checkbox 无法点击。只读检查当前打开文件后，在内存副本复现首任务项的原生 `setNodeMarkup(checked)` 返回 `unsupported-step`；未修改用户文件。

匿名最小复现：

```markdown
- [ ] A

[^a]: note
[^b]: note
```

点击处理器仍在工作；旧逻辑把 checked 属性变化当作结构事务，尝试重写列表及审查全文结构分隔，连续脚注定义导致无关任务项也被保真准入拒绝。仅一个普通任务项可以成功。进一步覆盖发现引用定义也会拒绝，任务项内嵌表格可能 `semantic-mismatch`；成功时仍可能把 `__bold__` 归一化为 `**bold**`，空任务项增加尾空格。

旧 checkbox 测试只调用裸 EditorView helper 并模拟布局，未覆盖实际文件控制器、源码准入与保存链路。

## 修复

核心提交：`c74ab423cacbff18c6283ceb60a98a6eded1f8c3`（`../moraya-core`）。源码、13 项核心回归、未发布日志与全部变化的 dist 已一起提交。

- 在解析器实际消费任务前缀时捕获状态字符，绑定最终 list_item、root、原始 source/doc/roots/layout；不从文本搜索猜测任务位置。
- checked-only 原生 ReplaceAroundStep/AttrStep 链须逐步证明节点内容、其他属性和标记不变，才生成单字符 patch。
- 保留既有标准步骤重放、受保护源码及最终 PM 文档一致性校验。混合文字/属性编辑不取得额外权限。
- 保留原始大小写、实体、转义、列表标记、BOM/换行和周围格式；净空切换不改 `[X]`。不改点击处理器、DOM、主题，也不关闭保真门禁。
- 宿主加入实际 mountFileEditor 和桌面 RichEditor 的 DOM mousedown 集成回归；浏览器脚本新增 `--case checkbox`。

安装依赖沿现有 `pnpm run sync:core` 同步。构建前后清单证明 core/installed dist 共 64 文件逐字节一致；旧 hashed DTS 只在与构建前摘要相符后精确移除。最终安装 `dist/index.js` SHA256：`42d26db35f3d26c74c54d829fce86ec683ed87230cbc62ed1ab79e9daef448c5`。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 新增核心测试 RED | 首批 10 项：8 失败、2 通过 |
| 新增宿主测试 RED | 最终 13 项：12 失败、1 通过 |
| 浏览器 RED | 默认主题实际鼠标点击含引用定义任务，源码保持 `[ ]`，断言失败 |
| 核心全部测试 | 69 文件、1649 项通过（含 13 项专门回归） |
| 核心 TypeScript / tsup | 通过 |
| 宿主 Editor Kit v1/v2、Rich anchors/focus | 40 文件、527 项通过（含 13 项 checkbox 回归） |
| 宿主 svelte-check | 0 errors、31 既有 warnings |
| 宿主生产 build | 通过，包括分享编辑器和构建检查 |
| Chromium 140.0.7339.16 | 44 组内容/主题/明暗用例 + 1 组拒绝/重试/窄屏检查通过，pageErrors 为空 |
| 用户当前文档只读副本 | 22 个任务项逐一切换，每次仅一个字符变化，逆 patch 精确恢复，原文件未修改 |
| 独立审查 | 最终源码及测试无阻断项 |

浏览器 11 类内容为普通、连续脚注、未使用引用定义、引用链接、脚注与格式、嵌套表格、父子任务、有序列表、BOM/CRLF、已勾选大写 X、空任务；分别覆盖 Default/Effie 和明暗环境。使用真实鼠标命中 CSS checkbox，逐项验证 DOM checked、onChange、Source/Rich、保存 flush、键盘撤销重做、再次点击及重开。另验文字/右键不切换、readonly/policy 原子拒绝与重试、390px 窄屏。远程字体 CSS 在测试中以空响应隔离，不访问字体 CDN。

核心还覆盖父/子/独立 root 同事务切换、净空切换混入其他属性的拒绝、捕获事实冻结与不可移植。

## 复现入口和证据

- `pnpm exec vitest run src/editor-kit-v2/file-checkbox.test.ts`
- `scripts/check-file-editor-browser.mjs --case checkbox`，使用该脚本现有环境变量约定。
- 浏览器本机证据：`.superpowers/sdd/2026-10-14-file-bindings-history/checkbox-verified/`（45 组结果 JSON 与 5 张截图）。已检查 Effie 深色和窄屏截图。
- 本机依赖清单与当前文档元数据验证：`tasks/rich-checkbox-20261022/`；用户正文未写入受版本控制报告或测试。
- 宿主日志：`/tmp/notemd-checkbox-red-final.log`、`/tmp/notemd-checkbox-green.log`、`/tmp/notemd-checkbox-host-tests.log`、`/tmp/notemd-checkbox-check-final.log`、`/tmp/notemd-checkbox-host-build.log`、`/tmp/notemd-checkbox-browser-verified.log`。

## 中间失败及边界

- 浏览器验收脚本首次重复设置相同 stylesheet URL 等待不到 load；下一次因隔离字体 CDN 的 abort 导致 stylesheet error。已修正测试脚本为相同 URL 跳过加载、字体 CSS 空响应，原失败目录/日志保留。产品源码未为测试放宽。
- 宿主桌面测试最初观察了未代理的 tab 对象，改为实际响应式 tabs 实例并等待 onFileReady；最终真正核对桌面内容同步。
- 构建/测试存在既有 Svelte warnings、部分 happy-dom CSS 网络日志；最终相关断言和生产构建均通过。
- 本轮为源码修复及本地依赖同步，未 push、安装或发布桌面安装包；浏览器与 flush 验证不冒称原生 WKWebView 或真实 Vault 写盘验收。
- 原有 7 个未跟踪路径保留，不纳入提交。
