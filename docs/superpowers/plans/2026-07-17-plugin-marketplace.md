# 子项目③：插件市场 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 v2 插件可下载、验签安装、升级、回滚、卸载、启停——CF Worker 注册表 + R2 制品 + minisign 签名 + 市场核心窗口 + 能力消费同意 UI + CLI `plugin install/update/remove`，全程 v2 flag 门控。

**Architecture:** Rust 安装器核心（下载→sha256→minisign 验签→解压到版本目录→原子切 `current`→写 state.json→回滚）是纯可测层，GUI 与 CLI 共用。运行时新增 `plugin_market_reload` 命令重扫 STATE + reconcile RUNNING（卸载的 deactivate、新装的注册）+ 重建菜单，消除"必须重启"。注册表 = CF Worker（`plugins-registry`，KV 存索引 + R2 存 `.notemdpkg`），deploy 走既有 wrangler+GH Actions 模式（user-gated：需用户的 CLOUDFLARE_API_TOKEN + 签名私钥）。市场窗口克隆 insights 独立窗口模式；安装前弹能力同意模态（兑现 ②安全评审 V1）。

**Tech Stack:** Rust（minisign-verify 验签、sha2、reqwest+rustls 下载、flate2/tar 或 zip 解压——复用现有 zip dep）、TypeScript（CF Worker，克隆 worker/ 模式）、Svelte 独立窗口、minisign CLI（发布签名）。

**已核实基建：** state.rs（InstallState{installed:{id→{version,enabled}}}、plugins_root、load/save 原子写）、discovery::scan_root（读 state.json→`<root>/<id>/current/manifest.json`）、`current` symlink→版本目录（仅 dev 脚本建）、**无 Rust 安装器**；sha2/hex/reqwest/rustls 已在 Cargo.toml；CLI plugin list/enable/disable/info（router.rs:65-82 + builtin.rs），**缺 install/update/remove**；plugin_runtime::init 仅启动跑一次、**无运行时重载**；CF 账号 `9aec351745dbb8adf336b98a0f473761`，worker/wrangler+KV+R2+`.github/workflows/deploy-worker.yml` 模式；release.sh 日期版本推导 + `pnpm tauri signer sign` 重签；updater minisign pubkey 在 tauri.conf.json:277-285。

**包格式：** `.notemdpkg` = gzip'd tar，内含 `manifest.json` + `bin/` +（ui-only）`ui/`。分离式 minisign 签名 `.notemdpkg.minisig`。sha256 记于索引。

**工作区纪律：** 同一 worktree 分支堆叠；精确 git add；flag off 时市场命令一律拒/空、注册表 worker 与主程序解耦。CF 部署与私钥生成是**用户步骤**（本计划只产出代码 + wrangler + workflow + 文档，不部署、不碰真密钥；本地用测试密钥对 + 本地包 fixture 验证全链路）。

---

### Task 1: 安装器核心（download/verify/extract/swap/rollback）+ minisign 验签

**Files:** Create `src-tauri/src/plugin_runtime/installer.rs`；Modify `Cargo.toml`（加 `minisign-verify`、`flate2`、`tar`——先查现有 zip/压缩 dep 能否复用，能则不加 tar）、`mod.rs`

- [ ] Step 1: 先查 `grep -n 'flate2\|tar\|zip\|gzip' src-tauri/Cargo.toml`——若已有 zip，包格式改用 **zip**（避免加 tar/flate2）；否则加 `flate2` + `tar`。minisign 验签用 `minisign-verify = "0.2"`（纯 Rust、verify-only、小）。报告最终选型。
- [ ] Step 2: installer.rs 纯函数核心（全部无 AppHandle，tempdir 可测）：

```rust
/// 校验 + 解包到临时目录，返回解出的 manifest（未落安装位）。
pub fn verify_and_stage(pkg_bytes: &[u8], sig: &str, sha256_hex: &str, pubkey_b64: &str,
                        stage_dir: &Path) -> Result<plugin_protocol::ManifestV2, InstallError>
// 1) sha256(pkg_bytes) == sha256_hex 否则 Err(Hash)
// 2) minisign_verify(pubkey, pkg_bytes, sig) 否则 Err(Signature)
// 3) 解包（zip/tar）到 stage_dir，路径穿越防护（每条目名规范化后必须落 stage 内）
// 4) 读 stage/manifest.json → plugin_protocol::validate_manifest（engines/id/binary|ui）
// 5) manifest.id 必须等于调用方期望 id 否则 Err(IdMismatch)

/// 原子安装已 stage 的插件到 <root>/<id>/<version>/ 并切 current。
pub fn commit_install(root: &Path, id: &str, version: &str, staged: &Path)
    -> Result<(), InstallError>
// 移动 staged → <root>/<id>/<version>/（同版本已存在则先删）；symlink current→version（原子：先建 current.tmp 再 rename）；
// 失败回滚：不动旧 current。

/// 卸载：删版本目录 + current；data 目录(plugin_data/<id>)按 keep_data 决定是否保留。
pub fn uninstall(root: &Path, id: &str, keep_data: bool, data_root: &Path) -> Result<(), InstallError>

/// 回滚到指定已存在版本目录（升级失败用）。
pub fn rollback(root: &Path, id: &str, to_version: &str) -> Result<(), InstallError>
```

`InstallError { Hash, Signature, Unpack(String), Manifest(String), IdMismatch, Io(String) }`（Display + 映射为用户串）。
- [ ] Step 3: 单元测试（生成测试 minisign 密钥对——测试内用 minisign-verify 的对偶或预置固定测试密钥 + 预签测试包 fixture 存 `tests/fixtures/pkg/`）：sha 不符拒、签名不符拒、穿越条目拒、id 不符拒、engines 不满足拒、正常 stage+commit 后 `<root>/<id>/<version>/manifest.json` 存在且 current→version、commit 幂等（重装同版本）、uninstall 删目录留/删 data、rollback 切回旧版本。**测试密钥生成**：若不便在测试内签名，提交一个固定测试密钥对（公钥入测试常量、私钥入 `tests/fixtures/` 仅测试用）+ 预签 fixture 包；报告采用方式。
- [ ] Step 4: `pub mod installer;`；`cargo test --manifest-path src-tauri/Cargo.toml installer` + full → PASS。
- [ ] Step 5: Commit `feat(plugin-v2): installer core — download verify(minisign+sha256) unpack atomic-swap rollback`。

---

### Task 2: 注册表客户端 + Tauri 命令 + 运行时 reconcile

**Files:** Create `src-tauri/src/plugin_runtime/market.rs`；Modify `commands.rs`、`lib.rs`（注册 + pubkey const）、`mod.rs`、`lifecycle.rs`（reconcile helper）

- [ ] Step 1: market.rs——索引类型 + HTTP 客户端（reqwest，rustls 已配）：

```rust
#[derive(Deserialize)] pub struct RegistryIndex { pub plugins: Vec<RegistryEntry> }
#[derive(Deserialize, Clone)] pub struct RegistryEntry {
  pub id: String, pub version: String, pub min_host: String,
  pub archs: Vec<String>, pub size: u64, pub sha256: std::collections::BTreeMap<String,String>,
  pub name: String, pub description: Option<String>,
  pub i18n: Option<serde_json::Value>, pub icon_url: Option<String>,
  pub changelog_url: Option<String>, pub download: std::collections::BTreeMap<String,String>, // arch→url
}
pub async fn fetch_index(base_url: &str) -> Result<RegistryIndex, String>  // GET {base}/api/index.json
pub async fn download(url: &str) -> Result<Vec<u8>, String>               // GET，size 上限 50MB
pub async fn report_install(base_url: &str, id: &str, version: &str)       // POST /api/stats/install，fire-and-forget 静默失败
```

基础 URL：常量 `DEFAULT_REGISTRY = "https://plugins.notemd.net"`，可被 settings.json `plugins_v2.registry_url` 覆盖（读法仿 read_saved_locale）。签名公钥：`const PLUGIN_REGISTRY_PUBKEY: &str = "<占位——用户生成后填>"`；**本期填测试公钥**，发布前用户替换真公钥（Task 7 记录）。
- [ ] Step 2: lifecycle reconcile：`pub fn reconcile(app) -> Result<(),String>`——重跑 discovery::scan 得新 map；对 RUNNING 中已不在新 map（被卸载/禁用）的 → `deactivate` + 从 RUNNING 移除；STATE.plugins 更新为新 map；返回。commands 侧再触发菜单重建（emit 事件让前端重取 manifests + 后端 rebuild_menu——查 ⓪ 的菜单重建路径复用）。
- [ ] Step 3: commands.rs 新命令（全部 flag 门控，off 时 Err "v2 disabled"）：
  - `plugin_market_index() -> Result<Value,String>`（fetch_index 序列化）
  - `plugin_market_install(app, id, version) -> Result<(),String>`：查索引条目→download→verify_and_stage(PLUGIN_REGISTRY_PUBKEY)→commit_install→state.json 置 {version,enabled:true}→report_install→reconcile→重建菜单。**能力同意在前端弹**（install 命令假定已同意；同意 UI 在 Task 6，命令不重复门控——但记录 manifest.capabilities 供前端展示的 `plugin_market_preview(id,version)->{manifest}` 命令：download+verify+stage 到临时只读 manifest，不 commit，供同意 UI 展示真实 capabilities）
  - `plugin_market_uninstall(app, id, keep_data) -> Result<(),String>`：uninstall→state.json 删条目→reconcile→重建菜单
  - `plugin_market_set_enabled(app, id, enabled) -> Result<(),String>`：改 state.json enabled→reconcile→重建菜单
  - `plugin_market_installed() -> Vec<Value>`：读 state.json + 各 current/manifest.json 返回已装清单（含 enabled、version）
- [ ] Step 4: lib.rs 注册六个命令（not-ios handler）；`pub mod market;`。
- [ ] Step 5: 单元测试：market 索引反序列化；reconcile（tempdir 假 STATE：装两个、卸一个→RUNNING 只剩一个）。HTTP 用本地起 mock 或跳过网络（fetch_index 拆纯 parse 层测）。commands 的集成靠 Task 6 手动 E2E。
- [ ] Step 6: `cargo test` + `cargo build` → PASS；Commit `feat(plugin-v2): registry client + market commands + runtime reconcile (no restart)`。

---

### Task 3: CLI `plugin install/update/remove`

**Files:** Modify `src-tauri/src/cli/router.rs`、`src-tauri/src/cli/builtin.rs`

- [ ] Step 1: router.rs `first=="plugin"` 块加 `install <id>[@version]` / `update [<id>]` / `remove <id>` → 新 Builtin 变体（PluginInstall/PluginUpdate/PluginRemove）。
- [ ] Step 2: builtin.rs 实现（复用 installer + market 纯层，CLI 无 AppHandle→用 dirs::data_dir()+BUNDLE_ID 定 root，与 runner.rs 现有 v2 root 解析一致）：
  - install：fetch_index→找条目（未指定 version 用最新）→download→verify_and_stage→commit_install→state.json；`--json` 输出 {ok,data:{id,version}}，失败 exit 4；验签失败 exit 5 明确报错。
  - update：无参→遍历 state.json 已装，对每个查索引更高版本→装；有 id→只该插件。报告每个 up-to-date/updated。
  - remove：uninstall + state.json；`--keep-data` 标志。
  - 注：CLI 装完提示"重启 note.md 或已运行实例下次启动生效"（CLI 进程无法 reconcile 运行中的 GUI 实例）。
- [ ] Step 3: router 测试（resolve `plugin install x@1.0.0` → PluginInstall("x","1.0.0")）；builtin 装/删走本地 fixture 包 + 测试注册表（起本地静态目录当 index？或把 install 的下载层做成可注入 fetch，测试注入读本地 fixture）。报告可测性方案。
- [ ] Step 4: `cargo test` → PASS；Commit `feat(plugin-v2): CLI plugin install/update/remove`。

---

### Task 4: 插件注册表 CF Worker

**Files:** Create `plugins-registry/`（wrangler.toml、src/index.ts、package.json、tsconfig.json、vitest.config.ts、README.md）；Create `.github/workflows/deploy-plugins-registry.yml`

- [ ] Step 1: wrangler.toml（克隆 worker/wrangler.toml；account_id `9aec351745dbb8adf336b98a0f473761`；name `notemd-plugins`；route `plugins.notemd.net` custom_domain；KV binding `INDEX`；R2 binding `PKGS` bucket `notemd-plugins`）。
- [ ] Step 2: src/index.ts：
  - `GET /api/index.json` → 从 KV 读 `index` 键（发布脚本写入），CDN 缓存 5 分钟头，CORS。
  - `GET /api/download/<id>/<version>/<arch>` → 从 R2 取 `<id>/<version>/<arch>.notemdpkg` → 302 或直接流（含 `.minisig` 同理路径 `?sig=1`）。
  - `POST /api/stats/install {id,version}` → KV 计数（`stats:<id>` 自增），fire-and-forget，always 200。
  - 404/405 兜底。
- [ ] Step 3: vitest（unstable_dev 或 Miniflare）：index.json 返回 KV 内容；download 命中 R2 mock → 302/流；stats POST → 200 且计数++；坏路径 404。
- [ ] Step 4: deploy workflow（克隆 deploy-worker.yml，paths `plugins-registry/**`，workingDirectory `plugins-registry`，secret CLOUDFLARE_API_TOKEN）。
- [ ] Step 5: README：部署前置（用户建 KV namespace + R2 bucket + custom domain + repo secret；`wrangler deploy`）。**不实际部署**。
- [ ] Step 6: `pnpm --filter <worker> test`（或 cd 测）→ PASS；Commit `feat(plugin-v2): plugins-registry CF Worker (index/download/stats) + deploy workflow`。

---

### Task 5: 插件发布/签名脚本 + 索引生成

**Files:** Create `scripts/release-plugins.sh`、`scripts/gen-plugin-index.mjs`

- [ ] Step 1: release-plugins.sh：对给定插件（md2pdf/roam-import/...）：构建产物（bin 双架构 / ui dist）→ 打包 `.notemdpkg`（tar czf 或 zip，视 Task 1 选型）→ minisign 签名（`minisign -S -s <key> -m pkg`，密钥路径 env `NOTEMD_PLUGIN_SIGNING_KEY`，默认 `~/.tauri/notemd-plugins.key`，缺失则报错并给 `minisign -G` 生成指引）→ sha256 → 产出到 `dist-plugins/<id>/<version>/`。**不上传**（上传是 wrangler 步骤，脚本尾注释给命令 `wrangler r2 object put` + KV 更新）。
- [ ] Step 2: gen-plugin-index.mjs：扫 `dist-plugins/` 生成 `index.json`（RegistryEntry 数组：id/version/min_host[从 manifest.engines]/archs/size/sha256/name/description/i18n/download URL 拼 `plugins.notemd.net/api/download/...`）→ 写 `dist-plugins/index.json`；尾注释给 `wrangler kv key put index --path dist-plugins/index.json` 命令。
- [ ] Step 3: 本地验证：对 md2pdf v2 跑 release-plugins.sh（用测试密钥）→ 产出 `.notemdpkg` + `.minisig` + index.json；用 Task 1 的 verify_and_stage（写个一次性 `cargo test` 或 example）验证本地包能过验签。报告产物。
- [ ] Step 4: Commit `feat(plugin-v2): release-plugins.sh (package+minisign+sha256) + index generator`。

---

### Task 6: 插件市场窗口 + 能力同意 UI + 退役 PluginsSettingsTab

**Files:** Create `plugin-market.html`、`src/plugin-market-main.ts`、`src/plugin-market-app.svelte`、`src/components/market/*`；Modify `vite.config.ts`、`src-tauri/capabilities/default.json`、`src-tauri/src/lib.rs`（窗口 fn + 菜单项）、`src/components/SettingsDialog.svelte`（退役 tab→入口）、i18n `en/zh/ja/de`

- [ ] Step 1: 独立窗口（克隆 insights.html/insights-main.ts/insights-app.svelte + show_insights_window→`show_plugin_market_window`，label `plugin-market`，进 capabilities windows，vite rollupOptions 加 `pluginMarket: 'plugin-market.html'`）。
- [ ] Step 2: market-app.svelte：onMount loadSettings+loadLocale；三区：已装（`plugin_market_installed`：启停开关/卸载/更新按钮）、可装（`plugin_market_index` 减去已装：安装按钮）；操作经 invoke 对应命令，pushToast 反馈；操作后重取列表。
- [ ] Step 3: **能力同意模态** `src/components/market/ConsentModal.svelte`：安装前调 `plugin_market_preview(id,version)` 拿真实 manifest.capabilities → 渲染 capability→人类可读（新增 i18n `capability.*` 键：vault.read/vault.write/dialog/fs.read:dialog/clipboard.write/toast/renderer.html/settings/secrets/editor.events 等）+ 敏感项(vault.write/secrets)高亮警告 → 用户确认才 `plugin_market_install`。兑现 ②安全评审 V1。
- [ ] Step 4: 退役 PluginsSettingsTab：SettingsDialog 的 plugins tab 内容替换为一句说明 + "打开插件市场…"按钮（invoke `show_plugin_market_window`）；保留 v1 插件的启停仍在此？——否，v1 插件启停也迁市场窗口的"已装"区（v1 manifests 经 get_all_plugin_manifests 也列出，统一）。删 PluginsSettingsTab.svelte 或留作内嵌组件被市场窗口复用（择简报告）。View 菜单加 "Plugin Market…"（`open-plugin-market` → show_plugin_market_window，lib.rs on_menu_event + menu_label + i18n）。
- [ ] Step 5: i18n：market UI ~40 键 + capability ~12 键，四语言。
- [ ] Step 6: `pnpm check && pnpm vitest run` + `cargo test` + `cargo build` → PASS；手动 E2E 步骤写文档（flag 开→View▸Plugin Market→装本地测试注册表的插件→同意模态→装成功→reconcile 生效无重启→卸载）。
- [ ] Step 7: Commit `feat(plugin-v2): plugin market window + capability consent modal; retire PluginsSettingsTab`。

---

### Task 7: spec 回写 + 多轮 review（含安全）

- [ ] Step 1: spec §19「实施记录（子项目③）」：包格式 `.notemdpkg`；minisign 验签（复用 updater 密钥体系，独立插件密钥）；无重启 reconcile 机制；注册表 worker + R2/KV 布局；**用户步骤清单**（生成插件签名密钥对、填真 pubkey 进 `PLUGIN_REGISTRY_PUBKEY`、建 CF KV/R2/custom domain、设 repo secret、首次 wrangler deploy、发布用 release-plugins.sh + wrangler 上传）；能力同意 UI 兑现 ②评审 V1；仍未做（②评审 V3 per-window nonce、V5 写配额/线程上限）继续记为第三方前置。
- [ ] Step 2: 全量回归 + 三视角 review（执行/安全/集成）→ 修复轮收敛。安全重点：验签不可绕过、下载大小上限、路径穿越、reconcile 不误杀、flag-off 惰性、同意 UI 展示的 capabilities 与实际安装的一致（preview 与 install 同源验签）。
- [ ] Step 3: Commit + 汇报。

---

## Self-Review 记录

- **Spec 覆盖**：§8.1 服务端（T4）、§8.2 客户端市场窗口+CLI+consent（T2/T3/T6）、§8.3 发布链（T5）、§3 安装布局+签名（T1，复用①的 state.json）、§4.2 启停即时生效（T2 reconcile 补上①遗留的"需重启"）、②评审 V1 能力同意（T6）。
- **占位符**：PLUGIN_REGISTRY_PUBKEY 本期填测试公钥、真钥用户替换（T1/T2 明确 + T7 用户步骤）；CF 部署与 R2/KV 创建为用户步骤（T4 README + T7）；签名密钥生成为用户步骤（T5 报错指引）。均非 TBD，是明确的 user-gated 边界。
- **类型一致性**：RegistryEntry（market.rs）↔ index.json（gen-plugin-index）↔ worker 返回三处字段一致；InstallError 贯穿 T1/T2/T3；verify_and_stage 签名 T1 定义 T2/T3/T5 引用一致。
- **风险**：包解压格式（zip vs tar+flate2）依 T1 Step 1 现有 dep 定，选定后 T5 打包命令须匹配（T5 Step 1 注明"视 Task 1 选型"）；minisign-verify crate API 以实现时版本为准；reconcile 误杀活动窗口/进程——reconcile 只对"已不在新 map"的插件 deactivate，活动中的被卸载插件先 deactivate 再删目录（T2 Step 2 顺序）。
