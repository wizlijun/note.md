# tauri-plugin-native-editor

Host-controlled native rich-text surfaces for Sumi. The macOS backend uses an
ARC Objective-C AppKit bridge and `NSTextView(initUsingTextLayoutManager:YES)`.
Other platforms return unavailable; macOS requires 13+. There are no public JS
mount commands and no Markdown, disk, credential, or sync implementation here.

## Host contract

Register `init()` once on the host Builder. Authorize the plugin, Vault, page,
tab and session generation in the host **before** calling these Rust APIs:

- `mount(&window, SurfaceConfig, EventHandler)` — mount above the actual WKWebView
  as its native sibling. Bounds are logical points relative to the top-left of
  the WebView viewport. The bridge converts through its NSView coordinates,
  including title-bar/safe-area offsets; callers do not add window decorations.
- `command(&window, id, generation, SurfaceCommand)` — bounds, appearance,
  focus, visibility or document projection.
- `inspect(&window, id, generation)` — revision, visible text, selection,
  composition and the actual TextKit 2 state (for acceptance/debugging).
- `detach(&window, id, generation)` — remove only the matching surface.

`register_font(window, fixed_resource_path, expected_family)` is Rust-only. It
registers trusted bundled faces with CoreText process scope, checks
the real family, and retains its actual descriptor for layout. It never installs
a system font. Missing resources and mismatched families fail explicitly.

`register_font_cascade(window, alias, families)` composes only descriptors already
registered through trusted resources. The first family is the primary face;
remaining families supply missing glyphs in order. Sumi's typewriter preset uses
Courier Prime for Latin, Zhuque Fangsong (technical preview) for Chinese, and Source Han Serif SC for
rare glyphs. It never promotes the Chinese font's Latin face to the primary.

All APIs dispatch to the main thread. A surface identity is scoped to the host
window. Duplicate mounts and stale generations fail. Destroyed Tauri windows
clean up their surfaces; the host must still explicitly flush and detach on tab,
Vault and plugin lifecycle transitions. Do not forcibly detach during IME.

`Edit` is a committed UTF-16 replacement against `base_revision`. The in-process
handler synchronously applies it to the host's in-memory model and returns a
strictly greater revision. The handler must validate before mutating: an error must not leave a partially
applied core transaction. Failure restores the pre-edit native display; the host
owns error/recovery messaging. A later persistence error must preserve the already
accepted in-memory draft, not reject an already committed edit. Do not perform synchronous disk I/O in this callback
or reenter native operations. Return `EventReply { revision, projection }` with
any rich projection and resolved selection; native installs it before another
input event can run. Action and Paste use the same atomic reply. The host controls
durable save acknowledgement separately. Remote updates use `transaction`: inspect
revision and composition, admit the host mutation, and apply its projection in one
main-thread turn. A rejected composition never invokes the host mutation.

Marked text emits no Edit. At IME completion the native surface emits one committed
Edit, then `Composition(active=false)`. `ApplyDocument` and appearance/visibility
changes return `composition active` while composing. The host must queue/rebase
remote operations and render them after that completion event, not drop them.
`ApplyDocument` also checks the expected native revision; it replaces the minimal
visible range and updates only changed style spans. Identical text/runs skip
attribute writes. Runs should be flattened, non-overlapping spans containing all
combined attributes (e.g. bold + italic + heading). Ranges use UTF-16, not
UTF-8 bytes. The host's source map converts to canonical Markdown coordinates.

AppKit text undo is disabled: `Action(undo/redo)` routes to the CRDT undo owner.
Formatting is also an Action; attributed-only AppKit edits are rejected. Plain
paste emits an ordinary Edit. HTML/RTF paste emits `Paste` with plain fallback, optional HTML and
optional base64 RTF for host sanitization; the host must apply the accepted render or report a
fallback. The bridge never imports arbitrary HTML into AppKit.

Actions: Cmd+Z undo, Cmd+Shift+Z redo, Cmd+B bold, Cmd+I italic, Cmd+Shift+X strike,
Cmd+N new_page, Cmd+Option+Left/Right previous_page/next_page, Escape menu.
Option+Arrow retains the system word-navigation behavior. IME owns these keys
while composing. Host menus must route native first-responder actions correctly.

## Verification

The `native/probe.m` executable creates a real AppKit window and tests TextKit 2,
range editing, rejection, programmatic composition, remote revision gates, rich
runs, undo routing, hiding and teardown. Build it with a matched Xcode SDK:

```sh
xcrun clang -isysroot /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk -fobjc-arc -mmacosx-version-min=11.0 native/probe.m -framework AppKit -framework Foundation -framework CoreText -framework QuartzCore -o /tmp/sumi-appkit-probe
```

Run from the repository root (the probe writes `tasks/sumi-native/appkit-events.json`).
This proves native API behavior, **not** real physical IME/candidate behavior,
Tauri layering, performance, or accessibility. Those remain host acceptance gates.

The real Tauri `native-probe` example uses the isolated `tasks/sumi-native` folder.
Its Snapshot button writes diagnostic events plus `probe-draft.txt`, which the
next launch restores. It has no production Vault access or real sync transport.
Undo, format and rich-paste events are diagnostics here, not a replacement for
the host's write-core implementation.

`native/font-probe.m` uses the same Clang/link flags and takes the absolute bundled
OTF path. It checks missing/mismatched rejection, repeated process registration,
and the real family/face attached to NSTextView storage. It does not install fonts.

`native/typewriter-probe.m` takes the absolute `resources/sumi` directory and checks
actual CoreText glyph-run PostScript faces for the five selected combinations.
It verifies both Plex Light weights, rejects a Light file registered as Regular,
and reports the actual system fallback for a character outside each selected
combination. It does not claim those characters are covered by the bundled faces.
It does not show a window or install fonts.
Descriptor names alone are insufficient.

The standard macOS Control-Command-F shortcut emits `fullscreen`; the host targets
the owning window directly. Fixed normal window dimensions are restored by tao
after leaving fullscreen. The Web controls query window state for enter/exit labels.

`SurfaceConfig` includes an initial UTF-16 `selection` and `viewport` (`start`,
`offset` in logical points). `SurfaceState` and native `viewport` events expose
the same reading position. The macOS implementation uses TextKit 2 segment
geometry, preserving a partially visible line without asking IME geometry for
an off-screen rectangle. Programmatic bounds updates do not emit user position
changes. The host converts positions to page/epoch/root-bound CRDT anchors,
coalesces small preference writes, and forces a final snapshot on detach/close.

## Insertion caret

The custom caret replaces the ordinary system line with a slightly heavier
vertical stroke (2–3 logical points). Its height is the overall writing font's
ascent minus descent; paragraph line spacing, nearby CJK/Latin characters and
heading sizes do not change that height. It follows the actual TextKit 2 baseline.

`Appearance.caret_motion` defaults to `breathing`; `steady` stays fully opaque.
Breathing uses a public Core Animation opacity animation from 1 to 0.25 and back
over six seconds, requesting 30 fps. Input, selection and remote updates preserve
the phase. No application timer or animation frame triggers text layout. Hidden,
inactive, selected-range and offscreen states remove the animation; Reduce Motion
uses steady mode. The host persists the preference as `caretMotion`.

Marked text uses the same custom caret, including selected IME clauses.
`shouldDrawInsertionPoint` suppresses the system caret and the public
`insertionPointColor` stays transparent throughout composition: modern AppKit can
retain an indicator even when the former returns false. The custom caret reads
the theme foreground independently. Native input and host update transactions
preserve a visible caret until their final insertion geometry is ready; transient
missing layout does not clear its frame. A coalesced main-queue refresh and native
layout completion retry geometry. No private indicator APIs, global defaults or
input-method geometry are changed.

`native/caret-probe.m` tests geometry, fixed font metrics, animation configuration,
stable phase and steady mode. `native/caret-render-probe.m` supplies a real
TextKit 2 system-caret positive control, captures AppKit bitmap pixels, checks the
single custom caret through font/theme changes and IME, and verifies a suppression
mutation exposes a duplicate. Continuous state observations and immediate raster
samples cover marked-text updates, selected clauses, replacement, newline and
commit with the bundled 32pt Zhaohua/sepia/steady preferences. Use the Clang flags above with deployment target
13.0 and run from the repository root. Both keep their windows unordered and use
an activation-prohibited application; active eligibility is simulated. This
proves offscreen native rendering, not final-package on-screen/physical IME
acceptance or measured animation frame rate.
