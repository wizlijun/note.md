Archive of the executed regression. Copy this directory to `tasks/omarchy-build/sumi-detach-mount-regression` before running; its path guards intentionally depend on that isolated location. The completed 16-round result and restore hashes are in the parent evidence directory.

# Isolated host detach/mount regression

This describes the staging procedure used for the recorded isolated test.
`harness.js` uses the production `window.notemd` bridge and real GTK backend.
It performs no text edits and creates no page. An existing isolated active page
is required. Do not type or navigate while it runs.

After the final visual acceptance, the probe operator may stage this UI only in
their existing isolated plugin install, then reload its Sumi window:

```sh
python3 tasks/omarchy-build/sumi-detach-mount-regression/stage.py install --ui tasks/sumi-omarchy-acceptance/data/net.notemd.app/plugins/notemd.sumi/0.1.10/ui --record tasks/omarchy-build/sumi-detach-mount-run1
```

The harness replaces the entry temporarily and does not load the production
module, avoiding its cached surface handle and resize callbacks. It starts on
page load. Sixteen rounds race detach(A) against mount on the same real page.
If mount returns a new B, bounds/visible/focus(B) must work and a further mount
must return exactly B. A mount that wins before detach and returns A is recorded
separately as a legitimate ordering. At least one new-B survival round is
required for `passed`. This observes real scheduling, not exhaustive interleaving.

After completion the final surface is hidden for reporting. F8 selects the JSON
textarea; persist its exact contents to `result.json` in the record directory.
The same JSON is retained in localStorage `sumi-isolated-detach-mount-result-<timestamp>`;
`sumi-isolated-detach-mount-latest` stores that unique key, also recorded in the
report's `storageKey`. The probe can read its isolated WebKit localStorage SQLite
without using Ctrl-C if the host intercepts that shortcut.
Record the tested host binary hash and inspect the actual GTK widget tree if
that facility is available; this JS does not invent a TextView count. Compare
the isolated Markdown file before/after to independently confirm unchanged text.

Always restore before returning to normal plugin UI:

```sh
python3 tasks/omarchy-build/sumi-detach-mount-regression/stage.py restore --record tasks/omarchy-build/sumi-detach-mount-run1
```

Reload the restored window to recover its JS handle through the normal mount
rebind path. The helper preserves the original index, verifies injected-file
hashes before replacement, removes its own asset, and compares **every** UI asset
hash against the original snapshot. It permits only paths inside the isolated
build directory or the one exact acceptance UI directory shown above, which the
probe operator confirmed. Neither installation nor restoration runs automatically.
