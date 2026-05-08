# Plugins

This directory holds bundled plugins. Each plugin lives in its own subdirectory:

```
plugins/
  <plugin-id>/
    manifest.json
    bin-aarch64-apple-darwin
    bin-x86_64-apple-darwin
```

This README is the bundle glob anchor (Tauri's `bundle.resources: ["plugins/**/*"]`
needs at least one file at build time). The runtime scanner only reads
`<subdir>/manifest.json`, so top-level files like this README are ignored.
