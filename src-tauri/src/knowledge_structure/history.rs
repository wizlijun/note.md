use habitat_core::{Snapshot, SNAPSHOT_PATH};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::{LazyLock, Mutex};

const MAX_READ_BYTES: usize = 64 * 1024 * 1024;
const MAX_SUMMARIES: usize = 256;

#[derive(Default)]
struct SummaryCache {
    values: HashMap<String, Value>,
    order: VecDeque<String>,
}
impl SummaryCache {
    fn insert(&mut self, oid: &str, summary: Value) {
        if self.values.contains_key(oid) {
            return;
        }
        while self.values.len() >= MAX_SUMMARIES {
            if let Some(oldest) = self.order.pop_front() {
                self.values.remove(&oldest);
            }
        }
        self.order.push_back(oid.to_owned());
        self.values.insert(oid.to_owned(), summary);
    }
}
// Blob OIDs address immutable bytes across repositories. Only fully validated
// small summaries are retained; branch/commit identity is never cached here.
static SUMMARIES: LazyLock<Mutex<SummaryCache>> =
    LazyLock::new(|| Mutex::new(SummaryCache::default()));

pub(crate) fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = crate::platform::command("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("KNOWLEDGE_GIT: {e}"))?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(format!(
            "KNOWLEDGE_GIT: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

pub(crate) fn git_text(root: &Path, args: &[&str]) -> Result<String, String> {
    String::from_utf8(git(root, args)?)
        .map_err(|_| "KNOWLEDGE_GIT: Git returned invalid UTF-8".into())
}

pub(crate) fn head(root: &Path) -> Result<Option<String>, String> {
    git(root, &["rev-parse", "--git-dir"])?;
    match git_text(root, &["rev-parse", "--verify", "HEAD"]) {
        Ok(value) => Ok(Some(value.trim().to_owned())),
        Err(_) => {
            // An unborn branch is valid. A detached/damaged HEAD is not.
            git(root, &["symbolic-ref", "-q", "HEAD"])?;
            Ok(None)
        }
    }
}

fn blob_oid(root: &Path, revision: &str) -> Result<Option<String>, String> {
    let tree = git(
        root,
        &["ls-tree", "-z", "-l", revision, "--", SNAPSHOT_PATH],
    )?;
    if tree.is_empty() {
        return Ok(None);
    }
    let entry = String::from_utf8(tree).map_err(|_| "KNOWLEDGE_INVALID_TREE")?;
    let metadata = entry.split('\t').next().ok_or("KNOWLEDGE_INVALID_TREE")?;
    let fields: Vec<_> = metadata.split_whitespace().collect();
    if fields.len() != 4 || fields[0] != "100644" || fields[1] != "blob" {
        return Err(
            "KNOWLEDGE_INVALID_TREE: snapshot must be a regular non-executable file".into(),
        );
    }
    let size: usize = fields[3]
        .parse()
        .map_err(|_| "KNOWLEDGE_INVALID_TREE: invalid blob size")?;
    if size > MAX_READ_BYTES {
        return Err("KNOWLEDGE_TOO_LARGE: historical blob exceeds read budget".into());
    }
    Ok(Some(fields[2].to_owned()))
}

pub(crate) fn blob(root: &Path, revision: &str) -> Result<Option<Vec<u8>>, String> {
    blob_oid(root, revision)?
        .map(|oid| git(root, &["cat-file", "blob", &oid]))
        .transpose()
}

fn validated_summary(root: &Path, oid: &str) -> Result<Value, String> {
    if let Some(summary) = SUMMARIES
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .values
        .get(oid)
        .cloned()
    {
        return Ok(summary);
    }
    // Do not retain the lock while reading/validating a large new snapshot.
    // Concurrent misses may validate twice, but can never publish unchecked data.
    let snapshot = validate_bytes(&git(root, &["cat-file", "blob", oid])?)?;
    let summary = json!({
        "snapshotId": snapshot.meta.snapshot_id,
        "parents": snapshot.meta.parents,
        "generatedAt": snapshot.meta.generated_at,
        "changeCause": snapshot.meta.change_cause,
        "schema": snapshot.meta.schema,
        "focus": snapshot.meta.focus,
        "attentionNodes": snapshot.attention.len(),
        "nodes": snapshot.nodes.len(),
        "edges": snapshot.edges.len()
    });
    SUMMARIES
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(oid, summary.clone());
    Ok(summary)
}

pub(crate) fn committed(root: &Path) -> Result<(Option<String>, Option<Vec<u8>>), String> {
    let revision = head(root)?;
    let bytes = revision
        .as_deref()
        .map(|r| blob(root, r))
        .transpose()?
        .flatten();
    Ok((revision, bytes))
}

pub(crate) fn validate_bytes(bytes: &[u8]) -> Result<Snapshot, String> {
    if bytes.len() > MAX_READ_BYTES {
        return Err("KNOWLEDGE_TOO_LARGE: snapshot exceeds read budget".into());
    }
    habitat_core::decode(bytes).map_err(|e| format!("KNOWLEDGE_INVALID_SNAPSHOT: {e}"))
}

/// Called under the shared RepositoryWriter lock, before *every* auto-stage.
/// A dedicated save owns pending/unknown edits; auto-sync must not bypass it.
pub fn guard_before_sync_commit(root: &Path) -> Result<(), String> {
    let (_, committed) = committed(root)?;
    let current = super::store::read_current(root)?;
    if current != committed {
        return Err(
            "KNOWLEDGE_STRUCTURE_PENDING: uncommitted structure requires its save/recovery service"
                .into(),
        );
    }
    if let Some(bytes) = &committed {
        validate_bytes(bytes)?;
    }
    // The working tree may equal HEAD while an older/foreign graph is staged.
    let staged = git_text(
        root,
        &["diff", "--cached", "--name-only", "--", SNAPSHOT_PATH],
    )?;
    if !staged.trim().is_empty() {
        return Err(
            "KNOWLEDGE_STRUCTURE_PENDING: staged structure requires its save/recovery service"
                .into(),
        );
    }
    Ok(())
}

/// Inspect immutable sides before invoking merge, including clean text merges.
pub fn guard_before_sync_merge(root: &Path, upstream: &str) -> Result<(), String> {
    let ours = head(root)?.ok_or("KNOWLEDGE_GIT: merge requires a local HEAD")?;
    let ours_bytes = blob(root, &ours)?;
    let theirs_bytes = blob(root, upstream)?;
    for bytes in [&ours_bytes, &theirs_bytes].into_iter().flatten() {
        validate_bytes(bytes)?;
    }
    let base = git_text(root, &["merge-base", &ours, upstream])?;
    let base_bytes = blob(root, base.trim())?;
    if ours_bytes != base_bytes && theirs_bytes != base_bytes && ours_bytes != theirs_bytes {
        return Err("KNOWLEDGE_STRUCTURE_CONFLICT: both branches changed the structure; preserve both snapshots and reconcile explicitly".into());
    }
    Ok(())
}

pub fn history(root: &Path, limit: usize) -> Result<Value, String> {
    super::store::check_repo(root)?;
    let limit = limit.clamp(1, 200);
    let count = (limit * 4 + 1).to_string();
    let commits = git_text(
        root,
        &[
            "log",
            "--all",
            "--full-history",
            "--topo-order",
            "--format=%H",
            "--max-count",
            &count,
            "--",
            SNAPSHOT_PATH,
        ],
    )?;
    let mut seen = HashSet::new();
    let mut versions = Vec::new();
    let mut truncated = false;
    let mut examined = 0;
    for commit in commits.lines() {
        examined += 1;
        let Some(oid) = blob_oid(root, commit)? else {
            continue;
        };
        let mut summary = validated_summary(root, &oid)?;
        if !seen.insert(summary["snapshotId"].as_str().unwrap().to_owned()) {
            continue;
        }
        if versions.len() == limit {
            truncated = true;
            break;
        }
        summary["commit"] = json!(commit);
        versions.push(summary);
    }
    truncated |= examined == limit * 4 + 1;
    Ok(json!({"versions": versions, "truncated": truncated}))
}

pub fn read_at(root: &Path, commit_id: &str) -> Result<Value, String> {
    super::store::check_repo(root)?;
    if !matches!(commit_id.len(), 40 | 64) || !commit_id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("KNOWLEDGE_INVALID_REVISION: expected a full commit hash".into());
    }
    git(
        root,
        &["cat-file", "-e", &format!("{commit_id}^{{commit}}")],
    )?;
    let bytes =
        blob(root, commit_id)?.ok_or("KNOWLEDGE_NOT_FOUND: no structure at this revision")?;
    let snapshot = validate_bytes(&bytes)?;
    Ok(json!({"snapshot": snapshot, "commit": commit_id}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge_structure::store::{
        save,
        tests::{fixture, snapshot},
    };

    #[test]
    fn divergent_valid_snapshots_are_stopped_before_merge() {
        let (dir, root) = fixture();
        let runtime = dir.path().join("runtime");
        let base = snapshot("base", None);
        save(&root, &runtime, None, &habitat_core::encode(&base).unwrap()).unwrap();
        git(&root, &["branch", "other"]).unwrap();
        let ours = snapshot("ours", Some(&base));
        save(
            &root,
            &runtime,
            Some(&base.meta.snapshot_id),
            &habitat_core::encode(&ours).unwrap(),
        )
        .unwrap();
        git(&root, &["switch", "other"]).unwrap();
        let theirs = snapshot("theirs", Some(&base));
        save(
            &root,
            &runtime,
            Some(&base.meta.snapshot_id),
            &habitat_core::encode(&theirs).unwrap(),
        )
        .unwrap();
        git(&root, &["switch", "main"]).unwrap();
        let before = head(&root).unwrap();
        let error = guard_before_sync_merge(&root, "other").unwrap_err();
        assert!(error.contains("STRUCTURE_CONFLICT"), "{error}");
        assert_eq!(head(&root).unwrap(), before);
        assert_eq!(
            validate_bytes(&blob(&root, "HEAD").unwrap().unwrap())
                .unwrap()
                .meta
                .snapshot_id,
            ours.meta.snapshot_id
        );
        assert_eq!(
            validate_bytes(&blob(&root, "other").unwrap().unwrap())
                .unwrap()
                .meta
                .snapshot_id,
            theirs.meta.snapshot_id
        );
        assert_eq!(
            history(&root, 20).unwrap()["versions"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
    }

    #[test]
    fn one_sided_valid_change_is_allowed_but_invalid_remote_is_not() {
        let (dir, root) = fixture();
        let runtime = dir.path().join("runtime");
        git(&root, &["branch", "old"]).unwrap();
        let s = snapshot("valid", None);
        save(&root, &runtime, None, &habitat_core::encode(&s).unwrap()).unwrap();
        guard_before_sync_merge(&root, "old").unwrap();
        git(&root, &["switch", "old"]).unwrap();
        guard_before_sync_merge(&root, "main").unwrap();
        git(&root, &["switch", "main"]).unwrap();
        std::fs::write(root.join(SNAPSHOT_PATH), b"not a snapshot\n").unwrap();
        git(&root, &["add", "--", SNAPSHOT_PATH]).unwrap();
        git(&root, &["commit", "-m", "invalid external version"]).unwrap();
        git(&root, &["switch", "old"]).unwrap();
        assert!(guard_before_sync_merge(&root, "main")
            .unwrap_err()
            .contains("INVALID_SNAPSHOT"));
    }

    #[test]
    fn staged_foreign_graph_is_not_committed_even_when_worktree_equals_head() {
        let (dir, root) = fixture();
        let runtime = dir.path().join("runtime");
        let s = snapshot("valid", None);
        let bytes = habitat_core::encode(&s).unwrap();
        save(&root, &runtime, None, &bytes).unwrap();
        std::fs::write(root.join(SNAPSHOT_PATH), b"foreign stage\n").unwrap();
        git(&root, &["add", "--", SNAPSHOT_PATH]).unwrap();
        std::fs::write(root.join(SNAPSHOT_PATH), &bytes).unwrap();
        assert!(guard_before_sync_commit(&root)
            .unwrap_err()
            .contains("PENDING"));
    }
    #[test]
    fn summary_cache_is_bounded_and_retains_no_graph_or_commit() {
        let mut cache = SummaryCache::default();
        for i in 0..=MAX_SUMMARIES {
            cache.insert(
                &format!("oid-{i}"),
                json!({"snapshotId":i,"nodes":3,"edges":2}),
            );
        }
        assert_eq!(cache.values.len(), MAX_SUMMARIES);
        assert_eq!(cache.order.len(), MAX_SUMMARIES);
        assert!(!cache.values.contains_key("oid-0"));
        assert_eq!(cache.values[&format!("oid-{MAX_SUMMARIES}")]["nodes"], 3);
    }

    #[test]
    fn cached_blob_summary_follows_the_current_commit_and_rejects_new_invalid_blobs() {
        let (dir, root) = fixture();
        let runtime = dir.path().join("runtime");
        let base = head(&root).unwrap().unwrap();
        let s = snapshot(&format!("cache-test-{}", uuid::Uuid::new_v4()), None);
        let bytes = habitat_core::encode(&s).unwrap();
        let first = save(&root, &runtime, None, &bytes).unwrap();
        let listed = history(&root, 20).unwrap();
        assert_eq!(listed["versions"][0]["commit"], first["commit"]);
        let oid = blob_oid(&root, "HEAD").unwrap().unwrap();
        // A cache hit requires neither another blob read nor a graph decode.
        let cached = validated_summary(&dir.path().join("absent-repo"), &oid).unwrap();
        assert_eq!(cached["snapshotId"], s.meta.snapshot_id);
        assert!(cached.get("commit").is_none());
        assert!(cached.get("sources").is_none());

        git(&root, &["switch", "-c", "replacement", &base]).unwrap();
        git(
            &root,
            &["commit", "--allow-empty", "-m", "different parent"],
        )
        .unwrap();
        let second = save(&root, &runtime, None, &bytes).unwrap();
        assert_ne!(first["commit"], second["commit"]);
        assert_eq!(
            blob_oid(&root, "HEAD").unwrap().as_deref(),
            Some(oid.as_str())
        );
        git(&root, &["branch", "-D", "main"]).unwrap();
        let listed = history(&root, 20).unwrap();
        assert_eq!(listed["versions"].as_array().unwrap().len(), 1);
        assert_eq!(listed["versions"][0]["commit"], second["commit"]);

        std::fs::write(root.join(SNAPSHOT_PATH), b"unknown compressed schema").unwrap();
        git(&root, &["add", "--", SNAPSHOT_PATH]).unwrap();
        git(&root, &["commit", "-m", "invalid remote-like version"]).unwrap();
        assert!(history(&root, 20).unwrap_err().contains("INVALID_SNAPSHOT"));
    }
}
