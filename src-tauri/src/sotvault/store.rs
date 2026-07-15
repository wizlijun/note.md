use serde::{Deserialize, Serialize};
use std::path::Path;

/// Where a synced pair's companion `.note.md` lives.
/// `Sidecar` = next to BOTH source and vault (legacy bidirectional behaviour).
/// `Vault`   = ONLY next to the vault copy; the source dir is never written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum NoteHome {
    #[default]
    Sidecar,
    Vault,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Record {
    pub vault_path: String,
    pub source_path: String,
    pub synced_at: u64,
    pub source_hash: String,
    pub vault_hash: String,
    /// Last-converged companion-note content = the 3-way merge ancestor.
    /// `#[serde(default)]` keeps old `sotvault-sync.json` files loadable
    /// (missing key → `None`, which triggers the migration branch on next sync).
    #[serde(default)]
    pub note_merge_base: Option<String>,
    /// `#[serde(default)]` keeps pre-existing `sotvault-sync.json` loadable
    /// (missing key → `Sidecar`), preserving legacy bidirectional note sync.
    #[serde(default)]
    pub note_home: NoteHome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordStore {
    pub version: u32,
    pub records: Vec<Record>,
}

impl Default for RecordStore {
    fn default() -> Self {
        Self { version: 1, records: Vec::new() }
    }
}

impl RecordStore {
    pub fn find_by_vault(&self, vault_path: &str) -> Option<&Record> {
        self.records.iter().find(|r| r.vault_path == vault_path)
    }

    pub fn find_by_source(&self, source_path: &str) -> Option<&Record> {
        self.records.iter().find(|r| r.source_path == source_path)
    }

    pub fn upsert(&mut self, rec: Record) {
        if let Some(existing) = self.records.iter_mut().find(|r| r.vault_path == rec.vault_path) {
            *existing = rec;
        } else {
            self.records.push(rec);
        }
    }

    pub fn remove(&mut self, vault_path: &str) {
        self.records.retain(|r| r.vault_path != vault_path);
    }
}

/// Load records from `path`. A missing file yields an empty store. A corrupt
/// file is renamed to `<path>.corrupt` and an empty store is returned.
pub fn load_records(path: &Path) -> RecordStore {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return RecordStore::default(),
    };
    match serde_json::from_slice::<RecordStore>(&bytes) {
        Ok(s) => s,
        Err(_) => {
            let backup = path.with_extension("json.corrupt");
            let _ = std::fs::rename(path, &backup);
            RecordStore::default()
        }
    }
}

pub fn save_records(path: &Path, store: &RecordStore) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_vec_pretty(store)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    std::fs::write(path, json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn rec(vault: &str, source: &str) -> Record {
        Record {
            vault_path: vault.into(),
            source_path: source.into(),
            synced_at: 100,
            source_hash: "aaa".into(),
            vault_hash: "aaa".into(),
            note_merge_base: None,
            note_home: NoteHome::Sidecar,
        }
    }

    #[test]
    fn missing_file_is_empty_store() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("sotvault-sync.json");
        let store = load_records(&p);
        assert_eq!(store.records.len(), 0);
        assert_eq!(store.version, 1);
    }

    #[test]
    fn save_then_load_round_trips() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("nested").join("sotvault-sync.json");
        let mut store = RecordStore::default();
        store.upsert(rec("/vault/a.md", "/src/a.md"));
        save_records(&p, &store).unwrap();
        let loaded = load_records(&p);
        assert_eq!(loaded.records, store.records);
    }

    #[test]
    fn upsert_replaces_by_vault_path() {
        let mut store = RecordStore::default();
        store.upsert(rec("/vault/a.md", "/src/old.md"));
        store.upsert(rec("/vault/a.md", "/src/new.md"));
        assert_eq!(store.records.len(), 1);
        assert_eq!(store.find_by_vault("/vault/a.md").unwrap().source_path, "/src/new.md");
    }

    #[test]
    fn remove_drops_record() {
        let mut store = RecordStore::default();
        store.upsert(rec("/vault/a.md", "/src/a.md"));
        store.remove("/vault/a.md");
        assert!(store.find_by_vault("/vault/a.md").is_none());
    }

    #[test]
    fn find_by_source_matches_source_path() {
        let mut store = RecordStore::default();
        store.upsert(rec("/vault/a.md", "/src/a.md"));
        assert_eq!(store.find_by_source("/src/a.md").unwrap().vault_path, "/vault/a.md");
        assert!(store.find_by_source("/vault/a.md").is_none());
        assert!(store.find_by_source("/src/missing.md").is_none());
    }

    #[test]
    fn corrupt_file_backs_up_and_resets() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("sotvault-sync.json");
        std::fs::write(&p, b"{ this is not json").unwrap();
        let store = load_records(&p);
        assert_eq!(store.records.len(), 0);
        assert!(p.with_extension("json.corrupt").exists());
    }

    #[test]
    fn legacy_json_without_note_base_loads_as_none() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("sotvault-sync.json");
        // A store written before note_merge_base existed.
        let legacy = r#"{"version":1,"records":[
            {"vault_path":"/v/a.md","source_path":"/s/a.md",
             "synced_at":5,"source_hash":"h1","vault_hash":"h2"}]}"#;
        std::fs::write(&p, legacy).unwrap();
        let store = load_records(&p);
        assert_eq!(store.records.len(), 1);
        assert_eq!(store.records[0].note_merge_base, None);
    }

    #[test]
    fn note_base_round_trips() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("sotvault-sync.json");
        let mut store = RecordStore::default();
        let mut r = rec("/v/a.md", "/s/a.md");
        r.note_merge_base = Some("- base line".into());
        store.upsert(r);
        save_records(&p, &store).unwrap();
        let loaded = load_records(&p);
        assert_eq!(loaded.records[0].note_merge_base.as_deref(), Some("- base line"));
    }

    #[test]
    fn note_home_defaults_to_sidecar_for_legacy_json() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("sotvault-sync.json");
        let legacy = r#"{"version":1,"records":[
            {"vault_path":"/v/a.md","source_path":"/s/a.md",
             "synced_at":5,"source_hash":"h1","vault_hash":"h2"}]}"#;
        std::fs::write(&p, legacy).unwrap();
        let store = load_records(&p);
        assert_eq!(store.records[0].note_home, NoteHome::Sidecar);
    }

    #[test]
    fn note_home_vault_round_trips() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("sotvault-sync.json");
        let mut store = RecordStore::default();
        let mut r = rec("/v/a.md", "/s/a.md");
        r.note_home = NoteHome::Vault;
        store.upsert(r);
        save_records(&p, &store).unwrap();
        let loaded = load_records(&p);
        assert_eq!(loaded.records[0].note_home, NoteHome::Vault);
    }
}
