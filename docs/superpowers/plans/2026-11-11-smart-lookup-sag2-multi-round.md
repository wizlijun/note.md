# 智能查找 SAG2 多轮证据检索与简答 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 SAG-Wiki `61f63c6` 的 SAG2 V10 `retrieve_inner` 逐步移植进智能查找：本地结果之上新增逐轮更新的「证据」区（第 0 轮 BM25 池 + 至多 2 轮按证据扩展），最后加上由用户点按的、带引用校验的简答。

**Architecture:** `searchidx` 新增只读入口 `SagReader`（独立只读连接，不占主索引锁），提供 SAG2 需要的 BM25 候选、存在性、文档频率、索引代次和别名来源。`src-tauri/src/smart_enhance/sag/` 是纯移植：文本函数、扩展词、别名修复与多样化、Jev 分批、逐轮状态机；状态机只依赖 `SagIndex` 与 `Scorer` 两个 trait，因而能用 SAG2 的 oracle 夹具在真实临时索引上验证。`smart_enhance/evidence.rs` 是命令层：保密与回源过滤、同意、自动名额、预算、取消、把状态挂在查找运行上。窗口每轮调一次 `smart_lookup_evidence_step`。

**Tech Stack:** Rust（Tauri 2、tokio、reqwest、rusqlite/FTS5、jieba-rs 0.10、新增 `icu_collator`/`icu_locid` 1.5、`fancy-regex` 0.16，`indexmap` 2 与 `regex` 1 改为直接依赖）；Svelte 5 + TypeScript；Vitest。

**Spec:** `docs/superpowers/specs/2026-11-10-smart-lookup-local-first-feasibility-design.md` 附录 H（以它为准，其次附录 F、G）。H.3 的每一小节是对应任务的算法定义，本计划不重复公式，只给接口、测试和数值。

**参考代码：** `/home/claude/wizlijun/SAG-Wiki`（`61f63c6`）。移植的每个 Rust 文件头写：

```rust
// Ported from SAG-Wiki 61f63c6 `core/src/<file>.rs` (<functions>), MIT License,
// Copyright (c) 2026 sag contributors. Changes for note.md: see spec Appendix H.
```

## Global Constraints

- 确定性（H.3 开头）：给定索引代次、问题、参数和 Jev 分数，请求与结果逐字节相同。所有排序稳定；同分按 H.3 给出的次级键；`HashMap` 的遍历顺序不得影响任何输出（需要有序时用 `IndexMap` 或 `BTreeSet`）。
- `searchidx` 不改 schema、不改 `tokenize`/`TOKENIZER_ID`、不改现有查询的打分与路由；只新增 `sag.rs`、`query::free_text`、`frontmatter.aliases`、`tokenize::pos_names`，并把 `query::push_filters` 放宽为 `pub(crate)`。`notemd search`、MCP 检索、侧栏、输入预览不变。
- 只发行级块、逐块 `current_block` 回源核对；`confidentiality` 只有 `unknown`、`explicitly_public` 可发；不发路径；按主机同意（Jev 用 `gate_jev`，简答的修复模型主机用 `consent_matches`）。每一轮都适用，包括扩展轮。
- 每次回车至多 `1 + retrieval.maxHops` 轮自动 Jev 轮次，第 0 轮领取 `claim_auto_request`；不重试、不拆批；每轮一个截止时间 `retrieval.roundTimeoutMs`（默认 10,000）；整次查找估算 token 不超过 `budget.maxTokensPerLookup`（默认 200,000）。
- 远端文字不展示、不写日志，简答正文除外（H.4），简答也不写日志。
- SAG2 常量逐字：`CRITERION`、真假判据、`SCORE_NOTE`、`STOPS`、`ANSWER_SYSTEM`、`agent.rs` L416 与 L431 两条修正提示（从参考代码复制，不手打）。
- 新的 Rust 模块与命令只在桌面端编译（`#[cfg(not(target_os = "ios"))]`，与 `smart_enhance` 现有做法一致）。
- i18n 新键四个语言文件都加（`src/lib/i18n/zh.ts`、`en.ts`、`de.ts`、`ja.ts`；`en.ts` 是类型来源）。
- 用户可见变化写进 `CHANGELOG.md` 与 `CHANGELOG.zh-CN.md` 的「未发布」区，`node scripts/changelog.mjs check` 通过。
- 测试命令（仓库根目录）：
  - 宿主：`CARGO_INCREMENTAL=0 RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml --lib -- <过滤词…>`（只用 `--lib`：集成测试二进制会撑满磁盘）
  - searchidx：`cargo test --manifest-path searchidx/Cargo.toml <过滤词>`
  - 前端：`./node_modules/.bin/vitest run <文件…>`；类型：`./node_modules/.bin/svelte-check --tsconfig ./tsconfig.json --threshold error`
- 既有失败不是本计划的事：约 69 个 Rust 失败在 `project_share`、`project_share_git`、`cli::doctor`、`knowledge_structure`、`cli::builtin` market、`share_guest`；4 个前端文件（linux-bundle、release-plugins、rich-editor-focus、project-share browser）。只跑列出的过滤词，不跑全量，不修它们。
- 提交：`git -c user.name=wizlijun -c user.email=me@bruce.com commit`，信息结尾：

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Xhk51Qro1be96URg7VeNwe
```

  不推送。

## Review Focus

1. 一个 confidential 文件只在扩展轮被召回（第 0 轮没有它）：它的原文从不出现在任何请求里，`skippedConfidential` 计数增加。测试在 Task 7（`expansion_candidates_from_confidential_files_are_never_sent`）。
2. 两轮之间文件被编辑、索引提交：下一轮在发请求之前停止，原因 `indexChanged`，旧的块 id 不再被使用。测试在 Task 7（`an_index_commit_between_rounds_stops_with_index_changed`）。
3. 第 1 轮请求在途时用户按「停止」或再次回车：第 1 轮作废，不再有第 2 轮，证据保持第 0 轮的结果。测试在 Task 8（`stop_during_round_one_keeps_round_zero_evidence_and_sends_no_more`）。
4. 问题只有停用词和过滤词（如 `tag:x 的`）：`noTerms`，不发请求，不领取自动名额。测试在 Task 7（`a_question_without_terms_sends_nothing`）。
5. 第 1 轮的估算会让整次查找超出 `budget.maxTokensPerLookup`：该轮不发送，原因 `budget`，第 0 轮证据保留。测试在 Task 8（`a_round_that_would_exceed_the_lookup_budget_is_not_sent`）。

## 文件结构

| 文件 | 职责 | 任务 |
| --- | --- | --- |
| `searchidx/src/sag.rs`（新） | `SagReader`：只读连接、代次、块数、文档频率缓存、BM25 候选、存在性、保密、别名来源、frontmatter 别名读取 | 1 |
| `searchidx/src/query.rs` | `free_text`；`push_filters` → `pub(crate)` | 1 |
| `searchidx/src/frontmatter.rs` | `Frontmatter.aliases`（按 `tags` 的规则解析） | 1 |
| `searchidx/src/tokenize.rs` | `pos_names`（jieba `tag`，`nr/ns/nt/nz`） | 2 |
| `src-tauri/src/smart_enhance/sag/mod.rs`（新） | 共用类型与 SAG2 常量 | 2 |
| `src-tauri/src/smart_enhance/sag/text.rs`（新） | `sag_tokens`、`quote`、`match_query`、`sentences`、`name_phrases`、实体片段与合并、`alias_pattern` | 2 |
| `src-tauri/src/smart_enhance/sag/terms.rs`（新） | `expansion_terms`、`interleave`、`rank`、`term_cmp`（ICU） | 3 |
| `src-tauri/src/smart_enhance/sag/corpus.rs`（新） | `folded`、`AliasMap`（构建、`repair`、`resolve_terms`）、`diversify`、`words` | 4 |
| `src-tauri/src/smart_enhance/sag/jev.rs`（新） | `state` 编码、问题、`estimate_value`、`jev_batches`、`score_round` | 5 |
| `src-tauri/src/lookup_params.rs`、`docs/smart-lookup-parameters.md` | 新参数组与文档 | 6 |
| `src-tauri/src/smart_enhance/sag/round.rs`（新） | `EvidenceState`、`step`、`SagIndex`/`Scorer` trait、`ReaderIndex` 适配器（回源与保密过滤） | 7 |
| `src-tauri/src/smart_enhance/sag/fixtures/`（新） | 原样复制的 `sag2_v10_oracle.json`、`sag2_v10_dpp.json` 与 `NOTICE`（来源提交、MIT） | 4、7 |
| `src-tauri/src/smart_enhance/evidence.rs`（新） | 命令 `smart_lookup_evidence_step`、DTO、名额、预算、取消、读者缓存 | 8 |
| `src-tauri/src/smart_lookup.rs` | `LookupRun.evidence` | 8 |
| `src-tauri/src/smart_enhance/{mod.rs,feedback.rs,pipeline.rs}` | 新状态值；证据行纠正；CLI 链路的判断路由改走证据 | 8 |
| `src-tauri/src/search/smart_eval.rs`、`src-tauri/src/cli/lookup.rs` | 逐轮指标、C5、新 `finalRank` | 9 |
| `src/lib/smart-search/{api.ts,evidence-flow.ts（新）,settings.ts}` | 线类型、证据区纯状态、修复模型同意主机 | 10 |
| `src/SmartLookupApp.svelte` | 「证据」区 | 11 |
| `src-tauri/src/smart_enhance/answer.rs`（新）、`src-tauri/src/smart_model.rs` | 简答 | 12 |

## 任务顺序与并行

| 任务 | 依赖 | 可并行 |
| --- | --- | --- |
| 1 `SagReader` | — | 与 2、6、10 并行 |
| 2 文本函数与类型 | — | 与 1、6、10 并行 |
| 3 扩展词、交错、排序 | 2 | 与 4、5 并行 |
| 4 别名修复与多样化 | 2 | 与 3、5 并行 |
| 5 Jev 分批与打分 | 2 | 与 3、4 并行 |
| 6 参数与文档 | — | 与 1、2、10 并行 |
| 7 逐轮状态机与 oracle | 1、3、4、5、6 | — |
| 8 命令、查找运行、CLI 链路 | 7 | 与 10 并行 |
| 9 评测与 C5 | 8 | 与 11 并行 |
| 10 前端线类型与纯状态 | 无（按本计划的线类型写） | 与 1–9 并行 |
| 11 「证据」区界面 | 8、10 | 与 9 并行 |
| 12 简答 | 8、11 | 最后 |

并行的任务各在独立 worktree 里做；1 与 2 都改 `searchidx`，但文件不重叠（2 只动 `tokenize.rs`）。

---

### Task 1: `searchidx` 只读入口 `SagReader`

**Files:**
- Create: `searchidx/src/sag.rs`
- Modify: `searchidx/src/lib.rs`（`pub mod sag;`）、`searchidx/src/query.rs`（`free_text`、`push_filters` 可见性）、`searchidx/src/frontmatter.rs`（`aliases`）

**Interfaces:**
- Produces（全部 `pub`，在 `searchidx::sag`）：

```rust
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Level { Line, File }
pub struct CandidateQuery<'a> {
    pub expression: &'a str, pub required: Option<&'a str>,
    pub filters: &'a crate::query::Query, pub excluded: &'a [i64], pub limit: usize,
}
#[derive(Clone, Debug, PartialEq)]
pub struct SagRow { pub id: i64, pub path: String, pub line: u32, pub line_end: u32, pub breadcrumb: String, pub text: String, pub bm25: f64 }
pub struct AliasSources { pub files: Vec<FileTitle>, pub wiki_targets: Vec<String> }
pub struct FileTitle { pub path: String, pub title: Option<String>, pub ext: String }
pub struct SagReader { /* conns: Vec<Mutex<Connection>>, df cache */ }
impl SagReader {
    pub fn open_existing_at(root: &Path, db: &Path, globs_stamp: &str, workers: usize) -> Result<Self, String>;
    pub fn generation(&self) -> Result<i64, String>;                       // PRAGMA data_version on conns[0]
    pub fn block_count(&self, level: Level) -> Result<u64, String>;
    pub fn frequencies(&self, terms: &[String], level: Level) -> Result<HashMap<String, u64>, String>;
    pub fn candidate_query(&self, q: &CandidateQuery<'_>) -> Result<Vec<SagRow>, String>;
    pub fn has_match(&self, expression: &str, filters: &crate::query::Query, excluded: &[i64]) -> Result<bool, String>;
    pub fn confidentiality_for_paths(&self, paths: &[&str]) -> Result<HashMap<String, String>, String>;
    pub fn alias_sources(&self) -> Result<AliasSources, String>;            // files ORDER BY path; wiki targets DISTINCT ORDER BY target
}
/// Reads at most the first 64 KiB of each listed markdown file; files that fail to read are skipped.
pub fn frontmatter_aliases(root: &Path, md_paths: &[String]) -> Vec<(String, Vec<String>)>;
// query.rs
pub fn free_text(raw: &str) -> String;
// frontmatter.rs: Frontmatter gains `pub aliases: Vec<String>`
```

- [ ] **Step 1: 写失败的测试**（`sag.rs` 的 `#[cfg(test)]`；用现有测试的建索引方式：临时目录、`SearchIndex::open_at(root, db, "")`、对每个文件 `index_one(rel, &ScanOptions::default())`，再 `SagReader::open_existing_at(root, db, "", 2)`）

```rust
// a.md = "alpha beta\n\nalpha gamma\n"，b.md = "---\ntitle: Bee\naliases: [B1, 别名]\n---\nbeta [[Target Page|tp]]\n"
#[test] fn counts_line_and_file_blocks_and_frequencies() {
    assert_eq!(r.block_count(Level::Line).unwrap(), 3);
    assert_eq!(r.block_count(Level::File).unwrap(), 2);
    let f = r.frequencies(&s(&["alpha", "beta", "alpha beta", "zeta"]), Level::Line).unwrap();
    assert_eq!((f["alpha"], f["beta"], f["alpha beta"], f["zeta"]), (2, 2, 1, 0));
    let f = r.frequencies(&s(&["alpha", "beta"]), Level::File).unwrap();
    assert_eq!((f["alpha"], f["beta"]), (1, 2));
}
#[test] fn candidate_query_is_line_level_bm25_then_id_with_exclusions_and_required() {
    let all = r.candidate_query(&q("\"alpha\" OR \"beta\"", None, &[], 10)).unwrap();
    assert!(all.iter().all(|row| row.line == row.line_end));          // 只有行级块
    assert_eq!(all.len(), 3);
    assert!(all.windows(2).all(|w| (w[0].bm25, w[0].id) <= (w[1].bm25, w[1].id)));
    let ex = r.candidate_query(&q("\"alpha\" OR \"beta\"", None, &[all[0].id], 10)).unwrap();
    assert!(!ex.iter().any(|row| row.id == all[0].id));
    let req = r.candidate_query(&q("\"alpha\" OR \"beta\"", Some("\"gamma\""), &[], 10)).unwrap();
    assert_eq!(req.iter().map(|r| r.text.as_str()).collect::<Vec<_>>(), vec!["alpha gamma"]);
    // 必含词不参与计分：与只用排序式时该行的 bm25 相同
    assert_eq!(req[0].bm25, all.iter().find(|x| x.text == "alpha gamma").unwrap().bm25);
}
#[test] fn has_match_respects_exclusions_and_filters() { /* "\"gamma\"" true；排除该行后 false；filters = parse("path:b.md") 时 "\"alpha\"" false */ }
#[test] fn generation_changes_after_another_connection_commits() { /* g0 = generation()；主连接 index_one 改写 a.md；generation() != g0 */ }
#[test] fn alias_sources_and_frontmatter_aliases() {
    let a = r.alias_sources().unwrap();
    assert_eq!(a.files.iter().map(|f| (f.path.as_str(), f.title.as_deref())).collect::<Vec<_>>(), vec![("a.md", None), ("b.md", Some("Bee"))]);
    assert_eq!(a.wiki_targets, vec!["Target Page".to_string()]);
    assert_eq!(frontmatter_aliases(root, &s(&["a.md", "b.md", "missing.md"])), vec![("a.md".into(), vec![]), ("b.md".into(), s(&["B1", "别名"]))]);
}
#[test] fn free_text_drops_filter_tokens_and_keeps_phrases() {
    assert_eq!(crate::query::free_text("tag:x 张三 \"Bob Smith\" after:2026-01-01 born"), "张三 Bob Smith born");
}
```

- [ ] **Step 2: 运行，确认失败**

Run: `cargo test --manifest-path searchidx/Cargo.toml sag::`
Expected: FAIL（`sag` 模块不存在）

- [ ] **Step 3: 实现**
  - 打开方式与 `snapshot.rs:open_existing_at` 相同（只读、`busy_timeout` 2 秒、核对 `schema_version`、`tokenizer_id`、`source_globs`、`vault_root`），开 `workers` 条连接。
  - `candidate_query` 的 SQL 就是 spec H.3.3 的那条；`?1` 排序式、`?2` 排除 id 的升序 JSON 数组、有必含词时 `?3`，之后 `push_filters(q.filters, …)` 追加，`LIMIT` 像 `fts_arms` 一样格式化成整数。
  - `has_match`：`SELECT EXISTS(SELECT 1 FROM blocks_fts JOIN blocks b … WHERE blocks_fts MATCH ?1 AND b.level='line' AND rowid NOT IN … [filters])`。
  - `frequencies`：`SELECT count(*) FROM blocks_fts JOIN blocks b ON b.id = blocks_fts.rowid WHERE blocks_fts MATCH ?1 AND b.level = ?2`，`?1 = format!("tok_text : {}", quote(term))`（`quote` 规则见 H.3.2，此处内联一份私有实现）。缓存键 `(Level, String)`，记下所属 `generation`，代次不同就清空；超过 200,000 条整体清空；缺失的词按下标轮转分给各连接，在 `std::thread::scope` 里并行，结果合并顺序无关。
  - `free_text`：沿用 `split_respecting_quotes` 与 `parse` 的分类，非过滤的词元按原顺序保留，闭合引号短语只取引号内文字，空格连接。
  - `aliases` 的解析与 `tags` 完全相同（内联列表或块列表）。

- [ ] **Step 4: 运行，确认通过**

Run: `cargo test --manifest-path searchidx/Cargo.toml sag:: free_text frontmatter`
Expected: PASS

- [ ] **Step 5: 提交** `feat(searchidx): read-only SagReader for SAG2 retrieval`

### Task 2: SAG2 文本函数与共用类型

**Files:**
- Create: `src-tauri/src/smart_enhance/sag/mod.rs`、`src-tauri/src/smart_enhance/sag/text.rs`
- Modify: `src-tauri/src/smart_enhance/mod.rs`（`pub(crate) mod sag;`）、`src-tauri/Cargo.toml`（`fancy-regex = "0.16"`、`regex = "1"`、`indexmap = "2"`）、`searchidx/src/tokenize.rs`

**Interfaces:**
- Produces：

```rust
// sag/mod.rs —— 类型与 spec H.3「共用类型」逐字一致
pub(crate) struct SagCandidate { pub id: i64, pub path: String, pub line: u32, pub line_end: u32, pub title: String, pub heading: String, pub content: String, pub bm25: f64, pub score: f64, pub previous_score: Option<f64>, pub order: usize }  // #[derive(Clone, Debug, PartialEq)]
pub(crate) enum TermKind { Word, NamePhrase }                              // serde camelCase: "word" | "namePhrase"
pub(crate) struct Term { pub term: String, pub kind: TermKind, pub score: f64, pub label: String }
pub(crate) struct Trace { pub hop: u8, pub candidates: Vec<i64>, pub terms: Vec<Term>, pub evidence: Vec<i64> }
pub(crate) const CRITERION: &str; pub(crate) const CRITERIA_TRUE: &str; pub(crate) const CRITERIA_FALSE: &str;
pub(crate) const SCORE_NOTE: &str; pub(crate) const STOPS: &[&str];      // 从 sag2_v10.rs、models.rs L245、text.rs 复制
pub(crate) const HOP2_INCOMING: usize = 20; pub(crate) const HOP2_EVIDENCE: usize = 10;
// sag/text.rs
pub(crate) fn sag_tokens(text: &str) -> Vec<String>;                     // searchidx::tokenize::tokens，去 STOPS，留含字母或数字的
pub(crate) fn quote(text: &str) -> String;
pub(crate) fn match_query(text: &str) -> String;                          // 去重、前 80 个
pub(crate) fn sentences(text: &str) -> Vec<&str>;
pub(crate) struct NameSpan { pub start: usize, pub end: usize, pub term: String, pub label: String }
pub(crate) fn name_spans(sentence: &str, aliases: Option<&fancy_regex::Regex>) -> Vec<NameSpan>;  // H.3.4 的五种来源合并后
pub(crate) fn alias_pattern(keys: &[String]) -> Option<fancy_regex::Regex>; // H.3.1 的排序与逐键边界规则
// searchidx/src/tokenize.rs
pub fn pos_names(text: &str) -> Vec<(usize, usize, String)>;            // 字节偏移；只留 nr/ns/nt/nz 且含汉字
```

- [ ] **Step 1: 写失败的测试**（`text.rs`）

```rust
#[test] fn sentence_boundaries_preserve_english_initials_and_split_chinese() {   // 移植自 retrieval.rs
    assert_eq!(sentences("台风登陆。救援开始！人员安全吗？仍在核查"), vec!["台风登陆", "救援开始", "人员安全吗", "仍在核查"]);
    assert_eq!(sentences("J. R. Smith arrived. Help! Why?\nNext"), vec!["J. R. Smith arrived", "Help", "Why", "Next"]);
}
#[test] fn names_keep_initials_and_boundaries() {                                 // 移植
    let n = name_spans("J. R. Smith met Mary-Jane Watson. A city called New York", None);
    assert_eq!(n.len(), 3); assert!(n[0].term.contains("smith"));
}
#[test] fn sag_tokens_drop_stops_and_match_query_dedupes() {
    assert_eq!(sag_tokens("Where was Alice born?"), vec!["alice", "born"]);
    assert_eq!(match_query("alice Alice born"), "\"alice\" OR \"born\"");
    assert_eq!(quote("a\"b"), "\"a\"\"b\"");
    let many = (0..90).map(|i| format!("w{i}")).collect::<Vec<_>>().join(" ");
    assert_eq!(match_query(&many).matches(" OR ").count(), 79);
}
#[test] fn entity_spans_merge_without_overlap() {
    let s = "见 [[Target Page|tp]] 与 #项目/甲 在北京";
    let n = name_spans(s, None);
    assert_eq!(n.iter().map(|x| x.term.as_str()).collect::<Vec<_>>(), vec!["target page", "项目 甲", "北京"]);
    assert_eq!(n[0].label, "Target Page");
}
#[test] fn chinese_alias_keys_match_inside_chinese_text() {
    let re = alias_pattern(&["清华".into(), "sag".into()]).unwrap();
    assert!(re.is_match("我在清华读书").unwrap());
    assert!(!re.is_match("usage").unwrap());
}
// searchidx/src/tokenize.rs
#[test] fn pos_names_keep_person_place_and_organisation() {
    let n: Vec<String> = pos_names("鲁迅在北京的清华大学").into_iter().map(|t| t.2).collect();
    assert_eq!(n, vec!["鲁迅", "北京", "清华大学"]);   // dict: 鲁迅 nr、北京 ns、清华大学 nt
}
```

- [ ] **Step 2: 运行，确认失败**

Run: `CARGO_INCREMENTAL=0 RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml --lib -- smart_enhance::sag::text` 与 `cargo test --manifest-path searchidx/Cargo.toml pos_names`
Expected: FAIL（未定义）

- [ ] **Step 3: 实现** 正则 `SENTENCES`、`NAMES` 原样从 `retrieval.rs` 复制到 `fancy_regex`；`name_spans` 按 H.3.4 表格收集并按（起点升、终点降、来源次序）合并；`pos_names` 用 `tokenize.rs` 里已有的 `jieba()` 单例调用 `tag(text, true)`，把字符位置换成字节偏移。

- [ ] **Step 4: 运行，确认通过**（同 Step 2 的命令）Expected: PASS

- [ ] **Step 5: 提交** `feat(smart-lookup): SAG2 text primitives`

### Task 3: 扩展词、交错与排序

**Files:**
- Create: `src-tauri/src/smart_enhance/sag/terms.rs`
- Modify: `src-tauri/Cargo.toml`（`icu_collator = "1.5"`、`icu_locid = "1.5"`）

**Interfaces:**
- Consumes：Task 2 的 `SagCandidate`、`Term`、`sag_tokens`、`sentences`、`name_spans`
- Produces：

```rust
pub(crate) trait TermStats { fn total(&self) -> Result<f64, String>; fn df(&self, terms: &[String]) -> Result<HashMap<String, u64>, String>; }
pub(crate) fn expansion_terms(query: &str, seeds: &[SagCandidate], limit: usize, aliases: Option<&fancy_regex::Regex>, stats: &dyn TermStats) -> Result<Vec<Term>, String>;
pub(crate) fn interleave(lists: Vec<Vec<SagCandidate>>, limit: usize) -> Vec<SagCandidate>;
pub(crate) fn rank(candidates: Vec<SagCandidate>) -> Vec<SagCandidate>;
pub(crate) fn term_cmp(a: &str, b: &str) -> std::cmp::Ordering;          // ICU en，相等再按字节
```

- [ ] **Step 1: 写失败的测试**

```rust
struct Fixed(f64, HashMap<String, u64>);   // TermStats：total = 100，df 表如下
// df: alice 5, born 10, moved 20, paris 4, hosts 30, louvre 2, eiffel 2, lyon 0, has 50, "bob smith" 3
#[test] fn expansion_terms_match_hand_computed_scores() {
    let s1 = seed(0.8, "Alice moved to Paris. Paris hosts the Louvre and Eiffel.");
    let s2 = seed(0.4, "Bob Smith was born in Lyon.\nLyon has Bob Smith.");
    let t = expansion_terms("Where was Alice born", &[s1, s2], 20, None, &fixed()).unwrap();
    let got: Vec<(&str, TermKind)> = t.iter().map(|t| (t.term.as_str(), t.kind)).collect();
    assert_eq!(got, vec![("paris", Word), ("bob smith", NamePhrase), ("moved", Word), ("eiffel", Word), ("louvre", Word), ("hosts", Word), ("has", Word)]);
    for (t, want) in t.iter().zip([20.597706428915263, 13.935293593950192, 6.235853819911771, 3.6988297849671046, 3.6988297849671046, 1.1973938332278935, 0.5198603854199589]) {
        assert!((t.score - want).abs() < 1e-12, "{} {}", t.term, t.score);
    }
    assert_eq!(expansion_terms("Where was Alice born", &[s1.clone(), s2.clone()], 5, None, &fixed()).unwrap().len(), 5);
    assert_eq!(t[1].label, "Bob Smith");
}
#[test] fn interleaves_rank_then_term_and_deduplicates() {                         // 移植
    assert_eq!(ids(&interleave(vec![vec![c(1), c(3), c(4)], vec![c(2), c(3), c(5)]], 5)), vec![1, 2, 3, 4, 5]);
}
#[test] fn rank_orders_score_then_order_then_id() { /* (0.5,o2,id9),(0.5,o1,id7),(0.9,o3,id1),(0.5,o1,id3) → ids [1,3,7,9] */ }
#[test] fn term_cmp_uses_icu_not_bytes() {
    assert_eq!(term_cmp("café", "cafez"), Less);   // 字节序相反
    assert_eq!(term_cmp("a1", "ab"), Less);
    assert_eq!(term_cmp("zeta", "北京"), Less);
}
```

  手算依据：`idf(t) = ln(1 + (100 − df + 0.5)/(df + 0.5))`；`s1` 权重 1.0、`s2` 0.75；`alice`、`born` 是查询词被跳过，`lyon` 的 df 为 0 被跳过；`eiffel` 与 `louvre` 同分，按 ICU 排序。

  中文上下文的移植测试要真实索引，放在 Task 7。

- [ ] **Step 2: 运行，确认失败**

Run: `CARGO_INCREMENTAL=0 RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml --lib -- smart_enhance::sag::terms`
Expected: FAIL

- [ ] **Step 3: 实现** 按 H.3.4 逐行移植 `expansion_terms`；`ranked` 用 `HashMap` 收集后整体按（score 降序、`term_cmp`）排序，所以收集顺序不影响输出。`Collator::try_new(&locale!("en").into(), CollatorOptions::new())` 放在 `thread_local!` 里，每个线程一个（`icu_collator` 1.5 的 `Collator` 不是 `Sync`，不能放进 `OnceLock`；开启它的 `sync` 特性要改 Cargo 文件，P3 不允许）；输出与共享一个实例相同。

- [ ] **Step 4: 运行，确认通过**（同上）Expected: PASS

- [ ] **Step 5: 提交** `feat(smart-lookup): port SAG2 expansion terms, interleave and rank`

### Task 4: 别名修复与多样化

**Files:**
- Create: `src-tauri/src/smart_enhance/sag/corpus.rs`、`src-tauri/src/smart_enhance/sag/fixtures/sag2_v10_dpp.json`（从 `SAG-Wiki/tests/` 原样复制）、`src-tauri/src/smart_enhance/sag/fixtures/NOTICE`

**Interfaces:**
- Consumes：Task 2 的 `sag_tokens`、`alias_pattern`、`Term`、`SagCandidate`
- Produces：

```rust
pub(crate) fn folded(text: &str) -> String;                               // 逐字移植
pub(crate) struct AliasMap { /* aliases: HashMap<String,String>, pattern: Option<Regex>, titles: HashSet<String> */ }
impl AliasMap {
    pub(crate) fn build(titles: &[(String /*lower title*/)], aliases: &[(String /*alias*/, String /*lower title*/)], wiki_targets: &[String]) -> Self;
    pub(crate) fn pattern(&self) -> Option<&fancy_regex::Regex>;
    pub(crate) fn repair(&self, text: &str, has_hits: &mut dyn FnMut(&str) -> Result<bool, String>) -> Result<String, String>;
    pub(crate) fn resolve_terms(&self, terms: &mut [Term], has_hits: &mut dyn FnMut(&str) -> Result<bool, String>) -> Result<(), String>;
}
pub(crate) fn diversify(candidates: &mut Vec<SagCandidate>, vectorize: &dyn Fn(&str) -> Vec<String>, idf: &dyn Fn(&str) -> f64);
pub(crate) fn words(text: &str) -> Vec<String>;                           // to_lowercase 后的 [\p{L}\p{N}]+，测试用的参考向量化
```

- [ ] **Step 1: 写失败的测试**

```rust
#[test] fn recorded_final_rankings_match_python_v10() {                           // 移植，夹具原样
    for case in dpp_cases() {
        let idf: HashMap<String, f64> = case.idf;
        let mut c = case.candidates;                                               // id、content、score
        diversify(&mut c, &words, &|w| idf[w]);
        assert_eq!(ids(&c), case.expected_ids, "question {}", case.question_index);
    }
}
#[test] fn repair_rewrites_folded_title_and_frontmatter_alias_only_when_it_has_hits() {
    let m = AliasMap::build(&["rené descartes".into()], &[("SAG".into(), "search augmented generation".into())], &[]);
    let mut hits = |t: &str| Ok(t == "rené descartes" || t == "search augmented generation");
    assert_eq!(m.repair("Where was Rene Descartes born?", &mut hits).unwrap(), "Where was rené descartes born?");
    assert_eq!(m.repair("what is SAG", &mut hits).unwrap(), "what is search augmented generation");
    let mut none = |_: &str| Ok(false);
    assert_eq!(m.repair("what is SAG", &mut none).unwrap(), "what is SAG");
}
#[test] fn ambiguous_aliases_are_dropped() { /* 两个文件都声明别名 "x" → repair 不改写 */ }
#[test] fn unresolved_expansion_terms_preserve_connected_tokens() {              // 移植
    let m = AliasMap::build(&[], &[], &[]);
    let mut t = vec![term("half-ounce", Word), term("a.h", Word)];
    m.resolve_terms(&mut t, &mut |_| Ok(false)).unwrap();
    assert_eq!(t.iter().map(|t| t.term.as_str()).collect::<Vec<_>>(), vec!["half-ounce", "a.h"]);
}
#[test] fn name_phrase_falls_back_to_longest_title_subphrase() {
    let m = AliasMap::build(&["new jersey".into()], &[], &[]);
    let mut t = vec![term("bob new jersey", NamePhrase)];
    m.resolve_terms(&mut t, &mut |q: &str| Ok(q == "\"new jersey\"")).unwrap();
    assert_eq!(t[0].term, "new jersey");
}
```

- [ ] **Step 2: 运行，确认失败**

Run: `CARGO_INCREMENTAL=0 RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml --lib -- smart_enhance::sag::corpus`
Expected: FAIL

- [ ] **Step 3: 实现** `folded`、`diversify` 逐行移植 `sag2_v10.rs`（容差 `n × (f64::from_bits(max.to_bits() + 1) − max)`、`max_by` 的下标次序都照抄）；`build` 按 spec H.3.1 的三种来源与「唯一取值」规则；`resolve_terms` 里 `has_hits` 收到的是 `quote(term)`；`repair` 里收到的是 `quote(tokens.join(" "))`。

- [ ] **Step 4: 运行，确认通过**（同上）Expected: PASS

- [ ] **Step 5: 提交** `feat(smart-lookup): port SAG2 alias repair and DPP diversify`

### Task 5: Jev 请求、分批与一轮打分

**Files:**
- Create: `src-tauri/src/smart_enhance/sag/jev.rs`

**Interfaces:**
- Consumes：Task 2 的常量与 `SagCandidate`；`smart_model::{score_noul, JevConfig, NoulQuestion, ModelError}`；`candidates::estimate_tokens`；`CancelFlag`
- Produces：

```rust
pub(crate) enum Preset { Sag2V10, DirectMatch }                           // serde "sag2V10" | "directMatch"（Task 6 用）
pub(crate) struct StateExtras { pub explicit_filters: Vec<String>, pub time_range: Option<TimeRange> }
pub(crate) struct TimeRange { pub after: String, pub before: String, pub source_text: String }
pub(crate) fn encode_state(question: &str, evidence: &[SagCandidate], extras: &StateExtras) -> String;
pub(crate) fn question_for(c: &SagCandidate, preset: Preset, criterion: &str) -> NoulQuestion;   // id = "candidate_{id}"
pub(crate) fn estimate_value(v: &serde_json::Value, cjk: u32, other: u32) -> u64;
pub(crate) struct Batch { pub questions: Vec<NoulQuestion>, pub items: Vec<SagCandidate>, pub estimated: u64 }
pub(crate) enum BatchError { EvidenceTooLarge }
pub(crate) fn jev_batches(state: &str, pool: Vec<SagCandidate>, preset: Preset, criterion: &str, context_tokens: u64, cjk: u32, other: u32) -> Result<(Vec<Batch>, usize /*skipped oversize*/), BatchError>;
pub(crate) struct RoundScore { pub scored: Vec<SagCandidate>, pub requests: u32, pub usage: Option<(u64, u64)> }
pub(crate) async fn score_round(client: &reqwest::Client, jev: &JevConfig, key: Option<&str>, state: &str, batches: Vec<Batch>, deadline: Duration, cancel: &CancelFlag) -> Result<RoundScore, RoundError>;
pub(crate) enum RoundError { Model(ModelError), Cancelled }
```

- [ ] **Step 1: 写失败的测试**

```rust
#[test] fn state_matches_sag2_byte_for_byte() {
    // oracle 第 1 题第 3 个请求的 state（spec H.9），夹具字符串原样
    let ev = vec![ev("Multiple", "Alice Paul birthplace Bob Smith.", 0.95), ev("Anchor", "Anchor birthplace depicts Alice Paul. Alice Paul. Bob Smith.", 0.8),
                  ev("High", "Anchor highname commonname.", 0.7), ev("Series", "Anchor lowname commonname.", 0.08),
                  ev("Single", "Alice Paul birthplace missing text.", 0.01), ev("Record 0", "Bob Smith.", 0.01)];
    assert_eq!(encode_state("Anchor birthplace depicts", &ev, &StateExtras::default()), ORACLE_CASE1_REQ2_STATE);
    assert_eq!(encode_state("Anchor birthplace depicts", &[], &StateExtras::default()), r#"{"original_question":"Anchor birthplace depicts","previously_retrieved_evidence":[]}"#);
}
#[test] fn extras_follow_sag2_fields_and_are_omitted_when_empty() {
    let s = encode_state("q", &[], &StateExtras { explicit_filters: vec!["tag:x".into()], time_range: None });
    assert_eq!(s, r#"{"original_question":"q","previously_retrieved_evidence":[],"explicit_filters":["tag:x"]}"#);
}
#[test] fn question_shape_follows_preset() {
    let q = question_for(&cand(7, "T", "h1", "body"), Preset::Sag2V10, "ignored");
    assert_eq!(q.id, "candidate_7");
    assert_eq!(q.instructions, json!({"question": CRITERION, "candidate_title": "T", "candidate_passage": "body", "candidate_heading": "h1"}));
    assert_eq!((q.criteria_true.as_str(), q.criteria_false.as_str()), (CRITERIA_TRUE, CRITERIA_FALSE));
    let d = question_for(&cand(7, "T", "", "body"), Preset::DirectMatch, "准则");
    assert_eq!(d.instructions["question"], "准则"); assert!(d.instructions.get("candidate_heading").is_none());
}
#[test] fn batches_split_on_budget_skip_oversize_and_reject_large_evidence() {
    // context 2000：base = estimate(state)+1024；n = estimate(question)+64
    let (b, skipped) = jev_batches(&state, pool_of_sizes(&[200, 200, 5000, 200]), Preset::Sag2V10, "", 2000, 1, 4).unwrap();
    assert_eq!(skipped, 1);
    assert!(b.iter().all(|b| b.estimated <= 2000));
    assert_eq!(b.iter().flat_map(|b| b.items.iter().map(|c| c.id)).collect::<Vec<_>>(), vec![0, 1, 3]);  // 原顺序
    assert!(matches!(jev_batches(&huge_state, vec![], Preset::Sag2V10, "", 2000, 1, 4), Err(BatchError::EvidenceTooLarge)));
}
#[tokio::test] async fn a_failing_batch_fails_the_round_and_results_keep_batch_order() { /* 本机假服务：第 2 批 500 → Err(Model(Http(500)))；全部 200 → scored 按批次顺序，score = noul，requests = 批数 */ }
#[tokio::test] async fn one_deadline_covers_all_batches_and_cancel_wins() { /* 假服务延迟 300ms、deadline 100ms → Timeout；cancel 先触发 → Cancelled */ }
```

  `ORACLE_CASE1_REQ2_STATE` 从 `fixtures/sag2_v10_oracle.json` 的 `cases[0].requests[2].state` 读取（Task 7 复制该文件；本任务先复制它）。

- [ ] **Step 2: 运行，确认失败**

Run: `CARGO_INCREMENTAL=0 RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml --lib -- smart_enhance::sag::jev`
Expected: FAIL

- [ ] **Step 3: 实现** `encode_state` 用 `#[derive(Serialize)]` 结构体（字段顺序：`original_question`、`previously_retrieved_evidence`、`evidence_score_note`、`explicit_filters`、`time_range`；证据项：`title`、`passage`、`heading`、`previous_jev_score`；可选字段 `skip_serializing_if`），`serde_json::to_string`。分批规则照抄 `jev_batches_with_runtime`。`score_round` 每批一次 `score_noul`，最多 20 批同时在途（`futures::stream::iter(..).buffered(20)` 或 `tokio::task::JoinSet` 再按下标归位），整体包在 `tokio::time::timeout(deadline)` 和 `cancel.cancelled()` 的 `select!` 里；把 noul 写回每个 `SagCandidate.score`。

- [ ] **Step 4: 运行，确认通过**（同上）Expected: PASS

- [ ] **Step 5: 提交** `feat(smart-lookup): SAG2 Jev batches and round scoring`

### Task 6: 参数

**Files:**
- Modify: `src-tauri/src/lookup_params.rs`、`docs/smart-lookup-parameters.md`

**Interfaces:**
- Produces（camelCase，`deny_unknown_fields`、`default`）：

```rust
pub struct RetrievalParams { pub candidate_k: usize /*50*/, pub deep_candidate_k: usize /*100*/, pub seed_k: usize /*10*/, pub expansion_term_limit: usize /*20*/, pub max_hops: usize /*1*/, pub top_k: usize /*10*/, pub protected_k: usize /*5*/, pub jev_context_tokens: u64 /*32000*/, pub round_timeout_ms: u64 /*10000*/ }
pub struct BudgetParams { pub max_tokens_per_lookup: u64 /*200000*/ }
pub struct AnswerParams { pub context_tokens: u64 /*65536*/, pub output_tokens: u64 /*2048*/, pub timeout_ms: u64 /*60000*/ }
// JudgeParams 增加 pub preset: Preset（默认 Sag2V10；Preset 在 Task 5 定义，本任务若先做就在 lookup_params.rs 定义并由 jev.rs 引用）
// LookupParams 增加 pub retrieval, pub budget, pub answer
impl RetrievalParams { pub(crate) fn round_timeout(&self) -> Duration; pub(crate) fn candidate_k_for(&self, deep: bool) -> usize; }
impl AnswerParams { pub(crate) fn timeout(&self) -> Duration; }
```

- [ ] **Step 1: 写失败的测试**

```rust
#[test] fn retrieval_defaults_follow_sag2() {
    let p = LookupParams::default();
    assert_eq!((p.retrieval.candidate_k, p.retrieval.deep_candidate_k, p.retrieval.seed_k, p.retrieval.expansion_term_limit, p.retrieval.max_hops, p.retrieval.top_k, p.retrieval.protected_k), (50, 100, 10, 20, 1, 10, 5));
    assert_eq!((p.retrieval.jev_context_tokens, p.retrieval.round_timeout_ms, p.budget.max_tokens_per_lookup), (32_000, 10_000, 200_000));
    assert_eq!((p.answer.context_tokens, p.answer.output_tokens, p.answer.timeout_ms), (65_536, 2_048, 60_000));
    assert_eq!(p.judge.preset, Preset::Sag2V10);
}
#[test] fn max_hops_above_two_and_output_not_below_context_are_rejected() {
    assert!(parse_params(r#"{"retrieval":{"maxHops":3}}"#).unwrap_err().contains("retrieval.maxHops = 3 is outside 0..=2"));
    assert!(parse_params(r#"{"answer":{"contextTokens":4096,"outputTokens":4096}}"#).unwrap_err().contains("answer.outputTokens"));
    assert!(parse_params(r#"{"judge":{"preset":"other"}}"#).is_err());
}
```

  修改现有测试：`BOUNDS.len()` 从 20 改为 33；`the_documented_example_equals_the_defaults`、`every_parameter_has_its_own_section`、`documented_defaults_and_bounds_match_the_code` 照常通过（文档同步）。

- [ ] **Step 2: 运行，确认失败**

Run: `CARGO_INCREMENTAL=0 RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml --lib -- lookup_params`
Expected: FAIL

- [ ] **Step 3: 实现** `BOUNDS` 追加 spec H.7 表里的 13 个数值键（范围逐字）；`validate` 加 `answer.outputTokens < answer.contextTokens`；`numeric` 补键。文档：每个新键一节（默认、范围、单位、读取位置、来源 H.x、调高调低、决定它的指标），`candidates.pool`、`k`、`perFile`、`tokenBudget` 各节开头加「已被 `retrieval.*` 取代，不再读取（spec H.7）」，「不可配置的规则」表按 H.6 改写「每次回车至多 `1 + maxHops` 轮」与简答例外，「其他固定常量」加 H.7 列出的常量，「## 示例」更新为新的默认 JSON，「调参流程」加 `maxHops` 0/1/2 三份参数文件的比较方法。

- [ ] **Step 4: 运行，确认通过**（同上）Expected: PASS

- [ ] **Step 5: 提交** `feat(lookup-params): retrieval, budget, answer and judge.preset`

### Task 7: 逐轮状态机与 oracle 夹具

**Files:**
- Create: `src-tauri/src/smart_enhance/sag/round.rs`、`src-tauri/src/smart_enhance/sag/fixtures/sag2_v10_oracle.json`（原样复制）

**Interfaces:**
- Consumes：Task 1 的 `SagReader`；Task 3、4、5 的全部；Task 6 的 `RetrievalParams`；`smart_lookup::{current_block, CanonicalHit}`
- Produces：

```rust
pub(crate) enum EvidenceStop { NoTerms, FrontierEmpty, TermsEmpty, CandidatesEmpty, MaxHops, Budget, IndexChanged, EvidenceTooLarge }  // serde camelCase
pub(crate) trait SagIndex {
    fn generation(&self) -> Result<i64, String>;
    fn stats(&self, level: searchidx::sag::Level) -> &dyn TermStats;      // total = 块数，df = frequencies
    fn candidates(&self, expression: &str, required: Option<&str>, excluded: &[i64], limit: usize) -> Result<Vec<SagCandidate>, String>;  // 已做 H.3.3 回源过滤，order = SQL 行号
    fn has_hits(&self, expression: &str, excluded: &[i64]) -> Result<bool, String>;
    fn aliases(&self) -> Result<Arc<AliasMap>, String>;
    fn skipped(&self) -> Skipped;                                          // 累计的 confidential / stale / long
}
pub(crate) trait Scorer { fn score(&mut self, pool: Vec<SagCandidate>, evidence: Vec<SagCandidate>, state: String) -> impl Future<Output = Result<Vec<SagCandidate>, RoundError>>; }
pub(crate) struct EvidenceState { /* spec H.3.8：generation, query, expression, next_hop, retained, frontier, expanded: BTreeSet, seen: BTreeSet, carried/protected/latest: IndexMap, trace, found_round, stop, tokens_used, settings: RoundSettings */ }
pub(crate) struct RoundSettings { pub candidate_k: usize, pub seed_k: usize, pub term_limit: usize, pub max_hops: u8, pub top_k: usize, pub protected_k: usize }
impl EvidenceState {
    pub(crate) fn start(index: &dyn SagIndex, question_free_text: &str, settings: RoundSettings) -> Result<Self, String>;  // H.3.1–H.3.2；expression 为空时 stop = NoTerms
    pub(crate) async fn step<S: Scorer>(&mut self, index: &dyn SagIndex, scorer: &mut S, extras: &StateExtras, cancel: &CancelFlag) -> Result<StepOutcome, String>;
    pub(crate) fn evidence(&self, index: &dyn SagIndex) -> Vec<SagCandidate>;   // diversify(retained 副本).truncate(min(top_k, candidate_k))
}
pub(crate) enum StepOutcome { Scored { hop: u8, terms: Vec<Term>, pool_size: usize }, Stopped(EvidenceStop), Failed(RoundError) }
pub(crate) struct ReaderIndex { /* Arc<SagReader>, root: PathBuf, filters: searchidx::query::Query, max_block_chars, cache of AliasMap per generation */ }
impl ReaderIndex { pub(crate) fn new(reader: Arc<SagReader>, root: PathBuf, filters: Query, max_block_chars: usize) -> Self; }
```

  `step` 的批与预算：`Scorer` 收到 `state` 字符串；分批、预算检查和 `score_round` 在 Task 8 的 `Scorer` 实现里，`step` 只按 H.3.6 组池、调用、按 H.3.8 簿记。打分失败或取消时状态回到调用前（在副本上修改，成功后替换）。

- [ ] **Step 1: 写失败的测试**

```rust
// 夹具：按 corpus 顺序把每篇写成 "<title>.md"（内容 = text），逐个 index_one，块 id 因而与夹具同序。
// Scorer 用 SAG2 测试的同一规则：Anchor 0.8；Multiple 证据含 Anchor 时 0.95 否则 0.1；Bridge 证据含 Multiple 时 0.99 否则 0.05；High 0.7；Series 0.08；其余 0.01。
// settings：candidate_k 3、seed_k 1、max_hops 2、term_limit 2、top_k 10、protected_k 5。
#[tokio::test] async fn frozen_v10_requests_and_rounds_on_our_index() {
    for (case, want) in oracle_cases().zip(EXPECTED) {
        let run = run_all_rounds(&case.query).await;                              // 循环 step 直到 Stopped
        assert_eq!(run.round_titles, want.round_titles);
        assert_eq!(run.round_terms, want.round_terms);
        assert_eq!(run.pool_titles, want.pool_titles);                            // 每个请求的池顺序
        assert_eq!(run.states, case.requests.iter().map(|r| r.state.clone()).collect::<Vec<_>>());   // 逐字节
        assert_eq!(run.final_titles, want.final_titles);
    }
}
const EXPECTED: [Want; 4] = [
  Want { // "Anchor birthplace depicts"
    round_titles: &[&["Anchor","Series","High"], &["Multiple","Single","Record 0"], &["Record 1","Record 2","Record 3"]],
    round_terms: &[&[], &["alice paul","bob smith"], &["alice paul","bob smith"]],
    pool_titles: &[&["Anchor","Series","High"], &["Anchor","Series","High","Multiple","Single","Record 0"], &["Anchor","Series","High","Multiple","Record 1","Record 2","Record 3"]],
    final_titles: &["Multiple","High","Anchor"] },
  Want { // "Anchor"
    round_titles: &[&["Anchor","Series","High"], &["Single","Multiple"], &["Record 1","Record 3","Record 5"]],
    round_terms: &[&[], &["depicts","birthplace"], &["birthplace","alice paul"]],
    pool_titles: &[&["Anchor","Series","High"], &["Anchor","Series","High","Single","Multiple"], &["Anchor","Series","High","Multiple","Record 1","Record 3","Record 5"]],
    final_titles: &["Multiple","High","Anchor"] },
  Want { // "Where was Alston born?"：第 1 轮扩展词与 SAG2 不同（spec H.5 分词差异）
    round_titles: &[&["Initials","Destination","René Descartes"]], round_terms: &[&[]],
    pool_titles: &[&["Initials","Destination","René Descartes"]], final_titles: &["Initials","Destination","René Descartes"] },
  Want { // "Where was Rene Descartes born?"：经别名修复
    round_titles: &[&["René Descartes","Destination","Initials"]], round_terms: &[&[]],
    pool_titles: &[&["René Descartes","Destination","Initials"]], final_titles: &["René Descartes","Destination","Initials"] },
];
// 第 3、4 题第 1 轮没有发请求（候选为空），另断言 trace[1].terms：第 3 题 ["g alston","h"]，第 4 题 ["en","la haye"]，停止原因都是 CandidatesEmpty。
#[tokio::test] async fn a_question_without_terms_sends_nothing() { /* free_text("tag:x 的") → start 后 stop = NoTerms，step 返回 Stopped(NoTerms)，Scorer 从未被调用 */ }
#[tokio::test] async fn an_index_commit_between_rounds_stops_with_index_changed() { /* 第 0 轮后主连接改写一个文件；第 1 轮 step → Stopped(IndexChanged)，Scorer 只被调用 1 次 */ }
#[tokio::test] async fn expansion_candidates_from_confidential_files_are_never_sent() {
    /* q.md "Anchor Alice Paul"；secret.md frontmatter confidentiality: confidential，正文 "Alice Paul secret"；
       第 1 轮的 Scorer 收到的池里没有 secret.md 的段，skipped().confidential ≥ 1，任何 state 字符串里都没有 "secret" */
}
#[test] fn chinese_sentences_do_not_share_expansion_context() {              // 移植自 retrieval.rs，TermStats = ReaderIndex::stats(Level::Line)
    /* 对「。」「！」「？」三种标点：单文件索引，seed = 文件全文、score 1.0，query "台风 福建"；救援 的分数大于 大运会 与 母婴 */
}
#[tokio::test] async fn a_failed_round_leaves_the_state_as_it_was() { /* 第 1 轮 Scorer 返回 Err → Failed，evidence() 与失败前相同，next_hop 不变 */ }
```

- [ ] **Step 2: 运行，确认失败**

Run: `CARGO_INCREMENTAL=0 RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml --lib -- smart_enhance::sag::round`
Expected: FAIL

- [ ] **Step 3: 实现** `step` 逐行对照 `retrieve_inner` 的循环体（spec H.3.5–H.3.8）；`ReaderIndex::candidates` 调 `SagReader::candidate_query`，批量读保密，逐行构造 `CanonicalHit { level: "line", indexed_text: row.text, … }` 调 `current_block`，再按 `max_block_chars` 过滤；`title` 用 `judge.rs` 现有的 `title_of` 规则（提为 `pub(crate)`）。`found_round` 在候选第一次出现时记下 `hop`。

- [ ] **Step 4: 运行，确认通过**（同上）Expected: PASS。第 1、2 题若有任何一项与 SAG2 不同，先按 spec H.5 的差异表找原因；表里没有的差异就是移植错误，不要改期望值。

- [ ] **Step 5: 提交** `feat(smart-lookup): SAG2 round state machine with oracle fixture`

### Task 8: 命令 `smart_lookup_evidence_step`、查找运行与 CLI 链路

**Files:**
- Create: `src-tauri/src/smart_enhance/evidence.rs`
- Modify: `src-tauri/src/smart_lookup.rs`（`LookupRun.evidence: Option<EvidenceRun>`）、`src-tauri/src/smart_enhance/mod.rs`（`pub(crate) mod evidence;`）、`src-tauri/src/smart_enhance/feedback.rs`、`src-tauri/src/smart_enhance/pipeline.rs`、`src-tauri/src/lib.rs`（注册命令）

**Interfaces:**
- Consumes：Task 7 全部；`gate_jev`、`claim_auto_request`、`release_auto_request`、`cancel_flag_for`、`status_for`、`read_key`、`lookup_params::for_app`、`explicit_filters`
- Produces（线类型，serde camelCase）：

```rust
#[derive(Serialize)] pub struct EvidenceTermDto { pub term: String, pub label: String, pub kind: TermKind }
#[derive(Serialize)] pub struct EvidenceItemDto { pub evidence_id: String, pub path: String, pub line: u32, pub line_end: u32, pub title: String, pub breadcrumb: String, pub text: String, pub found_round: u8, pub tier: Tier, pub local_result_id: Option<String> }
#[derive(Serialize, Default)] pub struct EvidenceStepResult {
    pub status: EnhanceStatus, pub stop: Option<EvidenceStop>, pub skip_reason: Option<SkipReason>, pub missing: Option<Missing>,
    pub endpoint_host: Option<String>, pub status_class: Option<String>,
    pub hop: u8, pub terms: Vec<EvidenceTermDto>, pub evidence: Vec<EvidenceItemDto>, pub local_tiers: Vec<VerdictDto>,
    pub done: bool, pub request_count: u32, pub pool_size: usize, pub sent_blocks: usize,
    pub skipped_confidential: usize, pub skipped_stale: usize, pub skipped_long: usize, pub skipped_oversize: usize,
    pub estimated_tokens: u64, pub tokens_used: u64, pub usage: Option<UsageDto>, pub elapsed_ms: u64,
}
pub(crate) struct EvidenceRequest<'a> { pub run_id: &'a str, pub window_label: &'a str, pub vault_root: &'a Path, pub config: &'a JevRequestConfig, pub key: Option<&'a str>, pub trigger: Trigger, pub deep: bool, pub params: &'a LookupParams, pub reader: Arc<SagReader> }
pub(crate) async fn evidence_step(req: EvidenceRequest<'_>, client: &reqwest::Client, cancel: &CancelFlag) -> Result<EvidenceStepResult, String>;
#[tauri::command] pub async fn smart_lookup_evidence_step(app: tauri::AppHandle, window: tauri::Window, lookup_run_id: String, jev: JevRequestConfig, trigger: Trigger, deep: bool) -> Result<EvidenceStepResult, String>;
pub(crate) struct EvidenceRun { pub state: EvidenceState, pub items: Vec<(String /*evidence_id*/, i64 /*block id*/)>, pub endpoint_host: String, pub model: String, pub auto_claimed: bool }
pub(crate) fn reader_for(root: &Path, db: &Path, globs_stamp: &str) -> Result<Arc<SagReader>, String>;  // 进程内按 db 路径缓存一个，workers = 8
```

  `PipelineOutput` 增加 `pub evidence_rounds: Vec<EvidenceStepResult>`；`Judge` 路由改为循环 `evidence_step`（`Trigger::Auto`）直到 `done`；`hits` = 证据项（按 `path + line + lineEnd` 映射回本地命中，找不到的以 `SmartHitDto` 形式由证据项构造）在前，其余本地命中在后。

- [ ] **Step 1: 写失败的测试**（`evidence.rs`，本机假 Jev 服务沿用 `judge.rs` 测试的写法）

```rust
#[tokio::test] async fn first_step_claims_the_auto_slot_and_later_steps_reuse_it() {
    let r1 = step(Trigger::Auto).await; assert_eq!((r1.status, r1.hop, r1.done), (EnhanceStatus::Ok, 0, false));
    let r2 = step(Trigger::Auto).await; assert_eq!((r2.hop, r2.done, r2.stop), (1, true, Some(EvidenceStop::MaxHops)));   // maxHops 1
    let r3 = step(Trigger::Auto).await; assert!(r3.done && r3.request_count == 0);                                     // 超过 maxHops 不再发
}
#[tokio::test] async fn consent_for_another_host_sends_nothing() { /* consentHost 不符 → NoConsent，假服务计数 0，自动名额未被占用 */ }
#[tokio::test] async fn a_round_that_would_exceed_the_lookup_budget_is_not_sent() {
    /* budget.maxTokensPerLookup = 第 0 轮估算 + 1 → 第 1 轮 stop = Budget、request_count 0；evidence 与第 0 轮相同 */
}
#[tokio::test] async fn stop_during_round_one_keeps_round_zero_evidence_and_sends_no_more() {
    /* 假服务第 2 个请求延迟 2 s；50 ms 后 cancel → status Cancelled、done；再 step → done、request_count 0；evidence 等于第 0 轮 */
}
#[tokio::test] async fn local_rows_get_tiers_from_the_latest_score() { /* 本地命中与池中段同路径同行 → local_tiers 含它，tier 按 tiers.fit/unfit */ }
#[test] fn feedback_accepts_evidence_ids() { /* feedback_row 用 evidence_id 找到项，modelTier 为证据档位，endpointHost/model 来自 EvidenceRun */ }
#[tokio::test] async fn pipeline_judge_route_runs_evidence_rounds() { /* run_pipeline 的 route = Judge，evidence_rounds.len() = 2，hits 以证据项开头 */ }
```

- [ ] **Step 2: 运行，确认失败**

Run: `CARGO_INCREMENTAL=0 RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml --lib -- smart_enhance::evidence smart_enhance::feedback smart_enhance::pipeline`
Expected: FAIL

- [ ] **Step 3: 实现** 次序：读运行并核对 vault → `gate_jev`（失败即返回，不领名额）→ 首轮且 `Auto` 时 `claim_auto_request`（没领到返回 `skipped`/`autoBudgetUsed`），非首轮沿用 `auto_claimed` → 首轮 `EvidenceState::start`（`free_text`、`time.mode` 与 `explicit_filters` 按 spec H.3.2；`deep` 时 `candidate_k = deepCandidateK`）→ `step`，其 `Scorer` 实现：`jev_batches`（`EvidenceTooLarge` → stop）→ 预算检查（`tokens_used + Σ estimated > maxTokensPerLookup` → stop `Budget`，不发）→ `score_round(deadline = roundTimeoutMs)`。没有发出任何请求时 `release_auto_request`。结果写回运行。错误映射用 `status_for`。不持有 `IndexHandle` 锁。

- [ ] **Step 4: 运行，确认通过**（同上）Expected: PASS

- [ ] **Step 5: 提交** `feat(smart-lookup): evidence step command on the lookup run`

### Task 9: 评测的逐轮指标与 C5

**Files:**
- Modify: `src-tauri/src/search/smart_eval.rs`、`src-tauri/src/cli/lookup.rs`、`docs/smart-lookup-parameters.md`

**Interfaces:**
- Consumes：Task 8 的 `PipelineOutput.evidence_rounds`
- Produces：`LookupEvalRow` 新字段（`#[serde(default)]`）`max_hops: Option<u8>`、`evidence_rank: Option<usize>`、`found_round: Option<u8>`、`rounds: Vec<RoundRow>`；`RoundRow { hop, terms: Vec<String>, candidates: usize, pool_size, sent_blocks, estimated_tokens, input_tokens: Option<u64>, request_count, elapsed_ms, status, stop, evidence_rank: Option<usize> }`；`LookupMetrics` 新字段 `evidence_recall10`、`evidence_recall10_round0`、`expansion_only`、`lost_by_expansion`、`round_tokens: Vec<u64>`、`round_input_tokens: Vec<u64>`、`round_p50_ms: Vec<Option<u64>>`、`round_p95_ms: Vec<Option<u64>>`、`round_requests`、`round_timeouts`、`round_timeout_rate`；`GateVerdicts` 新字段 `c5: Option<bool>`、`c5_bridge_tasks: usize`。`finalRank` 按 spec H.10 的新定义。

- [ ] **Step 1: 写失败的测试**

```rust
#[test] fn c5_needs_expansion_only_recall_and_no_regression() {
    let rows = holdout(&[bridge(Some(3), Some(1), None), bridge(Some(5), Some(2), None), bridge(Some(2), Some(0), Some(2)), bridge(None, None, None)]);   // (evidenceRank, foundRound, round0Rank)
    let g = gate_verdicts(&rows);
    assert_eq!(g.c5_bridge_tasks, 4);
    assert_eq!(g.c5, Some(true));      // expansionOnly 2，recall 3 vs round0 1（+2），lost 0
    assert_eq!(gate_verdicts(&rows[..3]).c5, None);   // 桥接题不足 4
}
#[test] fn final_rank_reads_evidence_first_then_remaining_local_hits() { /* 证据 [x,t]、本地 [y,t,z] → t 的 finalRank 2；不在证据时为 证据数 + 本地中排除证据后的名次 */ }
#[test] fn per_round_metrics_and_compare_across_max_hops() { /* 两个 --out：maxHops 0 与 1 → compare 的差值包含 evidenceRecall10、roundTokens[0] */ }
#[test] fn gates_are_na_off_the_default_round_timeout() { /* roundTimeoutMs 5000 → c3、c5 为 None，note 为 "round timeout ≠ 10 s" */ }
```

- [ ] **Step 2: 运行，确认失败**

Run: `CARGO_INCREMENTAL=0 RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml --lib -- search::smart_eval cli::lookup`
Expected: FAIL

- [ ] **Step 3: 实现** 指标定义逐字取自 spec H.10；C3 改为在 `maxHops = 0` 的行上用新 `finalRank` 计算（数值门槛不变）；文字输出的门槛行追加 `C5 pass|fail (…)|n/a (…)`。文档「调参流程」加逐轮指标表、C5 定义、`maxHops` 0/1/2 比较步骤，「任务文件」加 spec H.10 的桥接题指引。

- [ ] **Step 4: 运行，确认通过**（同上）Expected: PASS

- [ ] **Step 5: 提交** `feat(lookup-eval): per-round evidence metrics and gate C5`

### Task 10: 前端线类型与证据区纯状态

**Files:**
- Modify: `src/lib/smart-search/api.ts`、`src/lib/smart-search/settings.ts`
- Create: `src/lib/smart-search/evidence-flow.ts`、`src/lib/smart-search/evidence-flow.test.ts`
- Test: `src/lib/smart-search/settings.test.ts`

**Interfaces:**
- Produces：

```ts
export type EvidenceStop = 'noTerms' | 'frontierEmpty' | 'termsEmpty' | 'candidatesEmpty' | 'maxHops' | 'budget' | 'indexChanged' | 'evidenceTooLarge'
export interface EvidenceTerm { term: string; label: string; kind: 'word' | 'namePhrase' }
export interface EvidenceItem { evidenceId: string; path: string; line: number; lineEnd: number; title: string; breadcrumb: string; text: string; foundRound: number; tier: Tier; localResultId: string | null }
export interface EvidenceStepResult { status: EnhanceStatus; stop: EvidenceStop | null; skipReason: SkipReason | null; missing: Missing | null; endpointHost: string | null; statusClass: string | null; hop: number; terms: EvidenceTerm[]; evidence: EvidenceItem[]; localTiers: { resultId: string; tier: Tier }[]; done: boolean; requestCount: number; poolSize: number; sentBlocks: number; skippedConfidential: number; skippedStale: number; skippedLong: number; skippedOversize: number; estimatedTokens: number; tokensUsed: number; usage: Usage | null; elapsedMs: number }
// smartSearchApi
evidenceStep: (lookupRunId: string, jev: JevRequestConfig, trigger: Trigger, deep: boolean) => invoke<EvidenceStepResult>('smart_lookup_evidence_step', { lookupRunId, jev, trigger, deep })
// settings.ts：enhance.chat 增加 consentHost: string（默认 ''，长度上限 CONSENT_HOST_MAX_LENGTH）
// evidence-flow.ts（纯函数，无 I/O）
export interface EvidenceView { rounds: { hop: number; terms: EvidenceTerm[]; items: EvidenceItem[] }[]; shown: EvidenceItem[]; pending: EvidenceItem[] | null; done: boolean; stop: EvidenceStop | null }
export function emptyEvidence(): EvidenceView
export function applyRound(view: EvidenceView, result: EvidenceStepResult, interacted: boolean): EvidenceView
export function applyPending(view: EvidenceView): EvidenceView
export function restoreRound(view: EvidenceView, hop: number): EvidenceView
export function roundLabel(foundRound: number): keyof Messages          // 0 → 'smartSearch.evidence.round.local'，1 → '…round.one'，2 → '…round.two'
export function shouldStartEvidence(hits: number, route: 'judge' | 'skip' | 'repair', settings: SmartLookupSettings): boolean
```

- [ ] **Step 1: 写失败的测试**（`evidence-flow.test.ts`）

```ts
it('replaces the list when the user has not interacted', () => {
  const v = applyRound(applyRound(emptyEvidence(), round(0, ['a', 'b']), false), round(1, ['c', 'a']), false)
  expect(v.shown.map((i) => i.evidenceId)).toEqual(['c', 'a']); expect(v.pending).toBeNull()
})
it('keeps shown items in place and appends new ones while the user interacts', () => {
  const v = applyRound(applyRound(emptyEvidence(), round(0, ['a', 'b']), false), round(1, ['c', 'a']), true)
  expect(v.shown.map((i) => i.evidenceId)).toEqual(['a', 'b', 'c']); expect(v.pending?.map((i) => i.evidenceId)).toEqual(['c', 'a'])
  expect(applyPending(v).shown.map((i) => i.evidenceId)).toEqual(['c', 'a'])
})
it('restores an earlier round without a request', () => {
  const v = applyRound(applyRound(emptyEvidence(), round(0, ['a']), false), round(1, ['b']), false)
  expect(restoreRound(v, 0).shown.map((i) => i.evidenceId)).toEqual(['a'])
})
it('a failed round keeps the previous list', () => { /* status timeout → shown 不变，done 为 true */ })
it('starts automatically only with hits, a judge route and a consented endpoint', () => { /* 0 命中、route skip、consentHost 不符 → false */ })
```

  `settings.test.ts` 增加：`normalizeSmartLookupSettings({enhance:{chat:{consentHost:'a.example'}}}).enhance.chat.consentHost === 'a.example'`，缺省为 `''`。

- [ ] **Step 2: 运行，确认失败**

Run: `./node_modules/.bin/vitest run src/lib/smart-search/evidence-flow.test.ts src/lib/smart-search/settings.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**（纯函数；`chatRequestConfig` 不变，新增 `chatAnswerConfig(settings)` 返回 `{url, model, consentHost}` 供 Task 12）

- [ ] **Step 4: 运行，确认通过**（同上，再跑 `svelte-check`）Expected: PASS，`0 errors`

- [ ] **Step 5: 提交** `feat(smart-lookup): evidence wire types and pure view state`

### Task 11: 「证据」区界面

**Files:**
- Modify: `src/SmartLookupApp.svelte`、`src/lib/i18n/{zh,en,de,ja}.ts`、`CHANGELOG.md`、`CHANGELOG.zh-CN.md`
- Test: `src/SmartLookupApp.test.ts`（若不存在则新建，沿用现有窗口测试的 mock 方式）

**Interfaces:**
- Consumes：Task 10 的全部；Task 8 的命令
- Produces：i18n 键 `smartSearch.evidence.title`（zh「证据」/ en "Evidence"）、`.round.local`（「本地」/ "Local"）、`.round.one`（「第 1 轮扩展」/ "Expansion 1"）、`.round.two`（「第 2 轮扩展」/ "Expansion 2"）、`.terms`（「扩展词：{terms}」）、`.judging`（「Jev 正在判断 · {count} 段」）、`.searching`（「正在检索原文」）、`.expanding`（「正在扩展检索（第 {hop} 轮）」）、`.restore`（「恢复到第 {hop} 轮」）、`.updated`（「顺序有更新 · 应用」）、`.start`（「查找证据」）、`.indexChanged`（「索引已更新，请重新查找」）、`.budget`（「已达本次查找的 token 上限」）、`.none`（「没有找到证据」）

- [ ] **Step 1: 写失败的测试**

```ts
it('shows local results first, then evidence rounds above them', async () => { /* localLookup 返回 2 条；evidenceStep 依次返回 hop0、hop1(done)；证据区标题出现在本地列表之前；第二条证据带「第 1 轮扩展」 */ })
it('does not move the selection when a round arrives after the user moved', async () => { /* 方向键后 hop1 到达 → 选中项不变，出现「顺序有更新 · 应用」 */ })
it('stop cancels the evidence run and keeps the shown list', async () => { /* 点「停止」→ 调 cancel(runId)，不再调 evidenceStep */ })
it('local rows judged by evidence rounds show their tier badge', async () => { /* localTiers 含第 1 条 → 该行显示「符合」 */ })
```

- [ ] **Step 2: 运行，确认失败**

Run: `./node_modules/.bin/vitest run src/SmartLookupApp.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现** 回车后 `runLocal` 不变；本地结果出来后若 `shouldStartEvidence` 为真，循环 `evidenceStep(runId, jevRequestConfig, 'auto', deep)` 直到 `done` 或被取代（沿用现有的 `supersede` 序号与 `stopEnhanceRequest`）；不再自动调用 `smartSearchApi.judge`。证据行复用本地行的组件、键盘导航与打开逻辑，纠正按钮调用 `feedback(runId, evidenceId, verdict)`。CHANGELOG 两份「未发布」各加一条：「智能查找新增『证据』区：在本地结果之上用 Jev 逐轮查找并按证据扩展检索，可随时停止和恢复。」

- [ ] **Step 4: 运行，确认通过**（同上，再跑 `svelte-check` 与 `node scripts/changelog.mjs check`）Expected: PASS

- [ ] **Step 5: 提交** `feat(smart-lookup): evidence section in the lookup window`

### Task 12: 简答

**Files:**
- Create: `src-tauri/src/smart_enhance/answer.rs`
- Modify: `src-tauri/src/smart_model.rs`、`src-tauri/src/smart_enhance/mod.rs`（`EnhanceStatus::InvalidCitations`）、`src-tauri/src/lib.rs`、`src/lib/smart-search/api.ts`、`src/SmartLookupApp.svelte`、`src/lib/i18n/{zh,en,de,ja}.ts`、两份 CHANGELOG

**Interfaces:**
- Consumes：Task 8 的 `EvidenceRun`；`consent_matches`、`read_key(KeyKind::Chat)`、`current_block`、`SagReader::confidentiality_for_paths`；Task 6 的 `AnswerParams`；Task 10 的 `chatAnswerConfig`
- Produces：

```rust
// smart_model.rs
pub async fn chat_messages(client: &reqwest::Client, config: &ChatConfig, key: &str, messages: &[serde_json::Value], timeout: Duration) -> Result<ChatOutcome, ModelError>;  // body {"model","messages"}，无 response_format
// answer.rs
pub(crate) const ANSWER_SYSTEM: &str;                                     // models.rs L373 逐字
pub(crate) fn answer_messages(question: &str, sources: &[AnswerSource]) -> Vec<serde_json::Value>;
pub(crate) struct AnswerSource { pub id: usize, pub title: String, pub heading: String, pub content: String }   // Serialize 字段顺序 id,title,heading,content
pub(crate) fn input_budget(limit: u64, output: u64) -> Result<u64, String>;
pub(crate) fn message_tokens(messages: &[serde_json::Value], cjk: u32, other: u32) -> u64;
pub(crate) fn fit_sources(question: &str, sources: Vec<AnswerSource>, budget: u64, cjk: u32, other: u32) -> Result<(Vec<AnswerSource>, usize /*omitted*/), String>;
pub(crate) fn invalid_citations(text: &str, count: usize) -> Vec<String>;   // agent.rs 逐字
pub(crate) fn has_source_labels(text: &str) -> bool;
#[derive(Deserialize)] #[serde(rename_all = "camelCase", deny_unknown_fields)] pub struct ChatAnswerConfig { pub url: String, pub model: String, pub consent_host: String }
#[derive(Serialize)] pub struct AnswerResult { pub status: EnhanceStatus, pub missing: Option<Missing>, pub endpoint_host: Option<String>, pub status_class: Option<String>, pub text: Option<String>, pub sources: Vec<AnswerSourceRef>, pub omitted_sources: usize, pub request_count: u32, pub elapsed_ms: u64, pub usage: Option<UsageDto> }
#[derive(Serialize)] pub struct AnswerSourceRef { pub id: usize, pub evidence_id: String }
#[tauri::command] pub async fn smart_lookup_answer(app: tauri::AppHandle, window: tauri::Window, lookup_run_id: String, chat: ChatAnswerConfig) -> Result<AnswerResult, String>;
```

```ts
export interface AnswerResult { status: EnhanceStatus | 'invalidCitations'; missing: Missing | null; endpointHost: string | null; statusClass: string | null; text: string | null; sources: { id: number; evidenceId: string }[]; omittedSources: number; requestCount: number; elapsedMs: number; usage: Usage | null }
answer: (lookupRunId: string, chat: { url: string; model: string; consentHost: string }) => invoke<AnswerResult>('smart_lookup_answer', { lookupRunId, chat })
```

- [ ] **Step 1: 写失败的测试**

```rust
#[test] fn invalid_citations_follow_agent_rs() {                                  // 用例取自 agent.rs 的行为
    assert_eq!(invalid_citations("A [1][2] B [3]", 2), vec!["3"]);
    assert!(invalid_citations("see `[9]` and [1](http://x)", 1).is_empty());
    assert_eq!(invalid_citations(r#"{"answer":"x","sources":[1,4]}"#, 2), vec!["4"]);
    assert_eq!(invalid_citations("[1，3]", 2), vec!["3"]);
    assert!(has_source_labels("x [2]") && !has_source_labels("x"));
}
#[test] fn messages_match_sag2_without_paths() {
    let m = answer_messages("问", &[src(1, "T", "", "c")]);
    assert_eq!(m[0], json!({"role":"system","content": ANSWER_SYSTEM}));
    assert_eq!(m[1]["content"], r#"{"question":"问","sources":[{"id":1,"title":"T","heading":"","content":"c"}]}"#);
}
#[test] fn budget_fits_sources_greedily() {
    assert_eq!(input_budget(65_536, 2_048).unwrap(), 63_488 - 12_698);
    /* 三段，第二段单独超预算 → 保留 1、3，omitted 1；全部超 → Err("单个片段超过回答上下文预算") */
}
#[tokio::test] async fn one_correction_turn_then_review_then_error() {
    /* 假服务依次返回 "x [5]"、"x [1]" → ok，request_count 2，第二个请求末条 system 消息以「候选回答包含无效引用 [\"5\"]」开头；
       依次返回 "x"、"x [1]"（有来源但无引用）→ ok，2 个请求，末条以「复核本轮所有工具证据」开头；
       依次返回 "x [5]"、"x [6]"、"y [7]" → InvalidCitations，text None，request_count 3 */
}
#[tokio::test] async fn answer_needs_consent_for_the_chat_host_and_skips_confidential_sources() { /* consentHost 不符 → NoConsent，0 请求；证据中一段所在文件改为 confidential → 不在 sources 里 */ }
```

  前端：`src/SmartLookupApp.test.ts` 加 `it('generates an answer only when the user clicks', …)`（证据完成后出现「生成简答」，未点按时不调用 `answer`；点按后回答按纯文本显示，`[1]` 渲染为指向第 1 条证据的链接）。

- [ ] **Step 2: 运行，确认失败**

Run: `CARGO_INCREMENTAL=0 RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml --lib -- smart_enhance::answer` 与 `./node_modules/.bin/vitest run src/SmartLookupApp.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现** 流程按 spec H.4：取 `EvidenceRun` 的当前证据列表 → 逐段保密与 `current_block` 复核 → `fit_sources(answer.contextTokens, answer.outputTokens)` → `chat_messages`（`answer.timeoutMs`）→ 按 (1)–(4) 的规则至多再请求两次 → 映射 `id → evidence_id`。i18n：`smartSearch.answer.generate`（「生成简答」/ "Answer"）、`.noConsent`（「未同意发送到 {host}」）、`.invalidCitations`（「模型引用了不存在的来源编号」）、`.omitted`（「{count} 段超出预算未发送」）。回答不写入活动记录。CHANGELOG 两份各加一条：「智能查找可根据证据生成带来源编号的简答（需在设置里允许发送到修复模型的主机）。」

- [ ] **Step 4: 运行，确认通过**（同上，再跑 `svelte-check` 与 `node scripts/changelog.mjs check`）Expected: PASS

- [ ] **Step 5: 整分支验证**

Run（依次）：`cargo test --manifest-path searchidx/Cargo.toml sag:: pos_names free_text frontmatter`；`CARGO_INCREMENTAL=0 RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml --lib -- smart_enhance lookup_params search::smart_eval cli::lookup smart_lookup smart_model`；`./node_modules/.bin/vitest run src/lib/smart-search src/SmartLookupApp.test.ts`；`svelte-check`。
Expected: 新增与相关测试全部通过；失败只出现在 Global Constraints 列出的既有模块。

- [ ] **Step 6: 提交** `feat(smart-lookup): evidence-based answer with citation checks`

## 自检记录

- spec 覆盖：H.1 → Task 8、11；H.2 各行 → Task 1–8、12；H.3.1–H.3.2 → Task 1、4、7；H.3.3 → Task 1、7；H.3.4 → Task 1、2、3；H.3.5 → Task 1、3、4；H.3.6–H.3.8 → Task 7；H.3.7 → Task 5、8；H.3.9–H.3.10 → Task 4、7；H.3.11 → Task 1、7、8；H.4 → Task 12；H.5 → Task 2、7 的测试；H.6 → Task 5、8、12；H.7 → Task 6；H.8 → Task 10、11；H.9 → Task 3、4、5、7；H.10 → Task 9。
- 类型一致：`SagCandidate`、`Term`、`TermKind`、`Trace` 只在 Task 2 定义；`EvidenceStop` 在 Task 7 定义，Task 8、9、10 使用同名同值；`Preset` 在 Task 5（或先做的 Task 6）定义一次。
- 篇幅：本计划约为 spec 附录 H 的 1.4 倍（字符数），算法细节只在 spec 里出现一次，计划只给接口、测试与数值。
