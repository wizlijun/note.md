//! Persist the last-synced hash pair to `agents_sync.json` in the app config
//! dir, so divergence that happened while the app was closed is still caught.

use super::logic::PairState;
use std::path::Path;

pub fn load(path: &Path) -> PairState {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, state: &PairState) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(state) {
        let _ = std::fs::write(path, json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_loads_default() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("agents_sync.json");
        assert_eq!(load(&p), PairState::default());
    }

    #[test]
    fn corrupt_file_loads_default() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("agents_sync.json");
        std::fs::write(&p, "not json").unwrap();
        assert_eq!(load(&p), PairState::default());
    }

    #[test]
    fn save_load_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("agents_sync.json");
        let s = PairState {
            agents_hash: Some("a1".into()),
            claude_hash: Some("c1".into()),
        };
        save(&p, &s);
        assert_eq!(load(&p), s);
    }

    #[test]
    fn save_creates_parent_dir() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("nested/agents_sync.json");
        save(&p, &PairState::default());
        assert_eq!(load(&p), PairState::default());
    }
}
