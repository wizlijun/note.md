//! Theme management: directory layout, Typora-CSS metadata parsing,
//! selector rewriting (`lightningcss`), zip import, and the `#[tauri::command]`
//! surface consumed by the frontend.
//!
//! Every `*.css` directly under `themes/` is one independent theme; compiled
//! CSS is written to `themes/.compiled/`. See
//! `docs/superpowers/specs/2026-05-11-typora-theme-import-design.md`.

pub mod appearance;
pub mod commands;
pub mod compiler;
pub mod header;
pub mod id;
pub mod import;
pub mod migration;
pub mod paths;
pub mod registry;
pub mod zip_safety;
