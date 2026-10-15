# Linux / Omarchy Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Linux beta build, desktop adaptations and gated three-platform release workflow described by the approved distribution spec.

**Architecture:** Build Debian 12 debs for two architectures; keep CLI and GUI in one binary with explicit GUI/deep-link routing. Expose distribution and desktop capabilities from Rust so package-managed builds never invoke the application updater. Omarchy repackages the deb through its existing repository workflow.

**Tech Stack:** Rust, Tauri 2, Svelte 5, TypeScript/Vitest, Bash, Docker/Debian 12, GitHub CLI, pacman PKGBUILD.

**Spec:** `docs/superpowers/specs/2026-10-15-linux-omarchy-distribution-design.md`

## Global Constraints

- Only `.deb`, x86_64 + aarch64, Debian 12 (bookworm); no AppImage/rpm/Flatpak/apt repository.
- `NOTEMD_DIST_CHANNEL=package-manager`; default `direct`; do not add any `linux-*` keys to `latest.json`.
- `note.md_<version>_amd64.deb`, `note.md_<version>_arm64.deb`, `SHA256SUMS-linux.txt`.
- Preserve macOS/Windows behavior, packaging and existing release gates. Do not change versions or publish during implementation.
- Linux beta excludes native-binary plugins without a Linux triple and app-internal agent panels. Pure UI plugins must remain available when packaged for the platform.
- Main checkout `/Users/bruce/git/mdeditor` is the development workspace, per recorded user instruction in `tasks/lessons.md` (2026-10-10). Do not create a development branch/worktree. Preserve existing untracked files. The release script's temporary tag worktree is an artifact build, not the agent's development workspace.
- Commit only each task's verified changes, with explicit paths; never `git add .`. Do not push or publish. Read `AGENTS.md` and relevant lessons.
- Spec L4 requires the user's Omarchy machine. Docker/host tests do not prove fcitx5, Hyprland, tray or aarch64 native UI acceptance. Record these as pending.
- L5 live prerelease rehearsal and L6 upstream PR need external actions; prepare scripts/recipe and local evidence now. External PR is explicitly user-confirmed in spec §7.3.
- Behavioral changes use observed RED → GREEN tests. Configuration/layout validation should validate the actual merged config / generated package, not mirror source strings.
- Reports must distinguish code implementation, successful tests, actual container build and unavailable real-machine acceptance. Network failures are evidence gaps, never passing builds.

## File map and shared interfaces

- `src-tauri/tauri.linux.conf.json`, `src-tauri/linux/notemd.desktop.hbs`, root `LICENSE`: Linux bundle definition.
- `scripts/docker/linux-build.Dockerfile`, `scripts/docker/linux-build.sh`: build container and in-container entrypoint; sibling `/input/moraya-core` is required, source input is read-only; cache Rust per architecture.
- `src-tauri/src/cli/mod.rs`, `cli/install.rs`: GUI detection and macOS-only CLI installation.
- `src-tauri/src/platform.rs`: native capabilities / distribution / desktop policy; `src/lib/platform.svelte.ts`: platform identity including Linux and Windows. Keep related helpers focused; no unrelated port refactor.
- `desktop_capabilities` Tauri command returns `{ distributionChannel: 'direct' | 'package-manager', cliInstall: boolean, themeFontInstall: boolean, setDefaultApp: boolean, location: boolean, globalShortcuts: boolean, windowDecorations: boolean }`; names are camelCase via serde. Native host triple is supplied by `plugin_market_host_triple() -> String` in Task 4.
- `src/lib/desktop-capabilities.svelte.ts`: process-lifetime capability cache/state for settings and updater. Initialization errors must not silently opt package builds back into updater checks.
- `src-tauri/src/linux_env.rs`: allowlisted pre-GTK config loading, compiled on Linux; pure parser can be tested on the host.
- `src-tauri/src/lib.rs`, `preview_window/mod.rs`, `plugin_runtime/windows.rs`: launch action dispatch, shortcut policy, window decoration policy, tray compatibility.
- `src/lib/market/select.ts`, `src/plugin-market-app.svelte`: platform-compatible version selection / install filtering.
- `scripts/release-linux.sh`, `scripts/release-publish.sh`, `scripts/release-linux-verify.sh`, small pure `.mjs` release validation helper if needed: local verification before any remote mutation.
- `docs/linux-omarchy.md`, `packaging/omarchy/notemd/{PKGBUILD,.omarchy/package.json}`: usage, acceptance checklist and reviewable upstream contribution.

### Task 1: Debian bundle and P0 executable routing

**Files:** Create root `LICENSE`, `src-tauri/tauri.linux.conf.json`, `src-tauri/linux/notemd.desktop.hbs`, `scripts/docker/linux-build.Dockerfile`, `scripts/docker/linux-build.sh`. Modify `src-tauri/rust-toolchain.toml`, `src-tauri/src/cli/mod.rs`, `src-tauri/src/cli/install.rs`; Linux compile blockers may require precise cfg fixes with evidence. Tests in CLI modules and `scripts/linux-bundle.test.ts`.

**Interfaces:** Consumes existing `is_cli_mode(&[String]) -> bool` and GUI_FLAG `--gui`. Produces deb config/entrypoint consumed by Task 5. Container entrypoint accepts a Rust triple, copies `/input/mdeditor` and `/input/moraya-core` to sibling directories under `/build`, builds only the root host with frozen lockfile, exports package-manager channel, writes deb to `/output`. Source mounts must not copy host `node_modules`, `target`, `.git`, ignored stores or secret `.env*`.

- [ ] Step 1: Add routing tests to `cli/mod.rs` with `/usr/bin/notemd --gui` → false, bare binary → true, `notemd://share/open?x=y` → false, and explicit `--cli` retained except explicit `--gui`. Example:
  ```rust
  assert!(!is_cli_mode(&["/usr/bin/notemd".into(), "notemd://share/open?x=y".into()]));
  ```
  Run `cargo test --manifest-path src-tauri/Cargo.toml cli::tests --lib`; save the expected deep-link failure.
- [ ] Step 2: Add macOS-only install capability guards; Linux/Windows install and uninstall return unsupported before touching paths or invoking processes. Scope platform-specific tests accordingly; exercise unsupported operations against a temporary directory (no changes). Run the routing/installation tests after minimal implementation:
  ```rust
  if argv.iter().skip(1).any(|a| a.starts_with("notemd:")) { return false; }
  ```
  Keep `--gui` first; document precedence for `--cli`.
- [ ] Step 3: Create Linux config with `bundle.targets=["deb"]`, `createUpdaterArtifacts=false`, PNG icons, deb dependencies from spec, desktop template, MIME types for md/txt/canvas, Apache license/file. Validate with installed Tauri schema and merged main+Linux config in the test. Use Tauri's actual handlebars variables from installed bundler sources (not guessed names):
  ```ini
  Exec=notemd --gui %U
  MimeType=text/markdown;text/plain;application/json;x-scheme-handler/notemd;
  ```
- [ ] Step 4: Create Debian 12 toolchain image and entrypoint, respecting `rust-toolchain.toml` and packageManager version. Install Node 22/Corepack, Debian development dependencies in spec; do not copy secrets/build artifacts. Set `CARGO_TARGET_DIR=/cache/target`; caller mounts per-architecture cargo registry/git/target volumes. Include package-managed environment in compiler invalidation when Task 2 adds build.rs handling.
- [ ] Step 5: Run focused tests, shell syntax, schema validation and actual arm64 Docker image/build if available. Confirm package content through `dpkg-deb` and record naming/layout/time in spec §4.3 only when observed. Do not claim dual architecture success from one build. Save logs under this plan's SDD workspace. If network/tooling blocks container, capture precise blocker and continue independent code tasks.
- [ ] Step 6: Inspect diff and commit explicit verified source paths as `feat(linux): add Debian bundle and executable routing`; report RED/GREEN, container status, files and SHA.

### Task 2: Distribution capabilities and package-manager updater policy

**Files:** Modify `src-tauri/src/platform.rs`, `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src/lib/platform.svelte.ts`, `src/lib/platform.test.ts`, `src/lib/updater.svelte.ts`, `src/components/SettingsDialog.svelte`, locale files under `src/lib/i18n/`. Create `src/lib/desktop-capabilities.svelte.ts` and focused capability/updater tests; extend existing SettingsDialog test.

**Interfaces:** Consumes Task 1 installation platform guard. Produces `desktop_capabilities` command and frontend state from File map. `distributionChannel` comes from Rust `option_env!("NOTEMD_DIST_CHANNEL")` (not runtime override); build.rs emits `cargo:rerun-if-env-changed=NOTEMD_DIST_CHANNEL`. Native policies default globalShortcuts/windowDecorations to current supported behavior until Task 3.

- [ ] Step 1: Add RED tests: Linux/Windows retained as distinct `Platform`, macOS/iOS unchanged; package-manager `initUpdater()` and `runCheck()` call neither plugin updater check nor store hydration even with cached newer version; direct-channel check still operates. Use native invoke mock only at IPC boundary; assert real updater state transitions and visible settings behavior.
  ```ts
  expect(await platform()).toBe('linux')
  await initUpdater(); await runCheck({ forceFresh: true })
  expect(check).not.toHaveBeenCalled()
  ```
- [ ] Step 2: Implement native command with serde camelCase fields, default direct channel, macOS-only capabilities. Cache authoritative capabilities in frontend; load failure must block checks with visible/retryable error rather than default `direct`. Retain direct channel updater behavior after successful identity load. Do not pollute shared browser editor bundle with desktop imports.
- [ ] Step 3: Settings updates tab displays localized package-manager guidance including `omarchy update` and current version, omits app check/install controls. Hide CLI installation, default-app association, theme font installation and location controls by capabilities; leave relevant read-only information. Extend existing tests' invoke fixtures to return meaningful macOS capabilities rather than relying on unhandled mocks.
- [ ] Step 4: Run targeted Vitest files, existing SettingsDialog/platform tests and `node_modules/.bin/svelte-check --tsconfig ./tsconfig.json`; run focused Rust capability tests. Report pre-existing warning baseline separately.
- [ ] Step 5: Commit explicit files as `feat(linux): expose desktop capabilities and package-managed updates`; report command signatures, evidence and SHA.

### Task 3: Linux startup environment, Wayland actions and desktop policy

**Files:** Create `src-tauri/src/linux_env.rs` and action helper if needed; modify `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/platform.rs`, `src-tauri/src/shared_config.rs`, `src-tauri/src/preview_window/mod.rs`, `src-tauri/src/plugin_runtime/windows.rs`, `src/lib/desktop-capabilities.svelte.ts`, `src/lib/settings.svelte.ts`, `src/components/SettingsDialog.svelte`, locale files and focused tests.

**Interfaces:** Uses Task 2 command. `globalShortcuts` false for Linux with `WAYLAND_DISPLAY` set and `GDK_BACKEND != x11`; skip registration AND plugin initialization if initialization itself needs X11. `notemd --gui --action smart-search` or `--action plugin:<plugin_id>:<window>` handled once on initial and subsequent launches. Exact action names must not be mistaken for file paths. Window policy exposes boolean default and persisted `linuxWindowDecorations: boolean | null` override.

- [ ] Step 1: Add RED parser tests rejecting unknown keys, executable expressions and malformed lines; accept comments/blank lines/KEY=VALUE without shell expansion and only five spec keys. Tests read fixture paths, never mutate host process environment. Add session policy tests:
  ```rust
  assert!(!supports_global_shortcuts("linux", Some("wayland-1"), None));
  assert!(supports_global_shortcuts("linux", Some("wayland-1"), Some("x11")));
  ```
- [ ] Step 2: Load `$XDG_CONFIG_HOME/net.notemd.app/linux-env.conf` (fallback XDG standard config dir) after CLI detection and before `run()` initializes GTK; allow only `WEBKIT_DISABLE_DMABUF_RENDERER`, `WEBKIT_DISABLE_COMPOSITING_MODE`, `GDK_BACKEND`, `GDK_SCALE`, `GDK_DPI_SCALE`. No shell execution. Missing file is normal; malformed/read failures log safely and do not panic. Do not enable GPU workarounds by default.
- [ ] Step 3: Add RED action parsing/dispatch selection tests, implement shared initial/single-instance action dispatch to smart search or existing plugin-window opener. Preserve CLI background wake behavior and deep-link delivery. Unsupported/invalid actions must not open an arbitrary file/window.
- [ ] Step 4: Early-return Wayland shortcut reconciliation before touching X11 manager; avoid registering global-shortcut plugin where unsupported if required. Use native capability in settings to show localized copyable Hyprland command and a plugin-window example. Keep supported platform behavior intact.
- [ ] Step 5: Route seven specified auxiliary window decorations and the main window through one native policy. Default off under Hyprland, explicit settings override; apply changed override to existing app windows. Persist setting consistently in frontend/backend and migrate missing values to null. Linux tray builder does not call tooltip/title; keep menu status, close-to-tray behavior and explain pending real-machine acceptance.
- [ ] Step 6: Run focused Rust and frontend tests, Svelte checks, Linux cargo check/build when possible. Commit only this task as `feat(linux): adapt Wayland launches and window behavior`; report unverified Hyprland/fcitx5/CSD observations explicitly.

### Task 4: Plugin platform compatibility and portable font stacks

**Files:** Modify `src/lib/market/select.ts`, `src/lib/market/select.test.ts`, `src/plugin-market-app.svelte`, `src/plugin-market-app.test.ts`, `src-tauri/src/plugin_runtime/market.rs`, command registration in `src-tauri/src/lib.rs`, locales, and existing CSS/Svelte files with Menlo-only stacks. Use `rg -n Menlo src` to enumerate exact edited stack list in report. Body stack in `src/styles/app.css` / editor font defaults as actually present.

**Interfaces:** `plugin_market_host_triple() -> String` returns installer-authoritative platform triple; frontend compatibility uses `RegistryEntry.archs` and per-platform download metadata. Do not infer native vs UI from a plugin id. Registry UI-only entries with universal assets must follow actual installer convention (inspect before writing).

- [ ] Step 1: Write RED selection tests with newest macOS-only and older Linux-compatible version; compatible newest selected for Linux, incompatible entry remains discoverable but no Install/Update action; pure UI package remains available. Assert an unsupported click cannot invoke preview/install.
  ```ts
  // Extend selection API with optional host triple, preserving existing callers.
  expect(pickAvailable(entries, new Set(), '6.1015.1', 'x86_64-unknown-linux-gnu')[0].version).toBe('1.0.0')
  ```
- [ ] Step 2: Implement triple command using existing host triple utility, platform-aware available/update selection and localized unavailable label. Gate consent preview/install as well as visible button; account for async host triple load failure without offering invalid installation.
- [ ] Step 3: Replace existing Menlo-limited mono stacks with spec string:
  ```css
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, 'JetBrains Mono', 'CaskaydiaMono Nerd Font', 'DejaVu Sans Mono', monospace;
  ```
  Add `'Noto Sans CJK SC'` to actual body/default font stacks. Preserve layout/font sizing and existing popup menu styles. No artificial tests asserting every CSS literal; inspect production build CSS for inclusion.
- [ ] Step 4: Run market selection + rendered app existing/new tests, Svelte check and production build; record actual affected stack list and remaining intentional custom stacks.
- [ ] Step 5: Commit explicit files as `feat(linux): filter marketplace packages and extend fonts`; report SHA and tests.

### Task 5: Draft-first release workflow, Linux verification and publish gate

**Files:** Modify `scripts/release.sh`, `scripts/release-windows.ps1` only where necessary for draft semantics. Create `scripts/release-linux.sh`, `scripts/release-linux-verify.sh`, `scripts/release-publish.sh`, `scripts/release-publish-core.mjs`, `scripts/release-publish.test.ts`, `scripts/release-linux.test.ts`; minimal `.d.mts` if required by TS.

**Interfaces:** Task 1 Docker entrypoint. `release-linux.sh <tag>` only consumes an existing draft, builds its immutable source and both debs, verifies all before upload. `release-publish.sh <tag> [--without windows|linux]` checks existing uploaded assets + fetched latest JSON, then publishes. Export pure `validateRelease({ tag, draft, assets, latest, without })` for fixtures and CLI gate, and never equate fixture success with live release acceptance.

- [ ] Step 1: RED tests feed valid asset names from existing release scripts to gate then remove each required asset, change manifest version, omit each updater platform, inject `linux-*`, pass a non-draft release, omit platform without explicit flag. All invalid cases must throw before remote publication. Explicit missing Windows must allow a manifest without windows-x86_64 and must reject stale updater references to skipped assets.
- [ ] Step 2: Make macOS `gh release create` always draft; retain `--draft` as harmless compatibility alias; preserve prerelease flag and all existing gates/signing. Publish helper must preserve prerelease status (never mark a prerelease latest):
  ```bash
  gh -R "$GH_REPO" release edit "$TAG" --draft=false --latest
  ```
  Use `--latest=false` for prerelease rehearsal. Verify draft asset gh commands from official docs or read-only existing release API; adjust Windows only if needed, keep CRLF/style.
- [ ] Step 3: Implement Linux script preflight/tag-version check, temporary tag worktree and cleanup trap, sibling core read-only mount + commit log, two Docker platforms with separate caches. Upload exact two debs + checksum after both validate; never modify tag/version/latest.json. Do not include `.env*`, host target/node_modules or credential files in container input. Build may create worktree as defined by spec; never checkout user's main.
- [ ] Step 4: Implement package verifier using actual dpkg/ELF/readelf or objdump: package name/version/arch, binary e_machine, desktop `--gui` + scheme, icons/themes/license, maximum GLIBC<=2.36, no linked libssl. In Arch amd64 container install dependencies/extract, `ldd -r` without unresolved symbols and CLI `--cli --version` exact version. Do not run headless GUI as false smoke proof.
- [ ] Step 5: Publish gate downloads latest JSON/checksums (when checking deb identity), asserts assets and updater URLs/signatures refer to current tag/name, rejects Linux updater keys. Explicit `--without` prompts with exact tag/platform in interactive terminal; noninteractive cannot auto-approve. Verify `SHA256SUMS-linux.txt` matches both deb names/hashes. Do not add a blanket --yes bypass.
- [ ] Step 6: Run shell syntax, meaningful fixture/command-harness tests (fake remote CLI may assert upload/publish never executes on bad inputs), existing release tests; exercise local deb verifier on real package if built. Record live Windows/prerelease rehearsal pending instead of publishing.
- [ ] Step 7: Commit explicit files as `feat(release): gate draft publication on platform assets`; report tests, script usage and SHA.

### Task 6: Linux beta documentation, Omarchy recipe and final evidence

**Files:** Create `docs/linux-omarchy.md`, `packaging/omarchy/notemd/PKGBUILD`, `packaging/omarchy/notemd/.omarchy/package.json`. Modify `README.md`, `README.zh-CN.md`, `CHANGELOG.md`, `CHANGELOG.zh-CN.md`, actual website platform/download content and `website/public/llms.txt`, `website/public/llms-full.txt`. Add `docs/superpowers/reports/2026-10-15-linux-omarchy-implementation.md` and update spec observed facts only.

**Interfaces:** Uses Task 1 asset convention and Task 5 release order. Recipe points to a user-supplied already published release version; do not pretend current 6.1015.1 has debs or fill checksum placeholders. Prefer a preparation helper generating real pkgver/checksums from verified published assets, with checked-in template clearly marked unsubmitted and unusable until generated.

- [ ] Step 1: Add Linux beta entries under Unreleased, with package-manager update policy and known native-plugin/agent/Wayland limitations. Website can state upcoming beta, but must not show download links to absent release assets. Current macOS/Windows downloads remain correct. Both languages convey aarch64 not yet native-machine verified.
- [ ] Step 2: Document installation, `notemd` CLI, desktop/deep link, Hyprland binds, config allowlist with NVIDIA workaround opt-in, tray fold/close behavior, inotify note and exact §8 acceptance checklist. Add real three-stage build + publish sequence:
  ```bash
  scripts/release.sh
  # Windows: scripts/release-windows.ps1 <tag>
  scripts/release-linux.sh <tag>
  scripts/release-publish.sh <tag>
  ```
- [ ] Step 3: Prepare downstream recipe using bsdtar, exact depends/arch/license/options and watcher JSON from spec. Provide deterministic checksum preparation from `SHA256SUMS-linux.txt` verified against actual downloaded release debs; no SKIP checksum, invented hash, maintainer identity or external PR. Validate shell/JSON locally.
- [ ] Step 4: Run existing website tests and update only changed expectations; build site and app, run frontend regression suite once and Rust relevant/full tests where feasible. Review main baseline vs final changes; inspect `git diff --check` and commits; record validation boundaries without repeating unchanged suites.
- [ ] Step 5: Write durable implementation report containing commit range, tests/log paths, build results by architecture, deviations and pending L4/L5/L6 evidence. Update `tasks/todo.md` review. Commit explicit documents/recipe files as `docs(linux): describe beta distribution and Omarchy integration`.
- [ ] Step 6: Controller requests whole-change review using actual diff package; fixes use one worker and scoped review. No push, merge, publish or upstream PR during this implementation turn. Report exact completed/pending milestones and commits to user.
