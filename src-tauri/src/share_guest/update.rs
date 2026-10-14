//! Received update journal: immutable results precede intent; disk hashes decide replay.
use super::*;
use crate::share_guest::reader::Manifest;
use crate::sotvault::logic::sha256_hex;
use std::collections::{BTreeMap, HashSet};
#[cfg(test)]
thread_local! { static UPDATE_FAILURE: std::cell::Cell<u8> = const { std::cell::Cell::new(0) }; }
fn fault(point: u8) -> Result<()> {
    #[cfg(test)]
    if UPDATE_FAILURE.with(|f| {
        if f.get() == point {
            f.set(0);
            true
        } else {
            false
        }
    }) {
        return Err(format!("update fault {point}"));
    }
    let _ = point;
    Ok(())
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    from_snapshot_id: String,
    to_snapshot_id: String,
    rows: Vec<Row>,
    work_paths: BTreeMap<String, String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Row {
    source_path: String,
    path: String,
    expected_hash: Option<String>,
    result_hash: Option<String>,
    action: String,
    state: String,
    result_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    from_snapshot_id: String,
    to_snapshot_id: String,
    actions: Vec<Action>,
    conflicts: Vec<Conflict>,
    choices: Vec<Choice>,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum Action {
    Write {
        path: String,
        #[serde(rename = "expectedHash")]
        expected_hash: Option<String>,
        content: String,
    },
    CopyBase {
        path: String,
        #[serde(rename = "sourcePath")]
        source_path: String,
        #[serde(rename = "expectedHash")]
        expected_hash: Option<String>,
    },
    Delete {
        path: String,
        #[serde(rename = "expectedHash")]
        expected_hash: String,
    },
    RetainRemoved {
        path: String,
        #[serde(rename = "expectedHash")]
        expected_hash: String,
    },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Conflict {
    path: String,
    expected_hash: String,
    proposal: serde_json::Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Choice {
    path: String,
    expected_hash: Option<String>,
}
fn shared_target_name(source: &str, target: &str) -> bool {
    let p = Path::new(source);
    let Some(stem) = p.file_stem() else {
        return false;
    };
    let stem = stem.to_string_lossy();
    let ext = p
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let dir = p.parent().unwrap_or(Path::new(""));
    (1..=10001).any(|i| {
        dir.join(format!(
            "{stem}.shared{}{ext}",
            if i == 1 {
                String::new()
            } else {
                format!("-{i}")
            }
        )) == Path::new(target)
    })
}
impl GuestStore {
    pub(super) fn validate_work_paths(
        &self,
        root: &Path,
        files: &[GuestFile],
        paths: &BTreeMap<String, String>,
    ) -> Result<()> {
        for (source, target) in paths {
            reader::valid_path(source)?;
            reader::valid_path(target)?;
            if !shared_target_name(source, target) || !files.iter().any(|f| &f.path == source) {
                return Err("invalid guest work mapping".into());
            }
        }
        let mut names = HashSet::new();
        let mut actual = HashSet::new();
        for f in files {
            let p = paths.get(&f.path).unwrap_or(&f.path);
            reader::valid_path(p)?;
            if !names.insert(p.to_lowercase()) {
                return Err("guest work paths collide".into());
            }
            let path = self.checked(&root.join(p), true)?;
            if path.exists()
                && !actual.insert(path.canonicalize().map_err(|_| "invalid guest work path")?)
            {
                return Err("guest work paths alias".into());
            }
        }
        Ok(())
    }
    fn update_info(&self, root: &Path) -> Result<GuestInfo> {
        let info = self.inspect(root)?;
        if !info.outbox.is_empty() {
            return Err("GUEST_PENDING_CONFLICT".into());
        }
        Ok(info)
    }
    fn metadata<T: serde::de::DeserializeOwned>(&self, path: &Path) -> Result<T> {
        serde_json::from_value(reader::unique_json(&read_limited(
            &self.checked(path, false)?,
            MAX_METADATA,
        )?)?)
        .map_err(|_| "invalid update metadata".into())
    }
    fn save_metadata<T: Serialize>(&self, path: &Path, value: &T) -> Result<()> {
        let bytes = serde_json::to_vec(value).map_err(|_| "invalid update metadata")?;
        if bytes.len() > MAX_METADATA {
            return Err("update metadata exceeds limit".into());
        }
        write_atomic(&self.checked(path, true)?, &bytes)
    }
    fn manifest(&self, root: &Path, info: &GuestInfo) -> Result<Manifest> {
        let pending = info.pending_update.as_ref().ok_or("no pending update")?;
        let m: Manifest = self.metadata(&root.join(".notemd/update-manifest.json"))?;
        if m.snapshot_id != pending.snapshot_id
            || m.project_id != info.project_id
            || !reader::valid_id(&m.snapshot_id)
            || m.files.is_empty()
            || m.files.len() > 512
        {
            return Err("update identity mismatch".into());
        }
        let mut names = HashSet::new();
        let mut size = 0usize;
        for f in &m.files {
            reader::valid_path(&f.path)?;
            size = size.checked_add(f.bytes).ok_or("update size overflow")?;
            if !names.insert(f.path.to_lowercase()) || f.hash.len() != 64 || size > MAX_SOURCE {
                return Err("invalid update manifest".into());
            }
        }
        if !m.files.iter().any(|f| f.path == m.entry) {
            return Err("missing update entry".into());
        }
        Ok(m)
    }
    fn base_bytes(&self, root: &Path, sid: &str, path: &str, hash: &str) -> Result<Vec<u8>> {
        if !reader::valid_id(sid) {
            return Err("invalid base identity".into());
        }
        reader::valid_path(path)?;
        let bytes = read_limited(
            &self.checked(&root.join(".notemd/base").join(sid).join(path), false)?,
            MAX_SOURCE,
        )?;
        if sha256_hex(&bytes) != hash {
            return Err("guest base hash mismatch".into());
        }
        Ok(bytes)
    }
    fn work_bytes(&self, root: &Path, path: &str) -> Result<Option<Vec<u8>>> {
        reader::valid_path(path)?;
        let p = self.checked(&root.join(path), true)?;
        if !p.exists() {
            return Ok(None);
        }
        Ok(Some(read_limited(&p, MAX_SOURCE)?))
    }
    fn work_hash(&self, root: &Path, path: &str) -> Result<Option<String>> {
        Ok(self.work_bytes(root, path)?.as_deref().map(sha256_hex))
    }
    pub fn prepare_update(&self, root: &Path, snapshot: &Snapshot) -> Result<GuestInfo> {
        let mut info = self.update_info(root)?;
        if info.pending_update.is_some() {
            self.manifest(root, &info)?;
            return Ok(info);
        }
        if snapshot.manifest.project_id != info.project_id {
            return Err("update project mismatch".into());
        }
        // A completed journal must be cleaned before publishing another generation.
        if root.join(".notemd/update-plan.json").exists() {
            self.finish_update(root)?;
        }
        if snapshot.manifest.snapshot_id == info.snapshot_id {
            return Ok(info);
        }
        let parent = root.join(".notemd/base");
        self.directory(&parent)?;
        let staging = tempfile::Builder::new()
            .prefix(".update-")
            .tempdir_in(&parent)
            .map_err(|_| "cannot stage update")?;
        for (f, bytes) in snapshot.manifest.files.iter().zip(&snapshot.source) {
            reader::valid_path(&f.path)?;
            if sha256_hex(bytes) != f.hash || bytes.len() != f.bytes {
                return Err("invalid update source".into());
            }
            let p = staging.path().join(&f.path);
            self.directory(p.parent().ok_or("missing parent")?)?;
            if p.exists() {
                return Err("update paths alias".into());
            }
            write_atomic(&p, bytes)?;
        }
        let dest = parent.join(&snapshot.manifest.snapshot_id);
        self.checked(&dest, true)?;
        if dest.exists() {
            for f in &snapshot.manifest.files {
                self.base_bytes(root, &snapshot.manifest.snapshot_id, &f.path, &f.hash)?;
            }
        } else {
            rename_new(staging.path(), &dest)?;
            sync_directory(&parent)?;
        }
        self.save_metadata(
            &root.join(".notemd/update-manifest.json"),
            &snapshot.manifest,
        )?;
        info.pending_update = Some(PendingUpdate {
            snapshot_id: snapshot.manifest.snapshot_id.clone(),
            unresolved: vec![],
            paths: snapshot
                .manifest
                .files
                .iter()
                .map(|f| f.path.clone())
                .collect(),
        });
        self.write_info(&info)?;
        Ok(info)
    }
    pub fn read_update(&self, root: &Path) -> Result<serde_json::Value> {
        let info = self.update_info(root)?;
        let m = self.manifest(root, &info)?;
        let mut old = BTreeMap::new();
        let mut new = BTreeMap::new();
        let mut work = BTreeMap::new();
        let mut hashes = BTreeMap::new();
        let mut occupied = vec![];
        for f in &info.files {
            let bytes = self.base_bytes(root, &info.snapshot_id, &f.path, &f.hash)?;
            if crate::project_share::is_md(&f.path) {
                old.insert(
                    f.path.clone(),
                    String::from_utf8(bytes).map_err(|_| "base is not UTF-8")?,
                );
            }
        }
        for f in &m.files {
            let bytes = self.base_bytes(root, &m.snapshot_id, &f.path, &f.hash)?;
            if crate::project_share::is_md(&f.path) {
                new.insert(
                    f.path.clone(),
                    String::from_utf8(bytes).map_err(|_| "base is not UTF-8")?,
                );
            }
        }
        let mut dirs = vec![root.to_path_buf()];
        while let Some(dir) = dirs.pop() {
            for e in std::fs::read_dir(dir).map_err(|_| "cannot list work")? {
                let e = e.map_err(|_| "cannot list work")?;
                if e.file_name() == ".notemd" {
                    continue;
                }
                let p = self.checked(&e.path(), false)?;
                let rel = p
                    .strip_prefix(root)
                    .map_err(|_| "invalid work path")?
                    .to_string_lossy()
                    .replace('\\', "/");
                occupied.push(rel.clone());
                if occupied.len() > 10000 {
                    return Err("too many working paths".into());
                }
                if p.is_dir() {
                    dirs.push(p);
                    continue;
                }
            }
        }
        // Unknown files contribute only occupied names; never decode or package their content.
        let mut total = 0usize;
        for file in &info.files {
            let path = info.work_paths.get(&file.path).unwrap_or(&file.path);
            let target = self.checked(&root.join(path), true)?;
            if !target.exists() {
                continue;
            }
            let bytes = read_limited(&target, MAX_SOURCE - total)?;
            total += bytes.len();
            hashes.insert(path.clone(), sha256_hex(&bytes));
            if crate::project_share::is_md(&file.path) {
                work.insert(
                    path.clone(),
                    String::from_utf8(bytes).map_err(|_| "work is not UTF-8")?,
                );
            }
        }
        Ok(
            serde_json::json!({"fromSnapshotId":info.snapshot_id,"toSnapshotId":m.snapshot_id,"oldBase":old,"newBase":new,"work":work,"oldFiles":info.files.iter().map(|f|(f.path.clone(),f.hash.clone())).collect::<BTreeMap<_,_>>(),"newFiles":m.files.iter().map(|f|(f.path.clone(),f.hash.clone())).collect::<BTreeMap<_,_>>(),"workHashes":hashes,"occupied":occupied,"workPaths":info.work_paths,"journal":root.join(".notemd/update-plan.json").exists()}),
        )
    }
    fn result_bytes(&self, root: &Path, j: &Journal, row: &Row) -> Result<Vec<u8>> {
        let id = row.result_id.as_ref().ok_or("missing update result")?;
        if !reader::valid_id(id) {
            return Err("invalid update result identity".into());
        }
        let p = root
            .join(".notemd/update-results")
            .join(&j.to_snapshot_id)
            .join(id);
        let bytes = read_limited(&self.checked(&p, false)?, MAX_SOURCE)?;
        if Some(sha256_hex(&bytes)) != row.result_hash {
            return Err("update result hash mismatch".into());
        }
        Ok(bytes)
    }
    fn stage_result(&self, root: &Path, sid: &str, bytes: &[u8]) -> Result<(String, String)> {
        let hash = sha256_hex(bytes);
        let id = hash.clone();
        let dir = root.join(".notemd/update-results").join(sid);
        self.directory(&dir)?;
        let path = self.checked(&dir.join(&id), true)?;
        let mut size = 0usize;
        for entry in std::fs::read_dir(&dir).map_err(|_| "cannot inspect update results")? {
            let entry = entry.map_err(|_| "cannot inspect update results")?;
            let p = self.checked(&entry.path(), false)?;
            size = size
                .checked_add(
                    std::fs::metadata(p)
                        .map_err(|_| "cannot inspect result")?
                        .len() as usize,
                )
                .ok_or("result size overflow")?;
        }
        if size + if path.exists() { 0 } else { bytes.len() } > MAX_SOURCE {
            return Err("update results exceed limit".into());
        }
        if path.exists() {
            if read_limited(&path, MAX_SOURCE)? != bytes {
                return Err("update result collision".into());
            }
        } else {
            write_atomic(&path, bytes)?;
        }
        Ok((id, hash))
    }
    fn journal(&self, root: &Path, info: &GuestInfo) -> Result<Journal> {
        let j: Journal = self.metadata(&root.join(".notemd/update-plan.json"))?;
        if !reader::valid_id(&j.from_snapshot_id)
            || !reader::valid_id(&j.to_snapshot_id)
            || j.rows.len() > 1024
            || !(info.snapshot_id == j.from_snapshot_id
                && info
                    .pending_update
                    .as_ref()
                    .is_some_and(|p| p.snapshot_id == j.to_snapshot_id)
                || info.snapshot_id == j.to_snapshot_id && info.pending_update.is_none())
        {
            return Err("update journal identity mismatch".into());
        }
        let mut paths = HashSet::new();
        if info.pending_update.is_some() {
            let m = self.manifest(root, info)?;
            self.validate_work_paths(
                root,
                &m.files
                    .iter()
                    .map(|f| GuestFile {
                        path: f.path.clone(),
                        hash: f.hash.clone(),
                    })
                    .collect::<Vec<_>>(),
                &j.work_paths,
            )?;
            for r in &j.rows {
                let listed = m.files.iter().any(|f| f.path == r.source_path);
                if !listed && !info.files.iter().any(|f| f.path == r.source_path) {
                    return Err("unlisted journal source".into());
                }
                let expected = if listed {
                    j.work_paths.get(&r.source_path)
                } else {
                    info.work_paths.get(&r.source_path)
                }
                .unwrap_or(&r.source_path);
                if expected != &r.path {
                    return Err("journal target identity mismatch".into());
                }
            }
        }
        for r in &j.rows {
            reader::valid_path(&r.path)?;
            reader::valid_path(&r.source_path)?;
            if r.expected_hash
                .iter()
                .chain(r.result_hash.iter())
                .any(|hash| {
                    hash.len() != 64
                        || !hash
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
                || r.result_id.is_some() && r.result_id != r.result_hash
            {
                return Err("invalid journal hashes".into());
            }
            if !paths.insert(r.path.to_lowercase())
                || !["waiting", "intent", "done", "failed"].contains(&r.state.as_str())
                || ![
                    "write",
                    "copy-base",
                    "delete",
                    "retain-removed",
                    "conflict",
                    "choice",
                    "keep-local",
                ]
                .contains(&r.action.as_str())
            {
                return Err("invalid update row".into());
            }
        }
        Ok(j)
    }
    fn save_journal(&self, root: &Path, j: &Journal) -> Result<()> {
        self.save_metadata(&root.join(".notemd/update-plan.json"), j)
    }
    fn sync_pending(&self, root: &Path, j: &Journal) -> Result<GuestInfo> {
        let mut info = self.update_info(root)?;
        info.pending_update = Some(PendingUpdate {
            snapshot_id: j.to_snapshot_id.clone(),
            unresolved: j
                .rows
                .iter()
                .filter(|r| r.state != "done")
                .map(|r| r.source_path.clone())
                .collect(),
            paths: self
                .manifest(root, &info)?
                .files
                .iter()
                .map(|f| f.path.clone())
                .collect(),
        });
        self.write_info(&info)?;
        Ok(info)
    }
    fn replay(&self, root: &Path, j: &mut Journal) -> Result<GuestInfo> {
        for i in 0..j.rows.len() {
            if j.rows[i].state == "done" || j.rows[i].state == "waiting" {
                continue;
            }
            let row = j.rows[i].clone();
            fault(1)?;
            let attempt = (|| -> Result<()> {
                let current = self.work_hash(root, &row.path)?;
                if current == row.result_hash
                    && ["write", "copy-base", "delete"].contains(&row.action.as_str())
                {
                    return Ok(());
                }
                if current != row.expected_hash {
                    return Err("GUEST_WORK_CHANGED".into());
                }
                match row.action.as_str() {
                    "write" | "copy-base" => {
                        let bytes = self.result_bytes(root, j, &row)?;
                        let p = self.checked(&root.join(&row.path), true)?;
                        self.directory(p.parent().ok_or("missing work parent")?)?;
                        // Hash again after all preparation, immediately before the atomic replacement.
                        if self.work_hash(root, &row.path)? != row.expected_hash {
                            return Err("GUEST_WORK_CHANGED".into());
                        }
                        write_atomic(&p, &bytes)?;
                    }
                    "delete" => {
                        let p = self.checked(&root.join(&row.path), false)?;
                        std::fs::remove_file(&p).map_err(|_| "cannot remove unchanged source")?;
                        sync_directory(p.parent().ok_or("missing work parent")?)?;
                    }
                    "retain-removed" | "keep-local" => {}
                    _ => return Err("invalid replay action".into()),
                }
                Ok(())
            })();
            if attempt.is_ok() {
                fault(2)?;
            }
            j.rows[i].state = if attempt.is_ok() { "done" } else { "failed" }.into();
            self.save_journal(root, j)?;
        }
        self.sync_pending(root, j)
    }
    pub fn apply_update(&self, root: &Path, plan: Plan) -> Result<GuestInfo> {
        let info = self.update_info(root)?;
        let m = self.manifest(root, &info)?;
        if plan.from_snapshot_id != info.snapshot_id || plan.to_snapshot_id != m.snapshot_id {
            return Err("GUEST_BASE_CHANGED".into());
        }
        if root.join(".notemd/update-plan.json").exists() {
            return Err("update already planned; resume journal".into());
        }
        let mut j = Journal {
            from_snapshot_id: info.snapshot_id.clone(),
            to_snapshot_id: m.snapshot_id.clone(),
            rows: vec![],
            work_paths: info.work_paths.clone(),
        };
        j.work_paths
            .retain(|p, _| m.files.iter().any(|f| &f.path == p));
        let old_path = |p: &str| {
            info.files
                .iter()
                .find(|f| info.work_paths.get(&f.path).unwrap_or(&f.path) == p)
                .map(|f| f.path.clone())
        };
        let mut covered = HashSet::new();
        let mut total = 0usize;
        for a in plan.actions {
            let (source, path, expected, action, bytes) = match a {
                Action::Write {
                    path,
                    expected_hash,
                    content,
                } => {
                    let source = old_path(&path).ok_or("unmanaged write path")?;
                    if !crate::project_share::is_md(&source)
                        || !m.files.iter().any(|f| f.path == source)
                    {
                        return Err("invalid text update".into());
                    }
                    (
                        source,
                        path,
                        expected_hash,
                        "write",
                        Some(content.into_bytes()),
                    )
                }
                Action::CopyBase {
                    path,
                    source_path,
                    expected_hash,
                } => {
                    let f = m
                        .files
                        .iter()
                        .find(|f| f.path == source_path)
                        .ok_or("unlisted update source")?;
                    if let Some(old) = info.files.iter().find(|f| f.path == source_path) {
                        if info.work_paths.get(&old.path).unwrap_or(&old.path) != &path
                            || expected_hash.as_ref() != Some(&old.hash)
                        {
                            return Err("invalid managed copy".into());
                        }
                    } else {
                        if expected_hash.is_some() {
                            return Err("new copy cannot overwrite".into());
                        }
                        self.validate_shared_target(root, &source_path, &path)?;
                        if source_path != path {
                            j.work_paths.insert(source_path.clone(), path.clone());
                        }
                    }
                    let bytes = self.base_bytes(root, &m.snapshot_id, &source_path, &f.hash)?;
                    (source_path, path, expected_hash, "copy-base", Some(bytes))
                }
                Action::Delete {
                    path,
                    expected_hash,
                }
                | Action::RetainRemoved {
                    path,
                    expected_hash,
                } => {
                    let source = old_path(&path).ok_or("unmanaged removal")?;
                    let old = info.files.iter().find(|f| f.path == source).unwrap();
                    if m.files.iter().any(|f| f.path == source) {
                        return Err("cannot remove shared source".into());
                    }
                    let action = if old.hash == expected_hash {
                        "delete"
                    } else {
                        "retain-removed"
                    };
                    (source, path, Some(expected_hash), action, None)
                }
            };
            if !covered.insert(source.clone()) {
                return Err("duplicate update source".into());
            }
            reader::valid_path(&path)?;
            let (result_id, result_hash) = if let Some(bytes) = bytes {
                total += bytes.len();
                if total > MAX_SOURCE {
                    return Err("update results exceed limit".into());
                }
                let (id, hash) = self.stage_result(root, &m.snapshot_id, &bytes)?;
                (Some(id), Some(hash))
            } else {
                (
                    None,
                    if action == "delete" {
                        None
                    } else {
                        expected.clone()
                    },
                )
            };
            j.rows.push(Row {
                source_path: source,
                path,
                expected_hash: expected,
                result_hash,
                action: action.into(),
                state: "intent".into(),
                result_id,
            });
        }
        for (path, hash, action) in plan
            .conflicts
            .into_iter()
            .map(|c| {
                let _ = c.proposal;
                (c.path, Some(c.expected_hash), "conflict")
            })
            .chain(
                plan.choices
                    .into_iter()
                    .map(|c| (c.path, c.expected_hash, "choice")),
            )
        {
            if !info.files.iter().any(|f| f.path == path)
                || !m.files.iter().any(|f| f.path == path)
                || !covered.insert(path.clone())
            {
                return Err("invalid update conflict".into());
            }
            let work = info.work_paths.get(&path).unwrap_or(&path).clone();
            j.rows.push(Row {
                source_path: path,
                path: work,
                expected_hash: hash,
                result_hash: None,
                action: action.into(),
                state: "waiting".into(),
                result_id: None,
            });
        }
        for source in info
            .files
            .iter()
            .map(|f| &f.path)
            .chain(m.files.iter().map(|f| &f.path))
        {
            if !covered.contains(source) {
                let path = info.work_paths.get(source).unwrap_or(source);
                if m.files.iter().any(|f| &f.path == source)
                    || self.work_hash(root, path)?.is_some()
                {
                    return Err("incomplete update plan".into());
                }
            }
        }
        self.validate_work_paths(
            root,
            &m.files
                .iter()
                .map(|f| GuestFile {
                    path: f.path.clone(),
                    hash: f.hash.clone(),
                })
                .collect::<Vec<_>>(),
            &j.work_paths,
        )?;
        let mut destinations = HashSet::new();
        for r in &j.rows {
            if !destinations.insert(r.path.to_lowercase()) {
                return Err("update target collision".into());
            }
        }
        self.save_journal(root, &j)?;
        self.replay(root, &mut j)
    }
    fn validate_shared_target(&self, root: &Path, source: &str, target: &str) -> Result<()> {
        reader::valid_path(target)?;
        let good = source == target || shared_target_name(source, target);
        if !good || self.work_hash(root, target)?.is_some() {
            return Err("invalid shared target".into());
        }
        // Real filesystem existence catches case/Unicode aliases; explicit folding also works on Linux.
        if let Some(parent) = root.join(target).parent() {
            if parent.exists() {
                let name = Path::new(target)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .to_lowercase();
                for e in std::fs::read_dir(parent).map_err(|_| "cannot inspect target")? {
                    if e.map_err(|_| "cannot inspect target")?
                        .file_name()
                        .to_string_lossy()
                        .to_lowercase()
                        == name
                    {
                        return Err("shared target collision".into());
                    }
                }
            }
        }
        Ok(())
    }
    pub fn resume_update(&self, root: &Path) -> Result<GuestInfo> {
        let info = self.update_info(root)?;
        let mut j = self.journal(root, &info)?;
        if info.snapshot_id == j.to_snapshot_id {
            return self.finish_update(root);
        }
        self.replay(root, &mut j)
    }
    pub fn resolve_update(
        &self,
        root: &Path,
        path: &str,
        expected: Option<String>,
        content: Option<String>,
        choice: Option<&str>,
    ) -> Result<GuestInfo> {
        let info = self.update_info(root)?;
        let m = self.manifest(root, &info)?;
        let mut j = self.journal(root, &info)?;
        let i = j
            .rows
            .iter()
            .position(|r| r.source_path == path && r.state != "done")
            .ok_or("missing unresolved file")?;
        let row = &j.rows[i];
        if (content.is_some() && expected != row.expected_hash)
            || self.work_hash(root, &row.path)? != expected
        {
            return Err("GUEST_WORK_CHANGED".into());
        }
        let bytes = if let Some(content) = content {
            if row.action != "conflict" || !crate::project_share::is_md(path) {
                return Err("not a text conflict".into());
            }
            Some(content.into_bytes())
        } else {
            match choice {
                Some("keep-local") => None,
                Some("use-base") => {
                    let f = m
                        .files
                        .iter()
                        .find(|f| f.path == path)
                        .ok_or("missing new source")?;
                    Some(self.base_bytes(root, &m.snapshot_id, path, &f.hash)?)
                }
                _ => return Err("invalid file choice".into()),
            }
        };
        let (id, hash) = if let Some(bytes) = bytes {
            if bytes.len() > MAX_SOURCE {
                return Err("result exceeds limit".into());
            }
            let (id, hash) = self.stage_result(root, &m.snapshot_id, &bytes)?;
            (Some(id), Some(hash))
        } else {
            (None, expected.clone())
        };
        j.rows[i].expected_hash = expected;
        j.rows[i].action = if id.is_some() { "write" } else { "keep-local" }.into();
        j.rows[i].result_id = id;
        j.rows[i].result_hash = hash;
        j.rows[i].state = "intent".into();
        self.save_journal(root, &j)?;
        self.replay(root, &mut j)
    }
    pub fn update_status(&self, root: &Path) -> Result<serde_json::Value> {
        let info = self.update_info(root)?;
        let j = self.journal(root, &info)?;
        let manifest = self.manifest(root, &info)?;
        let rows = j
            .rows
            .iter()
            .map(|row| {
                let mut v = serde_json::to_value(row).map_err(|_| "invalid row")?;
                v["canUseBase"] = serde_json::json!(manifest
                    .files
                    .iter()
                    .any(|file| file.path == row.source_path));
                v["currentHash"] = serde_json::to_value(self.work_hash(root, &row.path)?)
                    .map_err(|_| "invalid hash")?;
                Ok(v)
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(serde_json::json!({"info":info,"rows":rows}))
    }
    pub fn finish_update(&self, root: &Path) -> Result<GuestInfo> {
        let mut info = self.update_info(root)?;
        let j = self.journal(root, &info)?;
        if j.rows.iter().any(|r| r.state != "done") {
            return Err("GUEST_UNRESOLVED".into());
        }
        if info.snapshot_id != j.to_snapshot_id {
            let m = self.manifest(root, &info)?;
            fault(3)?;
            info.snapshot_id = m.snapshot_id;
            info.entry = m.entry;
            info.files = m
                .files
                .into_iter()
                .map(|f| GuestFile {
                    path: f.path,
                    hash: f.hash,
                })
                .collect();
            info.work_paths = j.work_paths.clone();
            info.pending_update = None;
            self.write_info(&info)?;
            fault(4)?;
        }
        for path in [
            root.join(".notemd/base").join(&j.from_snapshot_id),
            root.join(".notemd/update-results").join(&j.to_snapshot_id),
        ] {
            self.checked(&path, true)?;
            if path.exists() {
                std::fs::remove_dir_all(path).map_err(|_| "cannot clean update material")?;
            }
        }
        for name in ["update-manifest.json", "update-plan.json"] {
            let path = self.checked(&root.join(".notemd").join(name), true)?;
            if path.exists() {
                std::fs::remove_file(path).map_err(|_| "cannot clean update journal")?;
            }
        }
        sync_directory(&root.join(".notemd"))?;
        Ok(info)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::share_guest::reader::File;
    fn snapshot(sid: &str, files: &[(&str, &[u8])]) -> Snapshot {
        Snapshot {
            manifest: Manifest {
                schema_version: 1,
                project_id: "pid".into(),
                snapshot_id: sid.into(),
                entry: files[0].0.into(),
                files: files
                    .iter()
                    .map(|(p, b)| File {
                        path: (*p).into(),
                        hash: sha256_hex(b),
                        bytes: b.len(),
                    })
                    .collect(),
            },
            source: files.iter().map(|(_, b)| b.to_vec()).collect(),
        }
    }
    fn setup(files: &[(&str, &[u8])]) -> (tempfile::TempDir, GuestStore, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let store = GuestStore::new(temp.path().into()).unwrap();
        let info = store
            .install(
                "https://share.example",
                "2026-10-14-test",
                "https://share.example/2026-10-14-test",
                &snapshot("S1", files),
            )
            .unwrap();
        let root = PathBuf::from(info.root);
        (temp, store, root)
    }
    fn plan(from: &str, to: &str, actions: serde_json::Value, choices: serde_json::Value) -> Plan {
        serde_json::from_value(serde_json::json!({"fromSnapshotId":from,"toSnapshotId":to,"actions":actions,"conflicts":[],"choices":choices})).unwrap()
    }
    fn copy(path: &str, source: &str, hash: Option<String>) -> serde_json::Value {
        serde_json::json!({"kind":"copy-base","path":path,"sourcePath":source,"expectedHash":hash})
    }
    #[test]
    fn update_collision_two_generations_submission_uses_share_identity() {
        let (_temp, s, root) = setup(&[("entry.md", b"entry")]);
        std::fs::write(root.join("a.md"), b"unknown").unwrap();
        std::fs::write(root.join("A.SHARED.MD"), b"unknown2").unwrap();
        s.prepare_update(
            &root,
            &snapshot("S2", &[("entry.md", b"entry"), ("a.md", b"new")]),
        )
        .unwrap();
        let bad = plan(
            "S1",
            "S2",
            serde_json::json!([
                copy("entry.md", "entry.md", Some(sha256_hex(b"entry"))),
                copy("a.shared.md", "a.md", None)
            ]),
            serde_json::json!([]),
        );
        assert!(s.apply_update(&root, bad).is_err());
        assert_eq!(
            std::fs::read(root.join("A.SHARED.MD")).unwrap(),
            b"unknown2"
        );
        let p = plan(
            "S1",
            "S2",
            serde_json::json!([
                copy("entry.md", "entry.md", Some(sha256_hex(b"entry"))),
                copy("a.shared-2.md", "a.md", None)
            ]),
            serde_json::json!([]),
        );
        s.apply_update(&root, p).unwrap();
        let info = s.finish_update(&root).unwrap();
        assert_eq!(info.work_paths["a.md"], "a.shared-2.md");
        s.prepare_update(
            &root,
            &snapshot("S3", &[("entry.md", b"entry"), ("a.md", b"next")]),
        )
        .unwrap();
        s.apply_update(
            &root,
            plan(
                "S2",
                "S3",
                serde_json::json!([
                    copy("entry.md", "entry.md", Some(sha256_hex(b"entry"))),
                    copy("a.shared-2.md", "a.md", Some(sha256_hex(b"new")))
                ]),
                serde_json::json!([]),
            ),
        )
        .unwrap();
        s.finish_update(&root).unwrap();
        std::fs::write(root.join("a.shared-2.md"), b"my edit").unwrap();
        let work = s.read_work(&root).unwrap();
        assert_eq!(work["base"]["a.md"]["hash"], sha256_hex(b"next"));
        assert_eq!(work["after"]["a.md"], "my edit");
        assert_eq!(work["info"]["snapshotId"], "S3");
        assert!(work["after"].get("a.shared-2.md").is_none());
        assert!(work["added"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("a.md")));
        assert_eq!(
            sha256_hex(&std::fs::read(root.join("a.md")).unwrap()),
            sha256_hex(b"unknown")
        );
        assert_eq!(
            sha256_hex(&std::fs::read(root.join("A.SHARED.MD")).unwrap()),
            sha256_hex(b"unknown2")
        );
    }
    #[test]
    fn binary_and_missing_choices_are_bytes_and_cas() {
        for keep in [true, false] {
            let (_temp, s, root) = setup(&[
                ("entry.md", b"entry"),
                ("image.png", &[0, 255, 1]),
                ("gone.md", b"old"),
            ]);
            std::fs::write(root.join("image.png"), [0, 254, 2]).unwrap();
            std::fs::remove_file(root.join("gone.md")).unwrap();
            s.prepare_update(
                &root,
                &snapshot(
                    "S2",
                    &[
                        ("entry.md", b"entry"),
                        ("image.png", &[0, 253, 3]),
                        ("gone.md", b"new"),
                    ],
                ),
            )
            .unwrap();
            let choices = serde_json::json!([{"path":"image.png","expectedHash":sha256_hex(&[0,254,2])},{"path":"gone.md","expectedHash":null}]);
            s.apply_update(
                &root,
                plan(
                    "S1",
                    "S2",
                    serde_json::json!([copy("entry.md", "entry.md", Some(sha256_hex(b"entry")))]),
                    choices,
                ),
            )
            .unwrap();
            assert!(s
                .resolve_update(
                    &root,
                    "image.png",
                    Some(sha256_hex(&[0, 253, 3])),
                    None,
                    Some("use-base")
                )
                .is_err());
            let choice = if keep { "keep-local" } else { "use-base" };
            s.resolve_update(
                &root,
                "image.png",
                Some(sha256_hex(&[0, 254, 2])),
                None,
                Some(choice),
            )
            .unwrap();
            s.resolve_update(&root, "gone.md", None, None, Some(choice))
                .unwrap();
            s.finish_update(&root).unwrap();
            assert_eq!(
                std::fs::read(root.join("image.png")).unwrap(),
                if keep {
                    vec![0, 254, 2]
                } else {
                    vec![0, 253, 3]
                }
            );
            assert_eq!(root.join("gone.md").exists(), !keep);
            if keep {
                assert_eq!(
                    s.read_work(&root).unwrap()["missing"],
                    serde_json::json!(["gone.md"])
                );
            }
        }
    }
    #[test]
    fn durable_result_survives_restart_at_each_write_and_metadata_boundary() {
        for point in 1..=4 {
            let (temp, s, root) = setup(&[("a.md", b"old")]);
            s.prepare_update(&root, &snapshot("S2", &[("a.md", b"new")]))
                .unwrap();
            UPDATE_FAILURE.with(|f| f.set(point));
            let p = plan(
                "S1",
                "S2",
                serde_json::json!([{"kind":"write","path":"a.md","expectedHash":sha256_hex(b"old"),"content":"merged human bytes\r\n"}]),
                serde_json::json!([]),
            );
            let applied = s.apply_update(&root, p);
            if point <= 2 {
                assert!(applied.is_err());
            } else {
                applied.unwrap();
                assert!(s.finish_update(&root).is_err());
            }
            assert!(root.join(".notemd/base/S1/a.md").exists());
            drop(s);
            let reopened = GuestStore::new(temp.path().into()).unwrap();
            reopened.resume_update(&root).unwrap();
            if reopened.inspect(&root).unwrap().pending_update.is_some() {
                reopened.finish_update(&root).unwrap();
            }
            assert_eq!(
                std::fs::read(root.join("a.md")).unwrap(),
                b"merged human bytes\r\n"
            );
            assert_eq!(reopened.inspect(&root).unwrap().snapshot_id, "S2");
            assert!(!root.join(".notemd/base/S1").exists());
        }
    }
    #[test]
    fn changed_work_stops_one_row_without_losing_other_progress() {
        let (temp, s, root) = setup(&[("a.md", b"A"), ("b.md", b"B")]);
        s.prepare_update(&root, &snapshot("S2", &[("a.md", b"A2"), ("b.md", b"B2")]))
            .unwrap();
        std::fs::write(root.join("a.md"), b"external").unwrap();
        s.apply_update(
            &root,
            plan(
                "S1",
                "S2",
                serde_json::json!([
                    copy("a.md", "a.md", Some(sha256_hex(b"A"))),
                    copy("b.md", "b.md", Some(sha256_hex(b"B")))
                ]),
                serde_json::json!([]),
            ),
        )
        .unwrap();
        drop(s);
        let s = GuestStore::new(temp.path().into()).unwrap();
        assert_eq!(
            s.resume_update(&root)
                .unwrap()
                .pending_update
                .unwrap()
                .unresolved,
            vec!["a.md"]
        );
        assert_eq!(std::fs::read(root.join("a.md")).unwrap(), b"external");
        assert_eq!(std::fs::read(root.join("b.md")).unwrap(), b"B2");
        s.resolve_update(
            &root,
            "a.md",
            Some(sha256_hex(b"external")),
            None,
            Some("keep-local"),
        )
        .unwrap();
        s.finish_update(&root).unwrap();
        assert_eq!(std::fs::read(root.join("a.md")).unwrap(), b"external");
    }
    #[test]
    fn conflict_is_zero_write_and_real_edited_result_is_replayable() {
        let (_temp, s, root) = setup(&[("a.md", b"old")]);
        std::fs::write(root.join("a.md"), b"mine").unwrap();
        s.prepare_update(&root, &snapshot("S2", &[("a.md", b"new")]))
            .unwrap();
        let p:Plan=serde_json::from_value(serde_json::json!({"fromSnapshotId":"S1","toSnapshotId":"S2","actions":[],"choices":[],"conflicts":[{"path":"a.md","expectedHash":sha256_hex(b"mine"),"proposal":{}}]})).unwrap();
        s.apply_update(&root, p).unwrap();
        assert_eq!(std::fs::read(root.join("a.md")).unwrap(), b"mine");
        UPDATE_FAILURE.with(|f| f.set(1));
        s.resolve_update(
            &root,
            "a.md",
            Some(sha256_hex(b"mine")),
            Some("human\r\n".into()),
            None,
        )
        .unwrap_err();
        assert_eq!(std::fs::read(root.join("a.md")).unwrap(), b"mine");
        s.resume_update(&root).unwrap();
        s.finish_update(&root).unwrap();
        assert_eq!(std::fs::read(root.join("a.md")).unwrap(), b"human\r\n");
    }
    #[test]
    fn untrusted_copy_traversal_and_incomplete_plans_never_write() {
        let (_temp, s, root) = setup(&[("a.md", b"old")]);
        s.prepare_update(
            &root,
            &snapshot("S2", &[("a.md", b"new"), ("new.md", b"new")]),
        )
        .unwrap();
        for action in [
            copy("../escape.md", "new.md", None),
            copy("a.md", "new.md", None),
            copy("out.md", "new.md", None),
            copy("new.md", "../escape.md", None),
        ] {
            assert!(s
                .apply_update(
                    &root,
                    plan(
                        "S1",
                        "S2",
                        serde_json::json!([action]),
                        serde_json::json!([])
                    )
                )
                .is_err());
            assert_eq!(std::fs::read(root.join("a.md")).unwrap(), b"old");
            assert!(!root.join("new.md").exists());
        }
    }
    #[test]
    fn unknown_content_is_neither_read_nor_decoded_by_update_capture() {
        let (_temp, s, root) = setup(&[("a.md", b"old")]);
        std::fs::write(root.join("unknown.md"), [255, 254, 0]).unwrap();
        s.prepare_update(&root, &snapshot("S2", &[("a.md", b"new")]))
            .unwrap();
        let captured = s.read_update(&root).unwrap();
        assert!(captured["occupied"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("unknown.md")));
        assert!(captured["work"].get("unknown.md").is_none());
        assert!(captured["workHashes"].get("unknown.md").is_none());
        assert_eq!(
            std::fs::read(root.join("unknown.md")).unwrap(),
            [255, 254, 0]
        );
    }
    #[test]
    fn real_ts_producer_plan_resolutions_and_submission_are_consumed() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("fixtures/update-producer.json")).unwrap();
        let base = fixture["input"]["oldBase"].as_object().unwrap();
        let old: Vec<_> = base
            .iter()
            .map(|(p, b)| (p.as_str(), b.as_str().unwrap().as_bytes()))
            .collect();
        let (_temp, s, root) = setup(&old);
        for (path, body) in fixture["input"]["work"].as_object().unwrap() {
            std::fs::write(root.join(path), body.as_str().unwrap()).unwrap();
        }
        let new: Vec<_> = fixture["input"]["newBase"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(p, b)| (p.as_str(), b.as_str().unwrap().as_bytes()))
            .collect();
        s.prepare_update(&root, &snapshot("S2", &new)).unwrap();
        let info = s
            .apply_update(
                &root,
                serde_json::from_value(fixture["plan"].clone()).unwrap(),
            )
            .unwrap();
        assert_eq!(info.pending_update.unwrap().unresolved.len(), 3);
        for r in fixture["resolutions"].as_array().unwrap() {
            let path = r["path"].as_str().unwrap();
            assert_eq!(
                std::fs::read_to_string(root.join(path)).unwrap(),
                fixture["input"]["work"][path].as_str().unwrap()
            );
            s.resolve_update(
                &root,
                path,
                Some(r["expectedHash"].as_str().unwrap().into()),
                Some(r["content"].as_str().unwrap().into()),
                None,
            )
            .unwrap();
        }
        s.finish_update(&root).unwrap();
        let actual = s.read_work(&root).unwrap();
        assert_eq!(actual["after"], fixture["after"]);
        let body = fixture["submission"].as_str().unwrap();
        s.queue(&root, "new-submission", body).unwrap();
        let info = s.inspect(&root).unwrap();
        assert_eq!(info.outbox[0].body, body);
        assert!(s
            .prepare_update(&root, &snapshot("S3", &new))
            .unwrap_err()
            .contains("GUEST_PENDING_CONFLICT"));
        let recovered = root.join(".notemd/guest-ack-recovery.json");
        write_atomic(&recovered, &serde_json::to_vec(&info.outbox[0]).unwrap()).unwrap();
        let mut cleared = info.clone();
        cleared.outbox.clear();
        s.write_info(&cleared).unwrap();
        assert!(s
            .prepare_update(&root, &snapshot("S3", &new))
            .unwrap_err()
            .contains("GUEST_PENDING_CONFLICT"));
        assert_eq!(s.inspect(&root).unwrap().outbox[0].body, body);
    }
}
