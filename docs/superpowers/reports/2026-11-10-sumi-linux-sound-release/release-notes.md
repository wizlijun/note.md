Linux x86_64 / Omarchy release.

- Restore Sumi typing sounds on Linux. Plugin processes now inherit the desktop session runtime directory so the existing audio backend can connect to PulseAudio / PipeWire Pulse.
- Keep the plugin environment filtered; the runtime path is added only on Linux. macOS and Windows inheritance stays unchanged.

The existing Sumi 0.1.12 signed package and Fcitx addon remain compatible. No plugin reinstallation or audio device configuration change is required. This release includes the focus and pointer fixes from 6.1110.6.
