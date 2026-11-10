Linux x86_64 / Omarchy release.

- Fix Sumi focus writing that repeatedly jumped by one pixel in long documents. The editor now matches GTK's integer scroll coordinates when calculating the focus position.
- Hide the native editor scrollbar and frame while preserving scrolling and the input position outside focus mode.
- Restore native body mouse input: the focus decoration's own GTK window now passes input through, allowing click-to-position, text selection and mouse-wheel scrolling.

Existing Sumi 0.1.12, NEXT 1.13.3 and Idea Spark 1.3.8 remain compatible; no plugin or Fcitx addon update is required. This release retains the window, fullscreen and shortcut fixes from [6.1110.4](https://github.com/wizlijun/note.md/releases/tag/v6.1110.4). macOS and ARM packages retain their existing releases.

6.1110.5 was an unpublished validation build that failed the mouse-input release gate.
