//! Scan the themes directory and produce ThemeMeta entries.

use crate::themes::appearance::{resolve_appearance, title_case_from_stem, Appearance};
use crate::themes::header::parse_header;
use crate::themes::id::is_valid_theme_id;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct ThemeMeta {
    pub id: String,
    pub name: String,
    pub appearance: Appearance,
    pub author: Option<String>,
    pub version: Option<String>,
    pub description: Option<String>,
    pub source: PathBuf,
    pub compiled: PathBuf,
    pub built_in: bool,
}

/// Scan `dir` for `*.css` files at the top level. Returns one `ThemeMeta` per
/// valid id, sorted by display name. Missing directory is treated as empty.
///
/// `built_in_ids` marks themes we shipped (used for the `built_in` flag and
/// the "Restore built-in themes" affordance).
pub fn scan_themes_dir(dir: &Path, built_in_ids: &[&str]) -> Result<Vec<ThemeMeta>, String> {
    let mut out: Vec<ThemeMeta> = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.to_string()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() { continue }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        let Some(ext) = path.extension().and_then(|s| s.to_str()) else { continue };
        if ext.to_ascii_lowercase() != "css" { continue }
        if is_valid_theme_id(stem).is_err() {
            eprintln!("[theme] skip invalid id: {:?}", path);
            continue
        }
        let css = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) => { eprintln!("[theme] read {:?}: {e}", path); continue }
        };
        let header = parse_header(&css);
        let stem_string = stem.to_string();
        let name = header.name.clone().unwrap_or_else(|| title_case_from_stem(stem));
        let appearance = resolve_appearance(header.appearance.as_deref(), stem);
        let compiled = dir.join(".compiled").join(format!("{stem}.css"));
        let is_built_in = built_in_ids.iter().any(|b| *b == stem);
        out.push(ThemeMeta {
            id: stem_string,
            name,
            appearance,
            author: header.author,
            version: header.version,
            description: header.description,
            source: path,
            compiled,
            built_in: is_built_in,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}
