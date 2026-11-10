# Final Sumi candidates validation

Date: 2026-11-10 (Asia/Taipei). All source changes remain uncommitted; no input method installation, launch or input-source switch performed.

## Reproduction

From `/Users/bruce/git/fcitx5-macos-sumi`:

```zsh
source build-tools/env.sh
cmake --build build/arm64 --target Fcitx5 sumi-core-filter-cpp sumi-candidates-cpp sumi-bridge-swift sumi-pinyin-cpp -j 4
ctest --test-dir build/arm64 --output-on-failure -R '^(sumi-core-filter-cpp|sumi-candidates-cpp|sumi-bridge-swift|XmlParser|key-cpp|KeySwift|KeyEventSwift|TagSwift|ColorSwift|StatusSwift|key-release-cpp)$'
build/arm64/tests/sumi-pinyin-cpp build/pinyin-isolation/prefix
build/arm64/tests/sumi-pinyin-cpp build/pinyin-isolation/prefix --keyboard
```

`KEY_LOGGING:BOOL=OFF` verified in CMakeCache.txt. Complete app and all four test targets build successfully without compiler warnings/errors. Final incremental check reports `ninja: no work to do.`

## Results

- 11/11 selected CTest tests pass. This includes production Swift transport, exact-context C++ actions with synchronous flush assertions, and all upstream CommonCandidateList tests plus the second filter layer tests.
- Actual official pinyin engine: baseline `nihao` index 1 contains 👋, claiming Sumi excludes it, releasing restores it. Clicking filtered index 1 and separately sending key `2` through production `frontend.keyEvent` both commit `拟好` exactly once. Both modes also verify `你好`, `shi` paging, page-relative number key selection, emptied candidates, stale serial and cross-focus rejection.
- Pinyin logs report missing history in the deliberately empty isolated user environment; expected, not a dictionary/model failure. No user dictionaries/configuration were used.
- Source review: candidate actions flush UI before `popState` and before clearing `isSyncEvent`; deferred preedit path identified in first review is repaired. Second layer retains original engine filter, shares candidate index space with keyboard selection, and engine mutations drop saved raw pointer views before erasing/replacing words. A copied shared list keeps candidate ownership alive during selection. Release rebuilds original panel while suppressing client preedit replay.
- Ready handshake fix reviewed and revalidated: `refreshSumiCandidates` calls the existing no-client-preedit redraw when the production WebPanel belongs to the same instance. WebPanel publishes/filters once at the beginning of update, then builds the still-visible default candidates from the same filtered list. `sumiRedrawing_` prevents replay of client preedit. No duplicate publish/serial was added. These tests do not instantiate WebPanel; this specific path has code-review and full-build evidence, while the underlying filter/key routing has real-engine evidence.
- Three core patches replay together on gitlink `5ffd9e5f905078880f1e21752e10b63490734809` using a temporary GIT_INDEX_FILE. All six affected files byte-match the current core submodule; no other dirty core files. No existing index, branch or worktree was changed.

## Evidence

- build-final-candidates.log / build-final-candidates-check.log
- tests-final-candidates.log
- pinyin-final-click.log / pinyin-final-keyboard.log
- core-patch-replay.json
- app-final-candidates.sha256

Real engine testing here is an isolated process with production MacosFrontend, not a system-installed IMK/AppKit end-to-end acceptance test. Three unrelated upstream tests (config-cpp, icon-cpp, layout-cpp) remain intentionally outside this safe suite because of user config writes or hardcoded installed paths.
