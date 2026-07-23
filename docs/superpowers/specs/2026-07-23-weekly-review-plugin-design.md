# Weekly Review 插件设计

> 状态:已确认,待写实现计划。
> 基线:2026-07-23(feat/daily-notes)。协议引用对照 `docs/plugin-v2-development.md`。
> 交互预览:`2026-07-23-weekly-review-plugin-mockup.html`(同目录,浏览器打开)。

## 1. 目标

一个 note.md v2 纯前端插件。安装启用后在**菜单栏托盘(tray)**出现 "Weekly Review" 项,点击打开一个独立窗口,以**传统日历式的年历**呈现 `vault/weekly-review/` 下的每周检视记录:

- 每月一个日格月历(4×3 排布),**周一起始**,因此日历里**一整行 = 一个 ISO 周**。
- 每一周被"框选"为一个可点击单元;**有周报的整周**高亮为主题色并可点击 → 用**主 md 编辑器**打开该周报查看/编辑。
- **本周**用橙色描边环高亮;**已过去**的空周浅灰;**未来**空周留白细边。
- 顶部用**艺术字体**显示当前年份;年份快捷切换器**只列出有数据的年**。
- 有"**本周**"快捷键定位当前周;有"**重构**"快捷键强制重扫重建。
- **不显示任何日记(diary)数据**——只关心 weekly-review。

## 2. 形态与目录

纯前端 v2 插件(照抄 `plugins-src/roam-import` / `decision-log` 骨架):

```
plugins-src/weekly-review/
├── manifest.v2.json
├── package.json  vite.config.ts  tsconfig.json  index.html
├── assets/brush-year.woff2          # 打包的艺术字体(年份显示)
└── src/
    ├── main.ts
    ├── App.svelte                    # 布局:头部(年份艺术字 + 工具栏) + YearCalendar
    └── lib/
        ├── bridge.ts                 # window.notemd 桥的类型化封装 + 新增 openInEditor()
        ├── strings.ts                # 自带 i18n(en/zh/ja/de)
        ├── isoweek.ts                # ISO 周数学(纯函数,单测覆盖)
        ├── scan.ts                   # 列目录 + 解析文件名 → 年→周集合;缓存/增量
        ├── cache.ts                  # localStorage 缓存读写(按 vault 根分键)
        └── components/
            ├── YearCalendar.svelte   # 12 个月格 + 图例
            ├── MonthGrid.svelte      # 单月:周一起始日格,按 ISO 周分行
            └── WeekRow.svelte        # 一周(7 天一行的框选单元 + 状态 + 点击)
```

**约束**:插件 UI 跑在隔离 webview,不能 `import` 主程序 `src/`。ISO 周逻辑自带在 `isoweek.ts`(不复用主程序)。本插件**不写 .note.md**,故无需复制 `outline/`。

## 3. manifest.v2.json

```jsonc
{
  "manifest_version": 2,
  "id": "notemd.weekly-review",
  "name": "Weekly Review",
  "version": "1.0.0",
  "kind": "native",
  "engines": { "notemd": ">=6.722.1" },     // 以含 host.editor.open 的宿主版本为准,发布时校正
  "description": "A year-at-a-glance calendar of your weekly reviews.",
  "ui": "ui/",
  "activation": { "events": ["onCommand:open"] },
  "contributes": {
    "menus":   [ { "location": "window", "label": "Weekly Review", "command": "open" } ],
    "windows": [ {
      "id": "main", "entry": "index.html", "title": "Weekly Review",
      "width": 1000.0, "height": 720.0, "min_width": 820.0, "min_height": 560.0,
      "open_command": "open"
    } ],
    "tray": [ { "window": "main" } ]
  },
  "capabilities": ["vault.read", "editor.open", "toast"],
  "i18n": { "zh": { "name": "周检视", "menus": { "open": "周检视" } } }
}
```

- `contributes.tray: [{ window:"main" }]` → 托盘下拉出现该项(缺省用本地化 name)。
- `menus.location:"window"` + `open_command:"open"` → 点菜单/托盘即开窗,不走插件进程。
- `capabilities` 是自由字符串,仅与 `host_api::method_capability` 对表(无独立白名单校验),故新增 `editor.open` 合法。
- `engines.notemd`:填入首个带 `host.editor.open` 的宿主版本(实现时按 release.sh 推导的版本号校正)。

## 4. 唯一核心改动:`host.editor.open`

插件隔离窗口无法直达主窗口打开文件。主程序内部靠 `emit_open_file_delayed` + `open-file` 事件开文件,但未暴露给插件。新增一个受能力门控的 host 方法:

**方法**:`host.editor.open`,参数 `{ path }`(vault 相对),返回 `{ ok: true }`。

改动点:
1. `src-tauri/src/plugin_runtime/host_api.rs::method_capability`:加 `"host.editor.open" => Some("editor.open")`。
2. `src-tauri/src/plugin_runtime/ui_rpc.rs` dispatch:新增分支——
   - 复用 `resolve_in_vault(path)` 做路径安全校验(拒绝绝对路径 / `..` / 符号链接逃逸;未配置 vault 报 `vault_required`)。
   - `crate::emit_open_file_delayed(app, abs_path)` + `crate::show_main_window(app)`(二者在 crate root,ui_rpc 可达)。
   - 返回 `{ ok: true }`。
   - **仅在 UI 桥通道实现**;后台进程通道天然回 `-32601`(与现有 dialog/fs 通道差异一致)。
3. 单测:仿 `host_api.rs` 现有 capability 测试,断言 `method_capability("host.editor.open") == Some("editor.open")`。
4. 文档:更新 `docs/plugin-v2-development.md` 的能力表(加 `editor.open` 行)与方法表(加 `host.editor.open`)。

> 该改动约 15 行 + 一条测试 + 文档。不属于插件包,随主程序发版。

## 5. 数据流与缓存/增量

### 扫描
1. 窗口加载 → `bridge().locale` 定语言;`host.vault.info` 拿 vault root(缓存分键用)。
2. `host.vault.exists({ path:"weekly-review" })`;不存在 → 空态提示(引导:把周报放到 `weekly-review/`,或跑 weekly-review skill)。
3. `host.vault.list({ path:"weekly-review" })` → 条目名。
4. 文件名正则 `^(\d{4})-W(\d{1,2})-weekly-review\.md$`(容忍 `W3`/`W03`,归一化补零)→ `{ year, week, path }`。
5. 归并成 `Map<year, Map<weekNum, relPath>>`。有数据年份 = 排序后的 key。

### 缓存
- `cache.ts`:把上一步的 `{ vaultRoot, index }` 写入 webview `localStorage`,键含 vaultRoot。
- 打开时**先读缓存立即渲染**(瞬时、不闪),再后台跑扫描;结果与缓存 diff(按 `year/week→path` 集合),有变化才更新 UI + 回写缓存。
- `host.vault.list` 仅返回 `{name,is_dir}`(无 mtime),故"增量"= 只重列 `weekly-review` 这一个目录再做集合 diff,开销极小。缓存的价值是重开即时。
- **↻ 重构**按钮:清缓存 + 强制全量重列重建(容错入口,防缓存与磁盘不一致)。

## 6. 年视图渲染(传统日历 + 周框选)

- 12 个月格,CSS grid `repeat(4,1fr)`(4 列 × 3 行);每月右上淡色水印月份数字。
- 每月:表头 `一 二 三 四 五 六 日`(**周一起始**;六/日红字);正文按 **ISO 周分行**——用每天的 `mondayOf(date)` 归行,`(getDay()+6)%7` 定列,月首/月末的残缺周只填该月的日、其余列留空(`·`)。
- **一行 = 一个 ISO 周**,行的 `weekNum = isoWeek(该行任一天)`;跨年周(如 1 月首行周一落在上一年、12 月末行)仍按 ISO 归到 `2026-Www`。
- 行(WeekRow)状态:

| 状态 | 判定 | 表现 |
|---|---|---|
| 有周报 | `weekNum ∈ index[year]` | 主题色填充框 + 白字 + 指针光标 + 可点击 |
| 本周 | 行的周一 == 今天所在周的周一 | 橙色描边环(叠加,可与"有周报"共存) |
| 已过去 | 行周一 < 今天周一 且无周报 | 浅灰底框 |
| 未来 | 行周一 > 今天周一 且无周报 | 留白 + 细边框 |

- 悬停 tooltip:`2026-W30 · 有周报(点击打开) / 无 / 未来`。

## 7. 交互

- **点有周报的整周** → `bridge.openInEditor("weekly-review/2026-W30-weekly-review.md")` → 主编辑器打开该文件并聚焦主窗口(查看/编辑全在主编辑器,富文本/Live-Preview 具备)。
- **◎ 本周** → 切到当前年 + 滚动定位/脉冲高亮当前周行。当前年无数据也照常渲染当前年空历。
- **↻ 重构** → 见 §5。
- **年份切换**:艺术字大号显示当前选中年;chips 只列有数据年;左右箭头切换。默认选当前年;当前年无任何周报则默认选最近有数据的年(仍可切回当前年看空历)。

## 8. 视觉/主题

- 窗口自声明 `:root { color-scheme: light dark }`(隔离窗口不从 app.css 继承,须自声明,否则 Canvas 系统色卡浅色)。
- 变量化配色,提供浅/深两套(见 mockup)。
- **艺术字体**:打包 `assets/brush-year.woff2`(笔刷/手写体),`@font-face` 引入;缺失时回退系统 cursive(Snell Roundhand / Zapfino)。仅用于年份大号显示。

## 9. i18n

- 插件自带 `src/lib/strings.ts`:`MessageKey` 联合类型 + 每语言 catalog + 本地 `t()`,当前语言取 `bridge().locale`(`'en'|'zh'|'ja'|'de'`)。覆盖:标题、图例(有周报/本周/已过去/未来)、本周/重构按钮、空态、tooltip 片段。
- 菜单/托盘标签:manifest `name` 英文 + `i18n.zh.name` 中文覆盖(宿主透传)。
- 周检视文档正文/文件名不译。

## 10. 测试

- **Rust**:
  - `cargo test -p plugin-protocol`(manifest 解析通过)。
  - `host_api.rs` 新增单测:`method_capability("host.editor.open") == Some("editor.open")`。
- **前端(Vitest)**:
  - `isoweek.ts`:`isoWeek()`(含 53 周年份 2026 边界:1/1 属 W1、12/28 属 W53)、`mondayOf()`、`weeksInYear()`、`todayIsoWeek()`。
  - `scan.ts`:文件名解析(合法 `2026-W30-weekly-review.md`、零填充 `W3` vs `W03`、非法名忽略)、多年归并、按年/周去重。
  - `cache.ts`:读写往返 + vaultRoot 分键 + 缺失/损坏缓存降级。
- **手动 GUI(我给步骤,用户实机测)**:`scripts/dev-install-plugin.sh weekly-review` → 重启 → 托盘打开 → 验证:12 月历/周框选/本周橙环/年份 chips 只列有数据年/点整周开主编辑器/重构刷新/浅深色跟随。

## 11. 构建 / 安装 / 发布

- `scripts/dev-install-plugin.sh` 加 `weekly-review` 分支(构建 Vite → `dist/`,拷入安装根,`state.json` 置 enabled)。
- 发布走 `scripts/release-plugins.sh` + `scripts/gen-plugin-index.mjs`(**merge 线上索引**,勿整体替换,防挤下架)。
- 核心改动(§4)随主程序发版;插件 `engines.notemd` 指向该版本。

## 12. 非目标(YAGNI)

- 不含日记(diary)可视化或按日着色。
- 不在插件内内嵌编辑器;编辑一律回主编辑器。
- 不做周报的新建/模板生成(那是 weekly-review skill 的职责);本插件只做**浏览 + 跳转打开**。
- 不做侧栏形态(当前无插件侧栏注册入口);仅独立窗口。
