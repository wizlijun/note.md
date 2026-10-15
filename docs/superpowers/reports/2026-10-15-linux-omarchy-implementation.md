# Linux / Omarchy implementation evidence — 2026-10-15

## Scope and source association

The implementation sequence on `main` starts at `ec0cd76b` and includes:
`b1fb1df0` (Debian bundle/CLI), `c77c46fd` (capabilities/update policy),
`90d97900` + `cb5b6e2d` (Wayland/config/window behavior), `640778d3`
(market/font compatibility), and `5195fc42` (draft release gates).
Task 6 documents these changes, prepares an unsubmitted downstream recipe and
updates website source/generated content. Its exact commit and subsequent
review/fix commits will be recorded in the controller's final source ledger;
this report is part of that documentation commit, not a frozen release tag.

No version bump, push, release publication or upstream PR was performed.
The seven original untracked paths were preserved. The only pre-existing
tracked diff included by explicit controller authorization is the two-line
plan diff describing the Windows draft gate.

Durable evidence destination is `tasks/linux-omarchy-evidence/2026-10-15/`.
The controller must archive the corresponding SDD logs/reports/package outputs
there before cleanup; archival is pending at this Task 6 checkpoint. Log names
below refer to that destination. Missing/unarchived logs are not passing proof.

## Task 6 verification

All direct Vitest commands used
`NOTEMD_EMPTY_ENV_DIR=/Users/bruce/git/mdeditor/.superpowers/sdd/2026-10-15-linux-omarchy-distribution/empty-env`
and `pnpm_config_verify_deps_before_run=false`; no dependency installation or
credential-file read was requested. Host Rust used `RUSTUP_TOOLCHAIN=stable`.

- `python3 -m unittest discover -s packaging/omarchy -p 'test_*.py'`:
  loadable empty implementation RED: 5 failures, 1 error; implemented GREEN:
  **6 passed**. Actual temporary Debian ar files and SHA256 bytes test both
  architecture checksums, deterministic generated recipes, shell load/syntax,
  tampering, wrong versions, unpublished/incomplete releases, malformed
  manifests and non-ar payloads. Logs: `task-6-recipe-red-loadable.log`,
  `task-6-recipe-green.log`, `task-6-recipe-final.log`.
  The first missing-module attempt is retained separately as
  `task-6-recipe-red.log`; it is not the behavioral RED evidence.
- `bash -n packaging/omarchy/notemd/PKGBUILD` and
  `python3 -m json.tool packaging/omarchy/notemd/.omarchy/package.json`:
  exit 0. Running the unprepared template exits 1 by design, with preparation
  instructions (`task-6-template-guard.log`). No checksum bypass or fabricated
  maintainer identity. The helper's live `gh` download path has not been
  exercised against a published Linux release, since none exists yet.
- `node_modules/.bin/vitest run website/src`: **4 files / 67 tests passed**,
  exit 0 (`task-6-website-tests.log`). Existing download/platform behavior
  remains covered; new content checks enforce unpublished Linux assets and
  aarch64 native-machine disclosure without new Linux download URLs.
- From `website/`, `python3 build_i18n.py` and `python3 build_pages.py`:
  exit 0, all three translated homepages generated with no unmatched strings,
  52 sitemap URLs (`task-6-sitebuild.log`, `task-6-pages-build.log`). Only the
  intended homepage content changed; no deployment was performed.
- `node_modules/.bin/vitest run`: **392 files / 4957 tests passed, 1 file /
  1 test failed**, exit 1, 74.81s (`task-6-frontend-full.log`). Failure:
  `src/editor-kit-v2/file-owner.test.ts`, binary attachment paste `stale=false`,
  initial mount waiting for `fileEditorSession(tab.id)` to become defined.
  `node_modules/.bin/vitest run src/editor-kit-v2/file-owner.test.ts` then
  passed **51/51**, exit 0, 2.98s (`task-6-file-owner-recheck.log`). The isolated
  run did not reproduce the failure; its cause is unproven. No timeout or
  unrelated product change was made. Controller's subsequent UI fixes justify
  a final full run; this checkpoint does not claim a completely green full suite.
  Existing Svelte warnings and happy-dom localhost resource errors occur in
  these logs; passing tests do not imply pristine stderr.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib --offline`:
  **1331 passed**, exit 0, 51.10s (`task-6-rust-full.log`). This is macOS host
  Rust verification, including relevant Linux parser/policy test modules;
  it does not exercise Linux GTK or native desktop behavior.
- `git diff --check`: exit 0. Exact spec §8 checklist copy and recipe required
  constants were locally compared; see `task-6-doc-validation.log`.
- Production app build was already successful in Task 4; Task 6 changes no app
  sources or assets, so it was not repeated. Website generation was repeated
  because its generator/HTML content changed.

## Architecture and build boundaries

Actual build observations supplied by the controller, associated with source
snapshot `640778d3` and readonly sibling core
`97fcc3e41f1791c763effe9de880cf4302feea32`:

| Architecture/check | Observed result | Boundary |
| --- | --- | --- |
| arm64 Debian 12 native Colima container | exit 0; cached Rust 4m04, container 5m38 | Not cold total, not desktop UI |
| arm64 real deb | `note.md_6.1015.1_arm64.deb`, SHA256 `9780e6ec8de83a57290278dea8faefe7aa19577fe71e2bbc8076480469fd4fa0` | Local unpublished package |
| arm64 ELF/layout/CLI | ARM ELF64; max GLIBC 2.35; no direct libssl; Package note-md; CLI exit 0 | Debian container/static evidence |
| Task5 final verifier on arm64 deb | exit 0 | Not Arch/native-machine acceptance |
| amd64 Debian 12 | Rust compiling at this checkpoint | Final result to be supplied by controller |
| Arch runtime | Dependency downloads not yet complete | No runtime pass claimed |

Logs/packages to archive include `task4-arm64-build.log`,
`task4-arm64-output/`, `task5-final-arm64-verifier.log`, and the controller's
amd64/Arch logs. The older local QEMU7.0 Node issue required a process-scoped
readonly PATH wrapper during the amd64 probe; this does not prove the
unmodified default release script succeeds on that old local environment.
The Arch probe's default seccomp path failed; isolated diagnostic flags passed
that boundary but mirrors subsequently timed out. A cached retry was ongoing.
No diagnostic workaround was added to product or release configuration.

A build of `640778d3` cannot prove the final reviewed commit or a future frozen
release tag was built. The controller will append final-snapshot architecture
results and the whole-change review disposition after the final fixes.

## Public availability, deviations and pending milestones

Read-only release audit found `v6.1015.1` public and stable with seven macOS
assets, no Windows/Linux assets. Website copy therefore says Linux beta is
being prepared, and existing macOS/Windows download resolution is retained.
The recipe uses a user-selected already published stable version, not the
unavailable current Linux version. It retains exact spec architectures,
dependencies, license, options and watcher; its license source was confirmed
against the real arm64 package layout. The generator verifies downloaded bytes
against the same release's manifest, not an independent cryptographic signer.

L1–L3 code implementation has local test/build evidence subject to the pending
final-snapshot builds/review. **L4 remains pending** for Omarchy/Hyprland,
fcitx5, tray folding/close behavior, fractional scaling, installed xdg/browser
handling and actual aarch64 desktop UI. Deep-link dependency-source observation
is not runtime acceptance. The exact ordered spec §8 checklist is reproduced
in `docs/linux-omarchy.md` without marking any real-machine item passed.

**L5 remains pending** for a real three-platform draft prerelease rehearsal,
including Windows-host gh view/upload/download. Shell fixtures and read-only
host gh source inspection are not L5. **L6 remains pending** for downstream
build/check-fast-ring/native aarch64 CI and the user-confirmed upstream PR.
No `auto_merge` was requested. Existing public packages are not implied by
preparation, local validation, a version number or a task checkbox.
