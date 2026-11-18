# sumiwrite 第 0 期(建仓库与文档交接)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `~/git/sumiwrite` 建立玄霜写作的独立仓库,写齐交接方案、现行规范和技术选型记录;不搬代码。

**Architecture:** 新仓库本期只有文档。所有事实从 note.md 仓库(下称“源仓库”,`/Users/bruce/git/note.md`,基线 969f8e73)的代码、规范、CHANGELOG 和发布报告中读出,不凭印象写。一个自检脚本 `docs/check.sh` 充当测试:每个任务先加检查项并看它失败,再写文档让它通过。

**Tech Stack:** Markdown、git、bash(自检脚本只用 `grep`/`find`/`awk`,须在 macOS 自带工具下可跑)。

**Spec:** `/Users/bruce/git/note.md/docs/superpowers/specs/2026-11-18-sumiwrite-extraction-design.md`(下称“设计”)。执行者两份都要读。

## Global Constraints

- 文档一律用中文。产品名写“玄霜写作(Sumi Write)”;不写“玄霜打字机”“Sumi Typewriter”“Faitc5”(输入法正式名是 Fcitx5 for Sumi)。
- 本期对源仓库只读。唯一例外是任务 10(提交设计与计划两份文档)。
- 不建 GitHub 远端,不 push。仓库将来公开,但发布动作不在本期。
- 许可证 Apache-2.0,`LICENSE` 从源仓库根目录原样复制。
- 不建空的代码目录(`core/`、`protocol/`、`sync/`、`session/`、`apps/`)。
- 每条事实要有出处。写不出出处的,标 `[未定]` 并记入 `docs/handoff/04-known-gaps.md`,不要猜。
- **状态标注**:`docs/spec/` 下除 `MAPPING.md` 外,每个 `###` 小节标题后的第一个非空行必须是 `状态:` 开头的一行。取值只有五种:`[已交付:macOS+Linux]`、`[已交付:macOS]`、`[已交付:Linux]`、`[计划:iOS]`、`[未定]`。小节内个别规则状态不同时,在该规则末尾单独加标签。
- **证据链接**:凡 `[已交付:…]` 的状态行,同一行必须带至少一个证据链接,格式 `https://github.com/wizlijun/note.md/blob/<宿主tag或提交号>/<路径>`。插件没有自己的 tag,用宿主 `v6.*` tag 或提交号。
- **工程细则**:原规范中由实现团队补充、非用户逐项选定的数值(快捷键、尺寸、时间、阈值),在新规范里加 `(工程细则)` 标记。
- 提交信息用英文祈使句,结尾带 `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`。

## Review Focus

没有任务测试会自然覆盖、但最容易坑到读者的五种情况。每条已在对应任务里落成检查项。

1. **状态凭推断标成已交付。** 读者会据此以为功能存在。→ 任务 5 的 `check_status`:已交付状态行必须带证据链接。
2. **已被推翻的决定混进现行规范。** 例如旧路径 `inbox/write`、`.write.md`、Courier Prime、Special Elite、统一 Qt、横线光标。→ 任务 5 的 `check_retired`:这些词只允许出现在 `MAPPING.md`。
3. **契约漏掉宿主实际暴露的命令。** 将来宿主改了一个没登记的命令,插件静默坏掉。→ 任务 3 的 `check_contract`:源仓库里每个 `host.sumi.*` 命令名都必须出现在契约文档里。
4. **旧规范里仍有效的内容在合并中丢失。** → 任务 8 的 `check_mapping`:旧文档的每个二级标题都要在 `MAPPING.md` 有去向。
5. **文档间断链。** → 任务 1 的 `check_links`:所有相对链接指向存在的文件。

---

## 文件结构

```
~/git/sumiwrite/
  LICENSE
  README.md
  AGENTS.md
  docs/
    check.sh                         自检脚本(设计未列,本计划补充)
    handoff/
      00-overview.md
      01-inventory.md
      02-migration-plan.md
      03-notemd-contract.md
      04-known-gaps.md
    spec/
      00-product.md
      01-pages-and-storage.md
      02-markdown-and-line-time.md
      03-sync.md
      04-editing-experience.md
      05-fonts.md
      MAPPING.md
      platform/
        notemd-desktop.md
        ios.md
        later.md
    adr/
      0001-rust-core-yrs-yjs-v1.md
      0002-single-ytext-line-time.md
      0003-portable-files-and-sqlite-history.md
      0004-cloudflare-sync-private-pairing.md
      0005-native-text-controls.md
      0006-plugin-backend-vs-host-session.md
      0007-fonts-on-demand.md
      0008-standalone-repo-desktop-stays-plugin.md
      0009-page-store-vs-vault-projection.md
      0010-ios-uikit-textkit2-uniffi.md
      0011-ios-personal-use-identity-layer.md
      0012-shared-session-module.md
```

旧规范来源清单(任务 5–8 共用,下称“旧文档集”),均在源仓库 `docs/superpowers/specs/` 下:

- 主规范 `2026-11-07-immersive-write-design.md`
- 文件名含 `sumi` 的 14 份(`ls | grep -i sumi`,含 `sumi-ime-cross-platform.md`)
- `2026-11-08-plugin-payload-extraction.md`、`2026-11-11-writing-plugin-groups.md`、`2026-11-10-omarchy-plugin-shortcuts.md`、`2026-11-11-release-input-method-companion.md`、`2026-11-12-fcitx5-name-correction.md`、`2026-11-11-omarchy-amd64-ime-release.md`

---

### Task 1: 仓库骨架与自检脚本

**Files:**
- Create: `~/git/sumiwrite/LICENSE`、`README.md`、`AGENTS.md`、`docs/check.sh`

**Interfaces:**
- Produces: `docs/check.sh`。约定:从仓库根运行 `bash docs/check.sh`;环境变量 `NOTEMD`(默认 `$HOME/git/note.md`)指向源仓库;每个检查是一个 `check_*` 函数,失败时打印 `FAIL <检查名>: <原因>` 并使脚本最终以 1 退出,全部通过打印 `OK`。后续任务往里加函数,并在文件末尾的调用列表里登记。

- [ ] **Step 1: 建仓库**

Run: `mkdir -p ~/git/sumiwrite/docs && cd ~/git/sumiwrite && git init -b main && cp ~/git/note.md/LICENSE LICENSE`
Expected: `Initialized empty Git repository`,`head -2 LICENSE` 含 `Apache License`。

- [ ] **Step 2: 写 `docs/check.sh`,含两个检查**

- `check_files`:本计划“文件结构”里列出的每个文件都存在且非空。
- `check_links`:扫描所有 `*.md` 里的 `](相对路径)` 链接(忽略 `http` 开头和 `#` 锚点),目标文件必须存在。

- [ ] **Step 3: 运行,确认失败**

Run: `bash docs/check.sh`
Expected: 以 1 退出,输出多行 `FAIL check_files: missing …`。

- [ ] **Step 4: 写 `README.md`**

四段:产品一句话说明;仓库地图(只列已存在的东西,并说明代码目录按期迁入);当前期次(第 0 期,链接 `docs/handoff/02-migration-plan.md`);阅读顺序(`docs/handoff/00-overview.md` → `docs/spec/00-product.md` → `docs/adr/`)。

- [ ] **Step 5: 写 `AGENTS.md`**

必须包含这五条规矩,措辞可调:
1. 现行规范在 `docs/spec/`,改行为先改规范。
2. 原生编辑桥、宿主内 Sumi 界面与适配、插件 SDK、签名上架归 note.md,不在本仓库改;跨边界的改动先改 `docs/handoff/03-notemd-contract.md` 并升契约版本。
3. 规范每个小节必须有状态行,已交付必须带证据;提交前跑 `bash docs/check.sh`。
4. 红线:iOS 与桌面共用同一套 Rust 内核与会话模块,不得在 Swift 里重写 CRDT、行时间、合并或恢复逻辑。
5. 凭据只放引用,不放秘密。

- [ ] **Step 6: 提交**

```bash
git add LICENSE README.md AGENTS.md docs/check.sh
git commit -m "Initialize repository with license, readme and doc checks"
```

---

### Task 2: 清单 `01-inventory.md`

**Files:**
- Create: `docs/handoff/01-inventory.md`

**Interfaces:**
- Produces: 归属判定,任务 3、9 引用。每行六列:现位置、规模(文件数与行数)、依赖、归属(`sumiwrite`/`note.md`)、迁入期次(1/2/3/不迁)、备注。

- [ ] **Step 1: 往 `check.sh` 加 `check_inventory`**

断言 `01-inventory.md` 中出现以下每个路径字符串:`write-core/`、`sumi-protocol/`、`write-sync-worker/`、`plugins-src/write/`、`tauri-plugin-native-editor/`、`src-tauri/src/sumi/`、`src/lib/sumi/`、`packaging/omarchy/fcitx5-sumi-candidates/`、`notemd-plugin-sdk/`;并且源仓库 `scripts/sumi/` 下的每个一级条目(`ls $NOTEMD/scripts/sumi`)都在文档里出现。

- [ ] **Step 2: 运行,确认 `check_inventory` 失败**

- [ ] **Step 3: 写清单**

覆盖设计 §5.2 的全部行。规模用 `find … | wc -l` 和 `wc -l` 实测。额外要求:

- `scripts/sumi/` 逐条目判定。规则:运行时需要启动 note.md 宿主、链接 `tauri-plugin-native-editor`、或驱动真实窗口与输入法的,归 note.md;只依赖内核、插件壳或同步服务的,归 sumiwrite 第 2 期。拿不准的标“待第 2 期判定”并写明原因。
- `src-tauri/src/sumi/` 按文件列出(`mod.rs`、`journal.rs`、`recovery.rs`、`service.rs`、`sound.rs`、`external.rs`、`fonts.rs`、`paste.rs`、`sync.rs` 及测试文件),每个文件标“可下沉(第 3 期)”或“宿主适配(不迁)”,`mod.rs` 给出大致的职责分块。
- 单列一节“反向依赖”:插件壳对 `notemd-plugin-sdk`、`src/lib/sumi/i18n.ts`、`plugins-src/shared/shortcuts.ts`、`scripts/release-plugins.sh` 中 `release_sumi()` 的依赖,各附 import 或调用的行号。
- 单列一节“同步服务对源仓库的依赖”:`worker/` 里的 Wrangler 与 `tsc`、`scripts/cloud-admin.py` 读取的根目录 `.env` 与 `worker/wrangler.toml`、钉死的兼容日期。

- [ ] **Step 4: 运行 `bash docs/check.sh`,确认 `check_inventory` 通过**

- [ ] **Step 5: 提交**

```bash
git add docs && git commit -m "Add handoff inventory of Sumi code in note.md"
```

---

### Task 3: 契约 `03-notemd-contract.md`

**Files:**
- Create: `docs/handoff/03-notemd-contract.md`

**Interfaces:**
- Consumes: 任务 2 的归属判定。
- Produces: 契约版本号 `host-contract v1`(即当前已发布行为的快照),任务 7、9 引用。

- [ ] **Step 1: 往 `check.sh` 加 `check_contract`**

```bash
check_contract() {
  local doc=docs/handoff/03-notemd-contract.md
  grep -ohE 'host\.sumi\.[A-Za-z0-9_.-]+' "$NOTEMD/src-tauri/src/sumi/mod.rs" | sort -u |
  while read -r cmd; do
    grep -qF "$cmd" "$doc" || fail check_contract "command not documented: $cmd"
  done
  for s in 'host-contract v1' 'engines.notemd' 'Writing Page' '.writing.meta.json'; do
    grep -qF "$s" "$doc" || fail check_contract "missing: $s"
  done
}
```

(`fail` 是任务 1 脚本里的失败记录函数;若管道子进程导致失败状态丢失,改用临时文件记录。)

- [ ] **Step 2: 运行,确认 `check_contract` 失败**

- [ ] **Step 3: 写契约文档**,五部分,对应设计 §5.3:

1. **宿主接口契约 `host-contract v1`**。四张表,全部从代码读出:
   - `host.sumi.*` 命令:名称、参数、返回、用途。来源 `src-tauri/src/sumi/mod.rs`。
   - 原生编辑面能力:`tauri-plugin-native-editor/src/lib.rs` 暴露的命令与事件,按外观、光标、IME 交接、焦点、编辑事务、owner 交接分组。
   - 插件前端契约:`plugins-src/write/src/contract.ts` 的导出类型。
   - 后台服务握手与服务消息:`sumi-protocol/src/service.rs`、`durability.rs`、`fonts.rs`,含 `Hello{version,capabilities}` 的现值。
   - 末尾写版本规则:新增可选能力升次版本,改变或删除既有行为升主版本;主版本变化必须两仓库配套发版。
2. **依赖方向**:双向按固定 tag 引用;tag 命名 `core-vX.Y.Z`(sumiwrite 侧);本地联调用 `[patch]`。
3. **vault 投影约定**:路径 `inbox/writings/YYYY-MM-DD-NN.writing.md`、sidecar `.writing.meta.json`、frontmatter `type: Writing Page`,以及源仓库 OKF 写入规矩的链接。
4. **发版配合**:何时只发插件包、何时配套发版。
5. **签名与上架**:留在 note.md;sumiwrite 交付待签名构建物与校验清单。

- [ ] **Step 4: 运行 `bash docs/check.sh`,确认 `check_contract` 通过**

- [ ] **Step 5: 提交**

```bash
git add docs && git commit -m "Document the note.md host contract v1"
```

---

### Task 4: 技术选型记录 `docs/adr/`

**Files:**
- Create: `docs/adr/0001-…md` 至 `0012-…md`(文件名见“文件结构”)

**Interfaces:**
- Produces: 编号 0001–0012,规范与交接文档用相对链接引用。

- [ ] **Step 1: 往 `check.sh` 加 `check_adr`**

断言 `docs/adr/` 下恰有 12 个 `NNNN-*.md`;每个文件依次包含这些二级标题:`## 背景`、`## 决定`、`## 放弃的方案`、`## 后果`、`## 来源`;并在标题下有 `类型:补记` 或 `类型:新` 一行(0001–0007 为补记,0008–0012 为新)。

- [ ] **Step 2: 运行,确认 `check_adr` 失败**

- [ ] **Step 3: 写 12 篇**,每篇不超过一页。标题与决定取自设计 §7.3 的表。各篇必须写到的要点:

| 编号 | 必须写到 |
|---|---|
| 0001 | Yrs 固定 `=0.24.0`;线格式 Yjs update/state-vector V1;对 Yjs 13.6.33 互操作测试;UTF-16 范围与字素边界;LF 为唯一换行 |
| 0002 | 每个换行携带其后一行的稳定 UUID;时间随字符贡献保留;放弃“每行内嵌时间”和“后写覆盖的行对象” |
| 0003 | 小 YAML 头 + 正文 + JSON sidecar;完整 CRDT 历史只在 SQLite;放弃尾部 HTML/YAML 行表 |
| 0004 | Worker + Durable Object + R2;无公开注册;管理员开通首台设备;一次性配对码 300 秒;访问令牌 900 秒 |
| 0005 | 各平台原生文本控件;放弃统一 Qt、Web 编辑器;性能须实测不凭框架名推断 |
| 0006 | 插件后台负责持久化、投影、同步协调、字体下载;宿主保留内存 CRDT、实时编辑会话、原生桥;来源含 `2026-11-08-plugin-payload-extraction.md` |
| 0007 | 六组选项、七个字体文件;点击才下载;校验大小与 SHA-256;不装入系统字体目录 |
| 0008 | 设计 §4.1、§4.2、§5 的结论;后果里写原生桥改动仍受宿主发版牵制,以及设计 §9 的再评估标准 |
| 0009 | 设计 §5.4 |
| 0010 | 设计 §10.2;后果里写 FFI 构建成本、`rustls-tls-native-roots` 在 iOS 上可能不可用(未实测)、最低 iOS 17 |
| 0011 | 设计 §4.3、§10.4;后果里写第一阶段粘贴邀请文本配对,不做扫码 |
| 0012 | 设计 §10.2 关于下沉的理由;放弃“Swift 重写会话层”;后果里写第 3 期必须先于 iOS |

“来源”一节链接到源仓库的具体文件(用证据链接格式)。

- [ ] **Step 4: 运行 `bash docs/check.sh`,确认 `check_adr` 通过**

- [ ] **Step 5: 提交**

```bash
git add docs && git commit -m "Record architecture decisions 0001-0012"
```

---

### Task 5: 规范(一):产品、纸页与存储、Markdown 与行时间、同步

**Files:**
- Create: `docs/spec/00-product.md`、`01-pages-and-storage.md`、`02-markdown-and-line-time.md`、`03-sync.md`

**Interfaces:**
- Produces: 状态行与证据链接的写法,任务 6、7 沿用。

- [ ] **Step 1: 往 `check.sh` 加 `check_status` 与 `check_retired`**

- `check_status`:对 `docs/spec/**/*.md`(排除 `MAPPING.md`),每个 `### ` 标题后的第一个非空行必须以 `状态:` 开头,且含五种标签之一;含 `[已交付:` 的状态行必须含 `https://github.com/wizlijun/note.md/blob/`。
- `check_retired`:以下字符串不得出现在 `docs/spec/` 中除 `MAPPING.md` 以外的文件:`inbox/write/`、`inbox/writes`、`.write.md`、`Courier Prime`、`Special Elite`、`又又意宋`、`Sumi Typewriter`、`玄霜打字机`、`Faitc5`、`Sumi Elite`。

- [ ] **Step 2: 运行,确认 `check_files` 对这四个文件失败**

- [ ] **Step 3: 写四个文件**。来源见设计 §7.2 的表;重写规则见设计 §7.2 的列表。各文件必须有的小节:

- `00-product.md`:产品定义;命名(中文“玄霜写作”、英文及回退“Sumi Write”、日文沿用 Sumi Write;插件 ID `notemd.sumi` 不变);成功标准;平台与形态一览(桌面是 note.md 插件、iOS 是独立应用);与 note.md 的边界(链接契约文档);非目标。
- `01-pages-and-storage.md`:纸页模型(UUID 身份、摘要、无文件名概念);顺序(新页插在当前页后、顺序键与 UUID 打破平局);新建的幂等;空白页不落盘;废纸篓与恢复;纸页存储(SQLite 为本机事实源);本机正文优先与崩溃恢复(来源:主规范 620 行起的 P0 一节);“vault 投影只属于桌面”的指向。
- `02-markdown-and-line-time.md`:富文本与 Markdown 的边界;不支持的块原样保留;便携文件格式;行时间语义(逻辑行、首次书写与最后修改、屏幕折行不产生记录、空行无首次时间);`time_source` 取值;不做逐键回放。
- `03-sync.md`:线格式;身份(空间、设备、凭据)与纸页分层;令牌与配对流程及时限;纸页目录与操作的幂等(`opId`);并发与离线合并语义;代际与删除恢复;首次书写日期与文件序号分配;隔离与恢复;运维与备份。接口细节以同步服务 README 为准并链接,不整段抄。

每个小节的状态依据:CHANGELOG 两份、`docs/superpowers/reports/` 中对应发布报告、以及代码是否存在。iOS 相关一律 `[计划:iOS]`。

- [ ] **Step 4: 运行 `bash docs/check.sh`,确认 `check_status`、`check_retired` 对已写文件通过**

- [ ] **Step 5: 提交**

```bash
git add docs && git commit -m "Write spec: product, pages, markdown and sync"
```

---

### Task 6: 规范(二):编辑体验与字体

**Files:**
- Create: `docs/spec/04-editing-experience.md`、`docs/spec/05-fonts.md`

**Interfaces:**
- Consumes: 任务 5 的状态行写法与检查。

- [ ] **Step 1: 运行 `bash docs/check.sh`,确认 `check_files` 对这两个文件失败**

- [ ] **Step 2: 写 `04-editing-experience.md`**

只写与平台无关的规则;AppKit、GTK、Fcitx 的实现手段留给任务 7。必须有的小节:

- 排版默认值(22 pt、行距 1.6、约 80 半角列、留白随字号缩放的算法),标 `(工程细则)`。
- 主题:黑底白字、黑底灰字、白底黑字、米色深灰、复古绿磷 CRT、复古蓝磷 CRT,各带色值。动笔前先核对主题数量:设计写“六种”,主规范 §2.2 列了四个预设加两个 CRT,以源仓库插件代码中的主题表为准,有出入记入 `04-known-gaps.md`。
- 光标:稍粗竖线、高度随字体、`breathing`(4 秒一轮)与 `steady`、何时不显示。
- 聚焦与视区:当前行居中、首次进入、全屏字号、底部留白。来源含 `2026-11-10-sumi-focus-stability.md`、`2026-11-10-sumi-stationary-nonfocus-input.md`、`2026-11-11-sumi-platform-parity.md`、`2026-11-11-sumi-window-startup.md`。
- 进入后从文末续写等 0.1.15、0.1.16 的行为。来源:`CHANGELOG.zh-CN.md` 与 `docs/superpowers/reports/2026-11-12-sumi-entry-*`。
- 快捷键语义表:只写“操作”与“行为”两列(来自主规范 §2.4),不写具体键位;键位放平台附录。
- 空选区输入样式、Return 与缩进规则。
- 剪贴板:复制与剪切为 Markdown 纯文本、粘贴一律文本化、剪切先确认复制成功。
- 输入法边界:组字内容不进 CRDT、组字期间暂缓远端更新、打开面板前的受控交接、应用不强制系统输入法的候选位置与配色。
- 打字音与按键反馈。来源含 `2026-11-11-sumi-ime-sound.md`、`2026-11-11-sumi-ime-key-feedback.md`。
- 窗口:专注窗口固定规格或全屏(标明仅桌面)。

- [ ] **Step 3: 写 `05-fonts.md`**

小节:六组选项与七个字体文件(名称、字面、版本、大小);按需下载与状态显示;完整性校验与缓存位置;回退与离线行为;旧设置迁移到第一组;许可与来源(哪些是 OFL,朝华与油茶为作者许可)。字体清单以 `plugins-src/write/resources/sumi/manifest.json` 为准。

- [ ] **Step 4: 运行 `bash docs/check.sh`,确认这两个文件通过 `check_files`、`check_status`、`check_retired`**

- [ ] **Step 5: 提交**

```bash
git add docs && git commit -m "Write spec: editing experience and fonts"
```

---

### Task 7: 规范(三):平台附录

**Files:**
- Create: `docs/spec/platform/notemd-desktop.md`、`ios.md`、`later.md`

**Interfaces:**
- Consumes: 任务 3 的 `host-contract v1`;任务 4 的 ADR 编号。

- [ ] **Step 1: 往 `check.sh` 加 `check_ios`**

断言 `docs/spec/platform/ios.md`:含 `M0` 到 `M5` 六个里程碑;含 `iOS 17`、`UniFFI`、`TextKit 2`、`session`;不含 `[已交付`;含 `扫码` 的行只能位于 `### 不做` 小节内。

- [ ] **Step 2: 运行,确认 `check_ios` 与 `check_files` 失败**

- [ ] **Step 3: 写 `notemd-desktop.md`**

小节:插件形态(manifest 要点:窗口 960×720、文件视图选择器、能力列表);vault 投影与外部修改的三方合并(主规范 §7);专用 Tab 与专注窗口共享会话、owner 交接(§8);宿主更新边界(§8.1 的三层表,改写成现行说法并链接契约文档);macOS 键位表(§2.4 的键位列)与 AppKit 实现要点;Linux/Omarchy 实现要点、与 macOS 的必要差异、Fcitx5 for Sumi 对接契约(来源:`sumi-ime-cross-platform.md`、`2026-11-10-sumi-omarchy-*.md`、`2026-11-10-sumi-fcitx-candidates.md`、`2026-11-10-sumi-macos-fcitx-bridge.md`、`2026-11-10-omarchy-plugin-shortcuts.md`、`2026-11-11-release-input-method-companion.md`、`2026-11-11-omarchy-amd64-ime-release.md`);Windows 未交付。

- [ ] **Step 4: 写 `ios.md`**

把设计 §10 展开成规范,全部 `[计划:iOS]`。小节:范围(做);`### 不做`;架构(四层图与每层职责,链接 ADR 0010、0012);编辑事务的形状;存储位置与钥匙串;配对流程(粘贴邀请文本、填写服务地址);键盘避让与硬件键盘;导出;里程碑 M0–M5 及各自的验证口径;为公开发行留的口子;前置条件(第 3 期完成)。

- [ ] **Step 5: 写 `later.md`**

小节:Windows、Android、ESP32(保留主规范 §6.4 的定位与“硬件未选定”的事实)、桌面独立应用(设计 §9 的三条标准)。全部 `[未定]`。

- [ ] **Step 6: 运行 `bash docs/check.sh`,确认 `check_ios` 及三个文件的其余检查通过**

- [ ] **Step 7: 提交**

```bash
git add docs && git commit -m "Write spec: platform appendices for desktop, iOS and later"
```

---

### Task 8: 对照表 `MAPPING.md` 与全量核对

**Files:**
- Create: `docs/spec/MAPPING.md`
- Modify: 任务 5–7 的规范文件(补漏)

**Interfaces:**
- Consumes: 旧文档集;任务 5–7 的全部规范文件。

- [ ] **Step 1: 往 `check.sh` 加 `check_mapping`**

对旧文档集里的每个文件:文件名必须出现在 `MAPPING.md`;主规范的每个 `## ` 标题文字(`grep '^## ' 主规范`)必须出现在 `MAPPING.md`。

- [ ] **Step 2: 运行,确认 `check_mapping` 失败**

- [ ] **Step 3: 写 `MAPPING.md`**

一张表,四列:旧文档、旧章节、去向、说明。去向只有三种:新规范的文件与小节;`已退役`(写明被哪个后来的决定取代);`留在 note.md`(发布流水、验收证据、实施过程)。主规范按二级标题逐行列;§2 按三级标题拆到 §2.1–§2.5;其余旧文档每份至少一行。

- [ ] **Step 4: 逐行核对并补漏**

对每个去向为“新规范”的行,打开目标小节确认内容确实在;缺的补进对应规范文件。对每个 `已退役` 行,确认其内容没有出现在正文。

- [ ] **Step 5: 运行 `bash docs/check.sh`,确认 `check_mapping`、`check_status`、`check_retired`、`check_links` 全部通过**

- [ ] **Step 6: 提交**

```bash
git add docs && git commit -m "Add mapping from legacy specs and fill gaps"
```

---

### Task 9: 交接总览、迁移计划、已知缺口

**Files:**
- Create: `docs/handoff/00-overview.md`、`02-migration-plan.md`、`04-known-gaps.md`
- Modify: `README.md`(核对链接与期次)

**Interfaces:**
- Consumes: 任务 2 的清单、任务 3 的契约、任务 5–8 中记下的出入。

- [ ] **Step 1: 往 `check.sh` 加 `check_plan`**

断言 `02-migration-plan.md` 含 `## 第 1 期` 至 `## 第 5 期` 五个标题,且第 1、2、3 期各含 `前置条件`、`步骤`、`验证`、`回退` 四个小标题;`04-known-gaps.md` 含 `P1` 至 `P10`。

- [ ] **Step 2: 运行,确认 `check_plan` 失败**

- [ ] **Step 3: 写 `00-overview.md`**

为什么拆;拆成什么样(归属的一句话与一张简图);当前状态(第 0 期完成了什么、代码仍全在 note.md);五期路线一览;阅读顺序。一页以内。

- [ ] **Step 4: 写 `02-migration-plan.md`**

五期,内容取自设计 §8、§9、§10.3。第 1–3 期各写四小节:

- 第 1 期 **步骤** 要点:在源仓库的全新克隆上用 `git filter-repo` 按路径提取 `write-core`、`sumi-protocol`、`write-sync-worker` 并改名为 `core/`、`protocol/`、`sync/`;同步服务解开任务 2 列出的四处依赖;许可声明改为 Apache-2.0;打 `core-v0.1.0` tag;源仓库把三处 path 依赖(`src-tauri/Cargo.toml`、`plugins-src/write/backend/Cargo.toml`、`scripts/sumi/native/Cargo.toml`)改为 git tag 依赖并删除原目录;旧文档集每份文首加指引;启用本仓库中英两份 CHANGELOG。**验证**:三个模块各自的测试与 clippy 命令(抄自各 README);源仓库宿主与插件构建、现有 Sumi 测试。**回退**:源仓库 revert 依赖改动的那一次提交即可恢复,因目录删除与依赖切换在同一提交。
- 第 2 期 **步骤** 要点:迁插件壳、资源、任务 2 判定归 sumiwrite 的脚本、`i18n.ts`;插件壳按 tag 引用 `notemd-plugin-sdk`;定下 `shortcuts.ts` 的共享方式;源仓库 `release_sumi()` 改为从 sumiwrite 的固定 tag 取构建物。**验证**:从 sumiwrite 构建的包在正式宿主上安装并跑通现有验收清单。
- 第 3 期 **步骤** 要点:按任务 2 的逐文件判定,把会话与同步协调下沉到 `session/`;约束是 `session/` 不依赖 Tauri 与插件 SDK。**验证**:桌面行为不变,`lifecycle_tests.rs`、`recovery_tests.rs` 及后台测试全过。
- 第 4 期链接 `docs/spec/platform/ios.md` 的里程碑;第 5 期写设计 §9 的三条标准。

写明:第 1–3 期开工前各自另立详细计划,本文件只定顺序与验收口径。

- [ ] **Step 5: 写 `04-known-gaps.md`**

四节:体验对齐清单 P1–P10 的现状(来源 `2026-11-11-sumi-platform-parity.md`,逐项对照之后的 CHANGELOG 与报告判断是否已解决,判断不了的写“未核实”);主规范 §10 的未决决策;未交付平台;本期执行中发现的出入(任务 5–8 里记下的,例如主题数量)。

- [ ] **Step 6: 核对 `README.md`** 的仓库地图、期次、链接与实际一致。

- [ ] **Step 7: 运行 `bash docs/check.sh`**

Expected: 输出 `OK`,退出码 0。

- [ ] **Step 8: 提交**

```bash
git add -A && git commit -m "Add handoff overview, migration plan and known gaps"
```

---

### Task 10: 在源仓库提交设计与计划

**Files:**
- Commit(源仓库): `docs/superpowers/specs/2026-11-18-sumiwrite-extraction-design.md`、`docs/superpowers/plans/2026-11-18-sumiwrite-phase0-docs.md`

- [ ] **Step 1: 确认源仓库除这两个文件外没有改动**

Run: `cd ~/git/note.md && git status --short`
Expected: 只有这两个 `??` 条目。出现别的就停下报告,不要提交。

- [ ] **Step 2: 把设计文档的状态行改为“已批准,第 0 期已完成”**

- [ ] **Step 3: 在分支上提交,不 push**

```bash
git switch -c docs/sumiwrite-extraction
git add docs/superpowers/specs/2026-11-18-sumiwrite-extraction-design.md docs/superpowers/plans/2026-11-18-sumiwrite-phase0-docs.md
git commit -m "docs: design and phase 0 plan for extracting Sumi Write"
```

这两份是内部设计文档,不涉及用户可感知的变化,不写 CHANGELOG 条目。

- [ ] **Step 4: 向用户汇报**:两个仓库各自的提交、`docs/check.sh` 的最终输出、`04-known-gaps.md` 里记下的出入、以及是否合并分支与何时建远端由用户决定。
