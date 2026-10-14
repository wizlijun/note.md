use super::{
    reader::{self, Snapshot},
    Result, MAX_SOURCE,
};
use crate::project_share::write_atomic;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuestInfo {
    pub schema_version: u32,
    pub root: String,
    pub entry: String,
    pub origin: String,
    pub slug: String,
    pub share_url: String,
    #[serde(rename = "project_id")]
    pub project_id: String,
    pub snapshot_id: String,
    pub files: Vec<GuestFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contributor_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_submission_id: Option<String>,
    pub submitted: Vec<String>,
    pub outbox: Vec<Outbox>,
    pub pending_update: Option<PendingUpdate>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GuestFile {
    pub path: String,
    pub hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Outbox {
    pub submission_id: String,
    pub body: String,
    pub queued_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingUpdate {
    pub snapshot_id: String,
    pub unresolved: Vec<String>,
}

pub struct GuestStore {
    vault: PathBuf,
}
impl GuestStore {
    pub fn new(vault: PathBuf) -> Result<Self> {
        let vault = vault.canonicalize().map_err(|_| "Vault unavailable")?;
        if !vault.is_dir() {
            return Err("Vault unavailable".into());
        }
        Ok(Self { vault })
    }
    /// Every component must be a real directory/file contained in the current Vault.
    fn checked(&self, path: &Path, missing: bool) -> Result<PathBuf> {
        let relative = path
            .strip_prefix(&self.vault)
            .map_err(|_| "outside received Vault")?;
        let mut at = self.vault.clone();
        for part in relative.components() {
            if !matches!(part, std::path::Component::Normal(_)) {
                return Err("unsafe received path".into());
            }
            at.push(part);
            match std::fs::symlink_metadata(&at) {
                Ok(m) => {
                    if m.file_type().is_symlink() || (!m.is_file() && !m.is_dir()) {
                        return Err("unsafe received file type".into());
                    }
                    if !at
                        .canonicalize()
                        .map_err(|_| "unreadable received path")?
                        .starts_with(&self.vault)
                    {
                        return Err("received path escapes Vault".into());
                    }
                }
                Err(e) if missing && e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("received path unavailable".into()),
            }
        }
        Ok(at)
    }
    fn directory(&self, path: &Path) -> Result<()> {
        self.checked(path, true)?;
        std::fs::create_dir_all(path).map_err(|_| "cannot create received directory")?;
        self.checked(path, false)?;
        if !path.is_dir() {
            return Err("received parent is not a directory".into());
        }
        Ok(())
    }
    fn root_for(&self, origin: &str, pid: &str) -> Result<PathBuf> {
        if !reader::valid_id(pid) {
            return Err("invalid guest project identity".into());
        }
        let received = self.vault.join("received");
        let sync = self
            .vault
            .join(crate::sotvault::vault_settings::resolve_sync_dir(
                &self.vault,
            ));
        // Resolve the existing prefix even when the configured Sync child does not yet exist.
        let sync_actual = sync
            .ancestors()
            .find_map(|p| {
                p.canonicalize()
                    .ok()
                    .map(|base| base.join(sync.strip_prefix(p).unwrap()))
            })
            .ok_or("Sync location unavailable")?;
        if [&sync, &sync_actual]
            .iter()
            .any(|p| p.starts_with(&received) || received.starts_with(p))
        {
            return Err("received and Sync directories cannot overlap".into());
        }
        let url = url::Url::parse(origin).map_err(|_| "invalid origin")?;
        // IPv6 folder retains a deterministic hostname representation without ':' path separators.
        let host = url
            .host_str()
            .ok_or("missing hostname")?
            .to_lowercase()
            .replace(':', "_");
        let host = match url.port() {
            Some(port) => format!("{host}_{port}"),
            None => host,
        };
        Ok(self.vault.join("received").join(host).join(pid))
    }
    pub fn inspect(&self, root: &Path) -> Result<GuestInfo> {
        self.checked(root, false)?;
        if !root.is_dir() {
            return Err("invalid guest root".into());
        }
        let path = self.checked(&root.join(".notemd/guest.json"), false)?;
        let bytes = read_limited(&path, 1024 * 1024)?;
        let info: GuestInfo = serde_json::from_value(reader::unique_json(&bytes)?)
            .map_err(|_| "invalid guest metadata")?;
        super::checked_link(
            &info.origin,
            &info.slug,
            &info.share_url,
            cfg!(debug_assertions),
        )?;
        if info.schema_version != 1
            || !reader::valid_id(&info.snapshot_id)
            || self.root_for(&info.origin, &info.project_id)? != root
            || Path::new(&info.root) != root
            || info.files.is_empty()
            || info.files.len() > 512
        {
            return Err("guest identity conflict".into());
        }
        let mut seen = std::collections::HashSet::new();
        for file in &info.files {
            reader::valid_path(&file.path)?;
            if file.hash.len() != 64
                || !file
                    .hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || !seen.insert(file.path.to_lowercase())
            {
                return Err("invalid guest file metadata".into());
            }
        }
        if !info.files.iter().any(|f| f.path == info.entry) {
            return Err("missing guest entry".into());
        }
        Ok(info)
    }
    pub fn read_base(&self, root: &Path, path: &str, sid: &str) -> Result<serde_json::Value> {
        let info = self.inspect(root)?;
        reader::valid_path(path)?;
        if sid != info.snapshot_id {
            return Err("guest base identity mismatch".into());
        }
        let file = info
            .files
            .iter()
            .find(|f| f.path == path)
            .ok_or("unlisted base path")?;
        let target = self.checked(&root.join(".notemd/base").join(sid).join(path), false)?;
        let bytes = read_limited(&target, MAX_SOURCE)?;
        let hash = crate::sotvault::logic::sha256_hex(&bytes);
        if hash != file.hash {
            return Err("guest base hash mismatch".into());
        }
        let markdown = String::from_utf8(bytes).map_err(|_| "base is not UTF-8")?;
        Ok(serde_json::json!({"markdown":markdown,"hash":hash}))
    }
    pub fn install(
        &self,
        origin: &str,
        slug: &str,
        share_url: &str,
        snapshot: &Snapshot,
    ) -> Result<GuestInfo> {
        super::checked_link(origin, slug, share_url, cfg!(debug_assertions))?;
        let root = self.root_for(origin, &snapshot.manifest.project_id)?;
        self.checked(&root, true)?;
        if root.exists() {
            let info = self.inspect(&root)?;
            if info.origin != origin || info.project_id != snapshot.manifest.project_id {
                return Err("guest identity conflict".into());
            }
            if info.snapshot_id == snapshot.manifest.snapshot_id {
                return Ok(info);
            }
            return Err("GUEST_UPDATE_REQUIRED".into());
        }
        let parent = root.parent().ok_or("invalid received root")?;
        self.directory(parent)?;
        let staging = tempfile::Builder::new()
            .prefix(".guest-")
            .tempdir_in(parent)
            .map_err(|_| "cannot stage received project")?;
        let info = GuestInfo {
            schema_version: 1,
            root: root.to_string_lossy().into(),
            entry: snapshot.manifest.entry.clone(),
            origin: origin.into(),
            slug: slug.into(),
            share_url: share_url.into(),
            project_id: snapshot.manifest.project_id.clone(),
            snapshot_id: snapshot.manifest.snapshot_id.clone(),
            files: snapshot
                .manifest
                .files
                .iter()
                .map(|f| GuestFile {
                    path: f.path.clone(),
                    hash: f.hash.clone(),
                })
                .collect(),
            contributor_name: None,
            last_submission_id: None,
            submitted: vec![],
            outbox: vec![],
            pending_update: None,
        };
        for (file, bytes) in snapshot.manifest.files.iter().zip(&snapshot.source) {
            for relative in [
                PathBuf::from(&file.path),
                PathBuf::from(".notemd/base")
                    .join(&info.snapshot_id)
                    .join(&file.path),
            ] {
                let path = staging.path().join(relative);
                self.directory(path.parent().ok_or("missing source parent")?)?;
                self.checked(&path, true)?;
                // Catch filesystem aliases (including Unicode normalization/case folding)
                // before an atomic writer could replace an earlier staged source.
                if std::fs::symlink_metadata(&path).is_ok() {
                    return Err("received source paths collide on this filesystem".into());
                }
                write_atomic(&path, bytes).map_err(|_| "cannot write received source")?;
            }
        }
        let metadata = staging.path().join(".notemd/guest.json");
        write_atomic(
            &metadata,
            &serde_json::to_vec_pretty(&info).map_err(|_| "invalid guest metadata")?,
        )
        .map_err(|_| "cannot write guest metadata")?;
        self.checked(parent, false)?;
        self.checked(&root, true)?;
        rename_new(staging.path(), &root)?;
        std::fs::File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(|_| "cannot sync received directory")?;
        Ok(info)
    }
}
fn read_limited(path: &Path, limit: usize) -> Result<Vec<u8>> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|_| "unreadable guest file")?;
    let mut bytes = vec![];
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "unreadable guest file")?;
    if bytes.len() > limit {
        return Err("guest file exceeds limit".into());
    }
    Ok(bytes)
}
// Atomic no-replace directory publication: even an empty user directory must survive.
#[cfg(target_os = "macos")]
fn rename_new(from: &Path, to: &Path) -> Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let a =
        std::ffi::CString::new(from.as_os_str().as_bytes()).map_err(|_| "invalid staging path")?;
    let b = std::ffi::CString::new(to.as_os_str().as_bytes()).map_err(|_| "invalid target path")?;
    if unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_EXCL) } != 0 {
        return Err("received target exists or cannot be published".into());
    }
    Ok(())
}
#[cfg(target_os = "linux")]
fn rename_new(from: &Path, to: &Path) -> Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let a =
        std::ffi::CString::new(from.as_os_str().as_bytes()).map_err(|_| "invalid staging path")?;
    let b = std::ffi::CString::new(to.as_os_str().as_bytes()).map_err(|_| "invalid target path")?;
    if unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            a.as_ptr(),
            libc::AT_FDCWD,
            b.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    } != 0
    {
        return Err("received target exists or cannot be published".into());
    }
    Ok(())
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn rename_new(from: &Path, to: &Path) -> Result<()> {
    if to.exists() {
        return Err("received target exists".into());
    }
    std::fs::rename(from, to).map_err(|_| "cannot publish received project".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn install(s: &GuestStore) -> Result<GuestInfo> {
        let snap = reader::extract_public_snapshot(&reader::tests::html(1)).unwrap();
        s.install(
            "https://share.example",
            "2026-10-14-test",
            "https://share.example/2026-10-14-test",
            &snap,
        )
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn store_filesystem_unicode_alias_never_overwrites_staged_source() {
        let t = tempfile::tempdir().unwrap();
        let store = GuestStore::new(t.path().into()).unwrap();
        let mut snapshot = reader::extract_public_snapshot(&reader::tests::html(1)).unwrap();
        snapshot.manifest.files[0].path = "é.md".into();
        snapshot.manifest.entry = "é.md".into();
        let mut second = snapshot.manifest.files[0].clone();
        second.path = "e\u{301}.md".into();
        snapshot.manifest.files.push(second);
        snapshot.source.push(snapshot.source[0].clone());
        assert!(store
            .install(
                "https://share.example",
                "2026-10-14-test",
                "https://share.example/2026-10-14-test",
                &snapshot
            )
            .is_err());
        assert!(!t.path().join("received/share.example/pid").exists());
    }
    #[test]
    fn store_production_package_source_and_base_shas_match_each_path() {
        let t = tempfile::tempdir().unwrap();
        let store = GuestStore::new(t.path().into()).unwrap();
        let snapshot =
            reader::extract_public_snapshot(include_bytes!("fixtures/reader.html")).unwrap();
        crate::share_guest::archive::validate(include_bytes!("fixtures/source.zip"), &snapshot)
            .unwrap();
        let info = store
            .install(
                "https://share.example",
                "2026-10-14-test",
                "https://share.example/2026-10-14-test",
                &snapshot,
            )
            .unwrap();
        for (file, original) in snapshot.manifest.files.iter().zip(&snapshot.source) {
            let source = std::fs::read(Path::new(&info.root).join(&file.path)).unwrap();
            let base = std::fs::read(
                Path::new(&info.root)
                    .join(".notemd/base/sid")
                    .join(&file.path),
            )
            .unwrap();
            assert_eq!(&source, original);
            assert_eq!(source, base);
            assert_eq!(crate::sotvault::logic::sha256_hex(&source), file.hash);
            println!(
                "verified source/base path={} bytes={} sha256={}",
                file.path,
                source.len(),
                file.hash
            );
        }
        std::fs::write(Path::new(&info.root).join("0.md"), b"user edited").unwrap();
        let mut next = snapshot;
        next.manifest.snapshot_id = "next".into();
        assert_eq!(
            store
                .install(
                    "https://share.example",
                    "2026-10-14-test",
                    "https://share.example/2026-10-14-test",
                    &next
                )
                .unwrap_err(),
            "GUEST_UPDATE_REQUIRED"
        );
        assert_eq!(
            std::fs::read(Path::new(&info.root).join("0.md")).unwrap(),
            b"user edited"
        );
        assert!(!Path::new(&info.root).join(".notemd/base/next").exists());
        assert!(store.inspect(t.path()).is_err());
    }
    #[test]
    fn store_refuses_configured_sync_overlap_before_writing() {
        for sync in [
            "received",
            "received/share.example",
            "received/share.example/pid/nested",
        ] {
            let t = tempfile::tempdir().unwrap();
            crate::sotvault::vault_settings::write(
                t.path(),
                &crate::sotvault::vault_settings::VaultSettings {
                    sync_dir: Some(sync.into()),
                    ..Default::default()
                },
            )
            .unwrap();
            let s = GuestStore::new(t.path().into()).unwrap();
            assert!(install(&s).is_err(), "{sync}");
            assert!(!t.path().join("received").exists());
        }
    }
    #[test]
    fn store_atomic_base_source_identity_and_token_absence() {
        let t = tempfile::tempdir().unwrap();
        let s = GuestStore::new(t.path().into()).unwrap();
        let info = install(&s).unwrap();
        let root = Path::new(&info.root);
        let body = std::fs::read(root.join("0.md")).unwrap();
        assert_eq!(body, "\u{feff}<正文\r\n".as_bytes());
        assert_eq!(
            body,
            std::fs::read(root.join(".notemd/base/sid/0.md")).unwrap()
        );
        assert_eq!(
            s.read_base(root, "0.md", "sid").unwrap()["hash"],
            info.files[0].hash
        );
        assert!(s.read_base(root, "0.md", "wrong").is_err());
        std::fs::write(root.join("0.md"), "local edit").unwrap();
        install(&s).unwrap();
        assert_eq!(std::fs::read(root.join("0.md")).unwrap(), b"local edit");
        fn scan(path: &Path) {
            for entry in std::fs::read_dir(path).unwrap() {
                let entry = entry.unwrap();
                if entry.file_type().unwrap().is_dir() {
                    scan(&entry.path())
                } else {
                    assert!(!std::fs::read(entry.path())
                        .unwrap()
                        .windows(13)
                        .any(|b| b == b"FIXTURE_TOKEN"));
                }
            }
        }
        scan(t.path());
        assert!(!t.path().join("Sync").exists());
    }
    #[test]
    fn store_existing_empty_user_files_identity_conflict_zero_overwrite() {
        for kind in ["empty", "file", "identity"] {
            let t = tempfile::tempdir().unwrap();
            let s = GuestStore::new(t.path().into()).unwrap();
            let root = t.path().join("received/share.example/pid");
            std::fs::create_dir_all(&root).unwrap();
            if kind != "empty" {
                std::fs::write(root.join("0.md"), "user").unwrap();
            }
            if kind == "identity" {
                std::fs::create_dir(root.join(".notemd")).unwrap();
                std::fs::write(
                    root.join(".notemd/guest.json"),
                    "{\"project_id\":\"other\"}",
                )
                .unwrap();
            }
            assert!(install(&s).is_err());
            if kind != "empty" {
                assert_eq!(std::fs::read(root.join("0.md")).unwrap(), b"user")
            }
            assert_eq!(
                std::fs::read_dir(root.parent().unwrap()).unwrap().count(),
                1
            );
        }
    }
    #[cfg(unix)]
    #[test]
    fn store_symlink_parent_and_metadata_are_rejected() {
        use std::os::unix::fs::symlink;
        for level in [
            "received",
            "received/share.example",
            "received/share.example/pid",
        ] {
            let t = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            let s = GuestStore::new(t.path().into()).unwrap();
            let p = t.path().join(level);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            symlink(outside.path(), p).unwrap();
            assert!(install(&s).is_err());
            assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
        }
        let t = tempfile::tempdir().unwrap();
        let s = GuestStore::new(t.path().into()).unwrap();
        let info = install(&s).unwrap();
        let base = Path::new(&info.root).join(".notemd/base/sid/0.md");
        std::fs::remove_file(&base).unwrap();
        symlink(Path::new(&info.root).join("0.md"), &base).unwrap();
        assert!(s.read_base(Path::new(&info.root), "0.md", "sid").is_err());
    }
}
