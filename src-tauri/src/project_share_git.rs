//! Local Git object/ref operations. No checkout, staging of the real index, or network IO.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::project_share::validate_relative;
use crate::vault_sync::git_ops;

#[derive(Debug, Clone)]
pub(crate) struct GitRepo {
    pub root: PathBuf,
    pub prefix: String,
    pub head: String,
    pub branch: Option<String>,
    pub remote: Option<String>,
}

pub(crate) struct GitAuthor {
    pub name: String,
    pub email: String,
    pub date: String,
}

fn text(
    repo: &Path,
    args: &[&str],
    env: &[(&str, &str)],
    input: Option<&[u8]>,
) -> Result<String, String> {
    String::from_utf8(git_ops::run_git_io(repo, args, env, input)?)
        .map(|s| s.trim_end_matches('\n').to_owned())
        .map_err(|_| "Git returned non-UTF-8 output".into())
}

pub(crate) fn probe(source: &Path) -> Result<Option<GitRepo>, String> {
    // Probe failures are the specified P0 fallback, including removed/moved repositories.
    let discover = || -> Option<GitRepo> {
        let source = source.canonicalize().ok()?;
        source.to_str()?;
        let result = text(
            &source,
            &["rev-parse", "--show-toplevel", "--is-bare-repository"],
            &[],
            None,
        )
        .ok()?;
        let root = result.strip_suffix("\nfalse")?;
        let root = Path::new(root).canonicalize().ok()?;
        root.to_str()?;
        let relative = source
            .strip_prefix(&root)
            .ok()?
            .components()
            .map(|component| component.as_os_str().to_str())
            .collect::<Option<Vec<_>>>()?
            .join("/");
        let prefix = if relative.is_empty() {
            relative
        } else {
            format!("{relative}/")
        };
        let head = text(
            &root,
            &["rev-parse", "--verify", "HEAD^{commit}"],
            &[],
            None,
        )
        .ok()?;
        let branch = text(
            &root,
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
            &[],
            None,
        )
        .ok();
        let remote = text(&root, &["remote"], &[], None)
            .ok()?
            .lines()
            .next()
            .map(str::to_owned);
        Some(GitRepo {
            root,
            prefix,
            head,
            branch,
            remote,
        })
    };
    Ok(discover())
}

fn check_oid(oid: &str) -> Result<(), String> {
    if matches!(oid.len(), 40 | 64) && oid.bytes().all(|c| c.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("invalid Git object id".into())
    }
}

fn repo_path(repo: &GitRepo, path: &str) -> Result<String, String> {
    validate_relative(path)?;
    // The prefix comes from canonical discovery, not from public request paths.
    let full = format!("{}{path}", repo.prefix);
    Ok(full)
}

fn entry_mode(
    repo: &GitRepo,
    commit: &str,
    path: &str,
    env: &[(&str, &str)],
) -> Result<Option<String>, String> {
    let output = git_ops::run_git_io(
        &repo.root,
        &["ls-tree", "-z", commit, "--", &format!(":(literal){path}")],
        env,
        None,
    )?;
    if output.is_empty() {
        return Ok(None);
    }
    let header = output
        .split(|c| *c == b'\t')
        .next()
        .ok_or("invalid tree entry")?;
    let mode = std::str::from_utf8(header)
        .map_err(|_| "invalid tree entry")?
        .split(' ')
        .next()
        .ok_or("invalid tree mode")?;
    Ok(Some(mode.to_owned()))
}

fn regular_mode(
    repo: &GitRepo,
    commit: &str,
    path: &str,
    env: &[(&str, &str)],
) -> Result<Option<String>, String> {
    // A missing descendant must not replace a symlink or gitlink ancestor.
    for (offset, _) in path.match_indices('/') {
        if let Some(mode) = entry_mode(repo, commit, &path[..offset], env)? {
            if mode != "040000" {
                return Err("Git path ancestor is not a directory".into());
            }
        }
    }
    let mode = entry_mode(repo, commit, path, env)?;
    if mode
        .as_deref()
        .is_some_and(|m| m != "100644" && m != "100755")
    {
        return Err("Git path is not a regular file".into());
    }
    Ok(mode)
}

pub(crate) fn read_blobs(
    repo: &GitRepo,
    commit: &str,
    paths: &[String],
) -> Result<BTreeMap<String, Vec<u8>>, String> {
    check_oid(commit)?;
    let mut result = BTreeMap::new();
    for path in paths {
        let full = repo_path(repo, path)?;
        regular_mode(repo, commit, &full, &[])?.ok_or("Git path is missing")?;
        let bytes = git_ops::run_git_io(
            &repo.root,
            &["cat-file", "blob", &format!("{commit}:{full}")],
            &[],
            None,
        )?;
        result.insert(path.clone(), bytes);
    }
    Ok(result)
}

pub(crate) fn build_commit(
    repo: &GitRepo,
    parent: &str,
    files: &BTreeMap<String, Vec<u8>>,
    message: &str,
    author: Option<&GitAuthor>,
) -> Result<String, String> {
    check_oid(parent)?;
    let temp = tempfile::Builder::new()
        .prefix("notemd-share-index-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    #[cfg(test)]
    tests::TEMP_INDEXES.with(|paths| paths.borrow_mut().push(temp.path().to_path_buf()));
    if temp
        .path()
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(&repo.root)
    {
        return Err("temporary index must be outside repository".into());
    }
    // The directory owns both index and index.lock and removes them on every return path.
    let index = temp.path().join("index");
    let index = index.to_str().ok_or("non-UTF-8 temporary index path")?;
    let mut env = vec![("GIT_INDEX_FILE", index)];
    if let Some(author) = author {
        env.extend([
            ("GIT_AUTHOR_NAME", author.name.as_str()),
            ("GIT_AUTHOR_EMAIL", author.email.as_str()),
            ("GIT_AUTHOR_DATE", author.date.as_str()),
        ]);
    }
    text(&repo.root, &["read-tree", parent], &env, None)?;
    for (path, bytes) in files {
        let full = repo_path(repo, path)?;
        let mode = regular_mode(repo, parent, &full, &env)?.unwrap_or_else(|| "100644".into());
        let oid = text(
            &repo.root,
            &["hash-object", "-w", &format!("--path={full}"), "--stdin"],
            &env,
            Some(bytes),
        )?;
        text(
            &repo.root,
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("{mode},{oid},{full}"),
            ],
            &env,
            None,
        )?;
    }
    let tree = text(&repo.root, &["write-tree"], &env, None)?;
    text(
        &repo.root,
        &["commit-tree", &tree, "-p", parent, "-F", "-"],
        &env,
        Some(message.as_bytes()),
    )
}

/// Compare semantic object identity, deliberately excluding committer time. Retries
/// may run days later; a freshly-created oid is not an idempotency check.
pub(crate) fn same_commit(repo: &GitRepo, existing: &str, candidate: &str) -> Result<bool, String> {
    check_oid(existing)?;
    check_oid(candidate)?;
    let fields = "--format=%T%x00%P%x00%an%x00%ae%x00%aI%x00%B";
    Ok(
        text(&repo.root, &["show", "-s", fields, existing], &[], None)?
            == text(&repo.root, &["show", "-s", fields, candidate], &[], None)?,
    )
}
pub(crate) fn verify_authored_commit(
    repo: &GitRepo,
    oid: &str,
    parent: &str,
    message: &str,
    author: &GitAuthor,
) -> Result<(), String> {
    check_oid(oid)?;
    check_oid(parent)?;
    let date = chrono::DateTime::parse_from_rfc3339(&author.date)
        .map_err(|_| "invalid feedback receipt date")?
        .timestamp();
    let actual = text(
        &repo.root,
        &["show", "-s", "--format=%P%x00%an%x00%ae%x00%at%x00%B", oid],
        &[],
        None,
    )?;
    let expected = format!(
        "{parent}\0{}\0{}\0{date}\0{}",
        author.name,
        author.email,
        message.trim_end_matches('\n')
    );
    if actual != expected {
        return Err("branch commit identity mismatch".into());
    }
    Ok(())
}

pub(crate) fn ref_oid(repo: &GitRepo, name: &str) -> Result<Option<String>, String> {
    text(&repo.root, &["check-ref-format", name], &[], None)?;
    // for-each-ref succeeds with empty output only for an absent reference.
    let output = text(
        &repo.root,
        &[
            "for-each-ref",
            "--format=%(refname)%09%(objectname)%09%(symref)",
            name,
        ],
        &[],
        None,
    )?;
    for line in output.lines() {
        let fields: Vec<_> = line.split('\t').collect();
        if fields.first().copied() == Some(name) {
            if fields.len() != 3 || !fields[2].is_empty() {
                return Err("symbolic Git ref is not owned by project sharing".into());
            }
            check_oid(fields[1])?;
            return Ok(Some(fields[1].into()));
        }
    }
    Ok(None)
}
pub(crate) fn owner_author(repo: &GitRepo, date: &str) -> Result<GitAuthor, String> {
    let name = text(&repo.root, &["config", "user.name"], &[], None)
        .map_err(|_| "Git owner name is not configured")?;
    let email = text(&repo.root, &["config", "user.email"], &[], None)
        .map_err(|_| "Git owner email is not configured")?;
    if name.trim().is_empty() || email.trim().is_empty() {
        return Err("Git owner identity is not configured".into());
    }
    Ok(GitAuthor {
        name,
        email,
        date: date.into(),
    })
}
pub(crate) fn ensure_head(repo: &GitRepo, expected: &str) -> Result<(), String> {
    check_oid(expected)?;
    if text(
        &repo.root,
        &["rev-parse", "--verify", "HEAD^{commit}"],
        &[],
        None,
    )? != expected
    {
        return Err("HEAD changed; prepare again".into());
    }
    Ok(())
}
pub(crate) fn ensure_snapshot_not_ancestor(
    repo: &GitRepo,
    snapshot: &str,
    head: &str,
) -> Result<(), String> {
    check_oid(snapshot)?;
    check_oid(head)?;
    if text(
        &repo.root,
        &["merge-base", "--is-ancestor", snapshot, head],
        &[],
        None,
    )
    .is_ok()
    {
        return Err("snapshot must not be an ancestor of a user branch".into());
    }
    // --is-ancestor exits 1 for unrelated history too. A successful reachability
    // query proves non-ancestry; other command errors remain errors.
    if text(
        &repo.root,
        &["rev-list", "--max-count=1", snapshot, "--not", head],
        &[],
        None,
    )? != snapshot
    {
        return Err("cannot establish snapshot isolation".into());
    }
    Ok(())
}
pub(crate) fn delete_created_ref(repo: &GitRepo, name: &str, oid: &str) -> Result<(), String> {
    if !name.starts_with("refs/notemd/share/") {
        return Err("not a hidden share ref".into());
    }
    check_oid(oid)?;
    text(
        &repo.root,
        &["update-ref", "--no-deref", "-d", name, oid],
        &[],
        None,
    )
    .map(|_| ())
}
fn suggestion_branch_base(entry: &str, submission: &str) -> String {
    let stem = Path::new(entry)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let mut slug = String::new();
    for c in stem.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "project" } else { slug };
    let short: String = submission.chars().take(8).collect();
    format!("notemd/{slug}/{short}")
}

pub(crate) fn available_branch(
    repo: &GitRepo,
    entry: &str,
    submission: &str,
) -> Result<String, String> {
    let base = suggestion_branch_base(entry, submission);
    for n in 1..=9 {
        let branch = if n == 1 {
            base.clone()
        } else {
            format!("{base}-{n}")
        };
        text(
            &repo.root,
            &["check-ref-format", "--branch", &branch],
            &[],
            None,
        )?;
        let name = format!("refs/heads/{branch}");
        let existing = text(
            &repo.root,
            &["for-each-ref", "--format=%(refname)", &name],
            &[],
            None,
        )?;
        // Symbolic user refs count as collisions too; never dereference them.
        if !existing.lines().any(|reference| reference == name) {
            return Ok(branch);
        }
    }
    Err("all nine suggestion branch names are already in use".into())
}

pub(crate) fn create_ref(repo: &GitRepo, name: &str, oid: &str) -> Result<(), String> {
    check_oid(oid)?;
    text(&repo.root, &["check-ref-format", name], &[], None)?;
    let result = text(
        &repo.root,
        &[
            "update-ref",
            "--no-deref",
            name,
            oid,
            &"0".repeat(oid.len()),
        ],
        &[],
        None,
    );
    match result {
        Ok(_) => Ok(()),
        Err(error) => {
            if text(
                &repo.root,
                &["show-ref", "--verify", "--hash", name],
                &[],
                None,
            )
            .ok()
            .as_deref()
                == Some(oid)
            {
                Ok(())
            } else {
                Err(error)
            }
        }
    }
}

/// User branches never use hidden refs' same-oid fallback. Recovery skips this
/// create operation only after the store validates its persisted intent.
pub(crate) fn create_branch_ref(repo: &GitRepo, branch: &str, oid: &str) -> Result<(), String> {
    check_oid(oid)?;
    text(
        &repo.root,
        &["check-ref-format", "--branch", branch],
        &[],
        None,
    )?;
    text(
        &repo.root,
        &[
            "update-ref",
            "--no-deref",
            &format!("refs/heads/{branch}"),
            oid,
            &"0".repeat(oid.len()),
        ],
        &[],
        None,
    )
    .map(|_| ())
}

// Tests of the convenience primitive exercise the same reservation and CAS
// functions used by the store's persistent two-phase branch operation.
#[cfg(test)]
pub(crate) fn branch_ref(
    repo: &GitRepo,
    entry: &str,
    submission: &str,
    oid: &str,
) -> Result<String, String> {
    check_oid(oid)?;
    let branch = available_branch(repo, entry, submission)?;
    create_branch_ref(repo, &branch, oid)?;
    Ok(branch)
}

pub(crate) fn format_patch(repo: &GitRepo, oid: &str) -> Result<String, String> {
    check_oid(oid)?;
    String::from_utf8(git_ops::run_git_io(
        &repo.root,
        &["format-patch", "-1", oid, "--stdout"],
        &[],
        None,
    )?)
    .map_err(|_| "Git patch is not UTF-8".into())
}

pub(crate) fn delete_project_refs(repo: &GitRepo, project_id: &str) -> Result<(), String> {
    if project_id.is_empty() || project_id.contains('/') {
        return Err("invalid project id".into());
    }
    let prefix = format!("refs/notemd/share/{project_id}/");
    text(
        &repo.root,
        &["check-ref-format", &format!("{prefix}sentinel")],
        &[],
        None,
    )?;
    let refs = text(
        &repo.root,
        &["for-each-ref", "--format=%(refname)", &prefix],
        &[],
        None,
    )?;
    for name in refs.lines() {
        if !name.starts_with(&prefix) {
            return Err("unexpected project ref".into());
        }
        text(
            &repo.root,
            &["update-ref", "--no-deref", "-d", name],
            &[],
            None,
        )?;
    }
    Ok(())
}

pub(crate) fn guest_author(name: Option<&str>, submission: &str, received_at: &str) -> GitAuthor {
    let name: String = name
        .unwrap_or("guest")
        .chars()
        .filter(|c| !c.is_control() && *c != '<' && *c != '>' && *c != '@')
        .collect();
    let name = name.trim();
    // git mailinfo falls back to email for names over 60 bytes or containing @<>.
    // Reserve 20 bytes for the unverified guest suffix, without splitting UTF-8.
    let mut end = name.len().min(40);
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    let name = &name[..end];
    let name = if name.trim().is_empty() {
        "guest"
    } else {
        name.trim()
    };
    GitAuthor {
        name: format!("{name} (guest, unverified)"),
        email: format!("{submission}@guest.notemd.invalid"),
        date: received_at.to_owned(),
    }
}

pub(crate) fn submission_message(
    project_id: &str,
    snapshot: &str,
    submission: &str,
    name: Option<&str>,
    message: Option<&str>,
    ai: Option<bool>,
    head: Option<&str>,
    coauthor: bool,
) -> String {
    let short: String = submission.chars().take(8).collect();
    let mut slug = String::new();
    for c in name
        .unwrap_or("")
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '-')
    {
        if c != '-' || !slug.ends_with('-') {
            slug.push(c);
        }
        if slug.len() == 32 {
            break;
        }
    }
    if slug.is_empty() {
        slug = short.clone();
    }
    let cleaned: String = message
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect();
    let clean_line = |line: &str| -> String {
        let key = line.split_once(':').map(|(k, _)| k.to_ascii_lowercase());
        let dangerous = key.as_deref().is_some_and(|k| {
            matches!(
                k,
                "co-authored-by" | "signed-off-by" | "reviewed-by" | "acked-by"
            ) || k.strip_prefix("notemd-").is_some_and(|s| {
                !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphabetic() || b == b'-')
            })
        });
        if dangerous {
            format!("> {line}")
        } else {
            line.to_owned()
        }
    };
    let mut lines = cleaned.lines();
    let title = lines
        .next()
        .filter(|s| !s.trim().is_empty())
        .map(clean_line)
        .unwrap_or_else(|| format!("notemd: suggestion {short}"));
    let mut output: String = title.chars().take(72).collect();
    let body = lines.map(clean_line).collect::<Vec<_>>().join("\n");
    if !body.trim().is_empty() {
        output.push_str("\n\n");
        output.push_str(body.trim_end());
    }
    output.push_str("\n\n");
    if coauthor {
        let author = guest_author(name, submission, "");
        output.push_str(&format!(
            "Co-authored-by: {} <{}>\n",
            author.name, author.email
        ));
    }
    output.push_str(&format!(
        "Notemd-Project: {project_id}\nNotemd-Snapshot: {snapshot}\n"
    ));
    if let Some(head) = head {
        output.push_str(&format!("Notemd-Base: {head}\n"));
    }
    let ai = match ai {
        Some(true) => "yes",
        Some(false) => "no",
        None => "unknown",
    };
    output.push_str(&format!("Notemd-Submission: {submission}\nNotemd-Contributor: human:guest-{slug} (unverified, self-reported)\nNotemd-AI-Assisted: {ai}\n"));
    output
}

#[cfg(test)]
mod tests {
    thread_local! {
        pub(super) static TEMP_INDEXES: std::cell::RefCell<Vec<std::path::PathBuf>> = const { std::cell::RefCell::new(Vec::new()) };
    }
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn available() -> bool {
        if git_ops::version().is_none() {
            eprintln!("SKIP project_share_git: git unavailable");
            false
        } else {
            true
        }
    }
    fn git(repo: &Path, args: &[&str]) -> String {
        git_ops::run_git(repo, args).unwrap()
    }
    fn fixture() -> TempDir {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        git(dir.path(), &["config", "user.name", "Owner"]);
        git(dir.path(), &["config", "user.email", "owner@example.test"]);
        fs::write(dir.path().join("entry.md"), b"base\n").unwrap();
        fs::write(dir.path().join("keep.md"), b"keep\n").unwrap();
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-qm", "initial"]);
        dir
    }
    fn tree(path: &Path) -> BTreeMap<PathBuf, (Vec<u8>, u32)> {
        fn visit(base: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, (Vec<u8>, u32)>) {
            if !dir.exists() {
                return;
            }
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.file_name().unwrap() == ".git" {
                    continue;
                }
                let meta = fs::symlink_metadata(&path).unwrap();
                #[cfg(unix)]
                let mode = {
                    use std::os::unix::fs::PermissionsExt;
                    meta.permissions().mode()
                };
                #[cfg(not(unix))]
                let mode = u32::from(meta.permissions().readonly());
                if meta.is_dir() {
                    visit(base, &path, out);
                } else {
                    let bytes = if meta.file_type().is_symlink() {
                        fs::read_link(&path)
                            .unwrap()
                            .to_string_lossy()
                            .as_bytes()
                            .to_vec()
                    } else {
                        fs::read(&path).unwrap()
                    };
                    out.insert(
                        path.strip_prefix(base).unwrap().to_path_buf(),
                        (bytes, mode),
                    );
                }
            }
        }
        let mut result = BTreeMap::new();
        visit(path, path, &mut result);
        result
    }
    #[derive(Debug, PartialEq)]
    struct State {
        status: Result<Vec<u8>, String>,
        index: Option<Vec<u8>>,
        head: Vec<u8>,
        head_oid: String,
        branch: Option<String>,
        config: Vec<u8>,
        config_list: String,
        hooks: BTreeMap<PathBuf, (Vec<u8>, u32)>,
        files: BTreeMap<PathBuf, (Vec<u8>, u32)>,
    }
    fn state(repo: &Path) -> State {
        fn git_path(repo: &Path, name: &str) -> PathBuf {
            let p = PathBuf::from(git(repo, &["rev-parse", "--git-path", name]).trim());
            if p.is_absolute() {
                p
            } else {
                repo.join(p)
            }
        }
        // Optional locks are disabled so status cannot refresh the real index. A required
        // failing filter can also make status fail; preserve that result for comparison.
        let status = git_ops::run_git_io(
            repo,
            &["status", "--porcelain=v2", "-z"],
            &[("GIT_OPTIONAL_LOCKS", "0")],
            None,
        );
        State {
            status,
            index: fs::read(git_path(repo, "index")).ok(),
            head: fs::read(git_path(repo, "HEAD")).unwrap(),
            head_oid: git(repo, &["rev-parse", "HEAD"]),
            branch: git_ops::run_git(repo, &["symbolic-ref", "-q", "HEAD"]).ok(),
            config: fs::read(git_path(repo, "config")).unwrap(),
            config_list: git(repo, &["config", "--list", "--local"]),
            hooks: tree(&git_path(repo, "hooks")),
            files: tree(repo),
        }
    }
    fn unchanged<T>(repo: &Path, action: impl FnOnce() -> T) -> T {
        TEMP_INDEXES.with(|paths| paths.borrow_mut().clear());
        let before = state(repo);
        let result = action();
        let after = state(repo);
        assert_eq!(after.status, before.status, "status changed");
        assert_eq!(after.index, before.index, "real index changed");
        assert_eq!(after.head, before.head, "HEAD file changed");
        assert_eq!(after.head_oid, before.head_oid, "HEAD oid changed");
        assert_eq!(after.branch, before.branch, "symbolic branch changed");
        assert_eq!(after.config, before.config, "local config bytes changed");
        assert_eq!(
            after.config_list, before.config_list,
            "local config changed"
        );
        assert!(after.hooks == before.hooks, "hooks changed");
        assert_eq!(after.files, before.files, "source bytes/mode changed");
        TEMP_INDEXES.with(|paths| {
            for path in paths.borrow_mut().drain(..) {
                assert!(!path.exists(), "temporary index directory leaked: {}", path.display());
            }
        });
        result
    }
    fn unchanged_with_index<T>(repo: &Path, action: impl FnOnce() -> T) -> T {
        unchanged(repo, || {
            let result = action();
            TEMP_INDEXES.with(|paths| assert!(!paths.borrow().is_empty(), "operation must create a temporary index"));
            result
        })
    }
    fn files(path: &str, bytes: &[u8]) -> BTreeMap<String, Vec<u8>> {
        BTreeMap::from([(path.to_string(), bytes.to_vec())])
    }
    fn context(repo: &Path) -> GitRepo {
        unchanged(repo, || probe(repo)).unwrap().unwrap()
    }

    #[test]
    fn user_branch_create_rejects_same_oid_collision() {
        if !available() {
            return;
        }
        let t = fixture();
        let repo = context(t.path());
        create_branch_ref(&repo, "notemd/collision/test", &repo.head).unwrap();
        assert!(create_branch_ref(&repo, "notemd/collision/test", &repo.head).is_err());
    }

    #[test]
    fn g1_g2_snapshot_preserves_dirty_index_worktree_identity_and_modes() {
        if !available() {
            return;
        }
        let dir = fixture();
        let root = dir.path();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root.join("entry.md"), fs::Permissions::from_mode(0o755)).unwrap();
            git(root, &["add", "entry.md"]);
            git(root, &["commit", "-qm", "executable"]);
        }
        fs::write(root.join("keep.md"), b"staged\n").unwrap();
        git(root, &["add", "keep.md"]);
        fs::write(root.join("keep.md"), b"unstaged\n").unwrap();
        fs::write(root.join("entry.md"), b"snapshot\n").unwrap();
        let repo = context(root);
        let oid = unchanged(root, || {
            build_commit(
                &repo,
                &repo.head,
                &files("entry.md", b"snapshot\n"),
                "snapshot\n",
                None,
            )
        })
        .unwrap();
        assert_eq!(
            git(root, &["rev-parse", &format!("{oid}^")]).trim(),
            repo.head
        );
        let blobs = unchanged(root, || {
            read_blobs(&repo, &oid, &["entry.md".into(), "keep.md".into()])
        })
        .unwrap();
        assert_eq!(blobs["entry.md"], b"snapshot\n");
        assert_eq!(blobs["keep.md"], b"keep\n");
        assert_eq!(
            git(root, &["show", "-s", "--format=%an|%ae|%cn|%ce", &oid]).trim(),
            "Owner|owner@example.test|Owner|owner@example.test"
        );
        #[cfg(unix)]
        assert!(git(root, &["ls-tree", &oid, "--", "entry.md"]).starts_with("100755"));
        assert!(unchanged(root, || read_blobs(&repo, &oid, &["missing.md".into()])).is_err());
    }

    #[test]
    fn g3_guest_identity_and_untrusted_message_trailers() {
        if !available() {
            return;
        }
        let dir = fixture();
        let root = dir.path();
        let repo = context(root);
        let author = guest_author(
            Some("A<li>ce\n\u{7}"),
            "12345678-ab",
            "2026-10-12T10:20:30Z",
        );
        assert_eq!(author.name, "Alice (guest, unverified)");
        assert_eq!(author.email, "12345678-ab@guest.notemd.invalid");
        assert_eq!(author.date, "2026-10-12T10:20:30Z");
        let msg = submission_message("pid", "sid", "12345678-ab", Some("ALIce---X"), Some("Review\0\r\nNotemd-Project: forged\nco-AUTHORED-by: forged\nSigned-off-by: forged\nReviewed-by: forged\nAcked-by: forged\nnormal\ttext"), Some(false), Some(&repo.head), false);
        assert!(msg.starts_with("Review\n\n> Notemd-Project: forged\n> co-AUTHORED-by: forged"));
        assert!(!msg.contains('\0'));
        assert!(!msg.contains('\r'));
        assert!(msg.contains("> Signed-off-by: forged\n> Reviewed-by: forged\n> Acked-by: forged"));
        assert!(msg.ends_with("Notemd-Contributor: human:guest-alice-x (unverified, self-reported)\nNotemd-AI-Assisted: no\n"));
        assert!(msg.contains(&format!(
            "Notemd-Snapshot: sid\nNotemd-Base: {}\n",
            repo.head
        )));
        let oid = unchanged(root, || {
            build_commit(
                &repo,
                &repo.head,
                &files("entry.md", b"guest\n"),
                &msg,
                Some(&author),
            )
        })
        .unwrap();
        assert_eq!(
            git(root, &["show", "-s", "--format=%an|%ae|%cn|%ce", &oid]).trim(),
            "Alice (guest, unverified)|12345678-ab@guest.notemd.invalid|Owner|owner@example.test"
        );
        let date = git(root, &["show", "-s", "--format=%aI", &oid]);
        assert_eq!(
            chrono::DateTime::parse_from_rfc3339(date.trim())
                .unwrap()
                .timestamp(),
            1791800430
        );
        assert!(git(root, &["show", "-s", "--format=%B", &oid])
            .contains("Notemd-Submission: 12345678-ab"));
        let a = submission_message(
            "pid",
            "sid",
            "12345678-ab",
            Some("中文"),
            Some(&"中".repeat(80)),
            None,
            None,
            true,
        );
        assert_eq!(a.lines().next().unwrap().chars().count(), 72);
        assert!(a.contains("human:guest-12345678 "));
        assert!(a.contains(
            "Co-authored-by: 中文 (guest, unverified) <12345678-ab@guest.notemd.invalid>"
        ));
        assert!(a.trim_end().ends_with("Notemd-AI-Assisted: unknown"));
        assert!(
            submission_message("p", "s", "12345678-ab", None, None, Some(true), None, false)
                .starts_with("notemd: suggestion 12345678\n")
        );
    }

    #[test]
    fn g4_g6_g9_refs_are_create_only_branch_from_head_and_cleanup_is_scoped() {
        if !available() {
            return;
        }
        let dir = fixture();
        let root = dir.path();
        let repo = context(root);
        let snapshot = unchanged(root, || {
            build_commit(
                &repo,
                &repo.head,
                &files("entry.md", b"snapshot\n"),
                "snapshot\n",
                None,
            )
        })
        .unwrap();
        let submission = unchanged(root, || {
            build_commit(
                &repo,
                &snapshot,
                &files("entry.md", b"guest\n"),
                "submission\n",
                None,
            )
        })
        .unwrap();
        let result = unchanged(root, || {
            build_commit(
                &repo,
                &repo.head,
                &files("entry.md", b"guest\n"),
                "review\n",
                None,
            )
        })
        .unwrap();
        for (name, oid) in [
            ("refs/notemd/share/p/snapshots/s", &snapshot),
            ("refs/notemd/share/p/submissions/s", &submission),
            ("refs/notemd/share/other/snapshots/s", &snapshot),
        ] {
            unchanged(root, || create_ref(&repo, name, oid)).unwrap();
        }
        unchanged(root, || {
            create_ref(&repo, "refs/notemd/share/p/snapshots/s", &snapshot)
        })
        .unwrap();
        assert!(unchanged(root, || create_ref(
            &repo,
            "refs/notemd/share/p/snapshots/s",
            &result
        ))
        .is_err());
        assert!(unchanged(root, || create_ref(
            &repo,
            "refs/notemd/share/../bad",
            &result
        ))
        .is_err());
        let first = unchanged(root, || {
            branch_ref(&repo, "docs/Hello World.md", "12345678-ab", &result)
        })
        .unwrap();
        assert_eq!(first, "notemd/hello-world/12345678");
        assert_eq!(
            git(root, &["rev-parse", &format!("{first}^")]).trim(),
            repo.head
        );
        assert!(
            git_ops::run_git(root, &["merge-base", "--is-ancestor", &snapshot, &first]).is_err()
        );
        // A same-oid branch collision still belongs to the user and must choose another name.
        for n in 2..=9 {
            assert_eq!(
                unchanged(root, || branch_ref(
                    &repo,
                    "Hello World.md",
                    "12345678-ab",
                    &result
                ))
                .unwrap(),
                format!("{first}-{n}")
            );
        }
        assert!(unchanged(root, || branch_ref(
            &repo,
            "Hello World.md",
            "12345678-ab",
            &result
        ))
        .is_err());
        assert_eq!(
            unchanged(root, || branch_ref(&repo, "中文.md", "abcdef12", &result)).unwrap(),
            "notemd/project/abcdef12"
        );
        unchanged(root, || delete_project_refs(&repo, "p")).unwrap();
        assert!(git(
            root,
            &[
                "for-each-ref",
                "--format=%(refname)",
                "refs/notemd/share/p/"
            ]
        )
        .is_empty());
        assert!(!git(
            root,
            &[
                "for-each-ref",
                "--format=%(refname)",
                "refs/notemd/share/other/"
            ]
        )
        .is_empty());
        assert_eq!(git(root, &["rev-parse", &first]).trim(), result);
        assert!(unchanged(root, || delete_project_refs(&repo, "../other")).is_err());
    }

    #[test]
    fn g7_nested_prefix_spaces_and_linked_worktree() {
        if !available() {
            return;
        }
        let dir = fixture();
        let root = dir.path();
        fs::create_dir_all(root.join("nested project/docs")).unwrap();
        fs::write(root.join("nested project/docs/a b.md"), b"old\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "nested"]);
        let repo = unchanged(root, || probe(&root.join("nested project")))
            .unwrap()
            .unwrap();
        assert_eq!(repo.prefix, "nested project/");
        assert_eq!(repo.root, root.canonicalize().unwrap());
        let oid = unchanged(root, || {
            build_commit(
                &repo,
                &repo.head,
                &files("docs/a b.md", b"new\0bytes\n"),
                "nested\n",
                None,
            )
        })
        .unwrap();
        assert_eq!(
            unchanged(root, || read_blobs(&repo, &oid, &["docs/a b.md".into()])).unwrap()
                ["docs/a b.md"],
            b"new\0bytes\n"
        );
        let linked = tempfile::tempdir().unwrap();
        let path = linked.path().join("worktree");
        git(
            root,
            &[
                "worktree",
                "add",
                "--detach",
                path.to_str().unwrap(),
                "HEAD",
            ],
        );
        assert!(path.join(".git").is_file());
        let wt = context(&path);
        assert!(wt.branch.is_none());
        unchanged(&path, || {
            build_commit(
                &wt,
                &wt.head,
                &files("entry.md", b"linked\n"),
                "linked\n",
                None,
            )
        })
        .unwrap();
    }

    #[test]
    fn g8_probe_degrades_and_remote_is_fresh() {
        if !available() {
            return;
        }
        let plain = tempfile::tempdir().unwrap();
        assert!(probe(plain.path()).unwrap().is_none());
        assert!(probe(&plain.path().join("missing")).unwrap().is_none());
        git(plain.path(), &["init", "-q"]);
        assert!(probe(plain.path()).unwrap().is_none());
        let bare = tempfile::tempdir().unwrap();
        git(bare.path(), &["init", "--bare", "-q"]);
        assert!(probe(bare.path()).unwrap().is_none());
        let dir = fixture();
        let repo = context(dir.path());
        assert!(repo.remote.is_none());
        assert!(repo.branch.is_some());
        git(
            dir.path(),
            &[
                "remote",
                "add",
                "team",
                "https://example.invalid/no-network",
            ],
        );
        assert_eq!(context(dir.path()).remote.as_deref(), Some("team"));
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            let p = dir.path().join(std::ffi::OsString::from_vec(vec![0xff]));
            if let Err(e) = fs::create_dir(&p) {
                eprintln!("non-UTF-8 directory fixture unavailable on this filesystem: {e}; testing non-UTF-8 Path input fallback");
            }
            assert!(probe(&p).unwrap().is_none());
        }
    }

    #[test]
    fn g10_patch_applies_to_copy_of_head() {
        if !available() {
            return;
        }
        let dir = fixture();
        let root = dir.path();
        let repo = context(root);
        let author = guest_author(Some("Visitor"), "12345678", "2026-10-12T10:20:30Z");
        let oid = unchanged(root, || {
            build_commit(
                &repo,
                &repo.head,
                &files("entry.md", b"accepted\n"),
                "Review\n",
                Some(&author),
            )
        })
        .unwrap();
        let patch = unchanged(root, || format_patch(&repo, &oid)).unwrap();
        let copy = tempfile::tempdir().unwrap();
        fn copy_dir(from: &Path, to: &Path) {
            fs::create_dir_all(to).unwrap();
            for entry in fs::read_dir(from).unwrap() {
                let p = entry.unwrap().path();
                let dest = to.join(p.file_name().unwrap());
                if p.is_dir() {
                    copy_dir(&p, &dest);
                } else {
                    fs::copy(&p, &dest).unwrap();
                }
            }
        }
        copy_dir(root, copy.path());
        let patch_file = copy.path().join("result.patch");
        fs::write(&patch_file, patch).unwrap();
        git(copy.path(), &["am", patch_file.to_str().unwrap()]);
        assert_eq!(
            fs::read(copy.path().join("entry.md")).unwrap(),
            b"accepted\n"
        );
        assert_eq!(
            git(copy.path(), &["show", "-s", "--format=%an"]).trim(),
            "Visitor (guest, unverified)"
        );
    }

    #[test]
    fn rejects_unsafe_paths_symlinks_gitlinks_and_directory_replacement() {
        if !available() {
            return;
        }
        let dir = fixture();
        let root = dir.path();
        let repo = context(root);
        for path in ["../entry.md", ".git/config", "/entry.md", "a//b.md"] {
            assert!(unchanged(root, || build_commit(
                &repo,
                &repo.head,
                &files(path, b"bad"),
                "bad",
                None
            ))
            .is_err());
            assert!(unchanged(root, || read_blobs(&repo, &repo.head, &[path.into()])).is_err());
        }
        fs::create_dir(root.join("folder")).unwrap();
        fs::write(root.join("folder/a.md"), b"x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("entry.md", root.join("link.md")).unwrap();
        git(root, &["add", "."]);
        git(
            root,
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("160000,{},submodule", repo.head),
            ],
        );
        git(root, &["commit", "-qm", "special entries"]);
        let repo = context(root);
        for path in ["folder", "submodule", "submodule/new.md"] {
            assert!(unchanged(root, || build_commit(
                &repo,
                &repo.head,
                &files(path, b"bad"),
                "bad",
                None
            ))
            .is_err());
        }
        #[cfg(unix)]
        {
            assert!(unchanged(root, || build_commit(
                &repo,
                &repo.head,
                &files("link.md", b"bad"),
                "bad",
                None
            ))
            .is_err());
            assert!(
                unchanged(root, || read_blobs(&repo, &repo.head, &["link.md".into()])).is_err()
            );
        }
    }

    #[test]
    fn g11_clean_eol_matches_git_add_and_temp_index_is_removed_on_failure() {
        if !available() {
            return;
        }
        let dir = fixture();
        let root = dir.path();
        git(root, &["config", "core.autocrlf", "true"]);
        fs::write(
            root.join(".gitattributes"),
            "entry.md text eol=lf\nfiltered.md filter=upper\n",
        )
        .unwrap();
        git(root, &["config", "filter.upper.clean", "tr a-z A-Z"]);
        git(root, &["config", "filter.upper.required", "true"]);
        git(root, &["add", ".gitattributes"]);
        git(root, &["commit", "-qm", "attributes"]);
        let repo = context(root);
        let inputs = BTreeMap::from([
            ("entry.md".into(), b"first\r\nsecond\r\n".to_vec()),
            ("filtered.md".into(), b"lowercase\n".to_vec()),
            ("auto.md".into(), b"auto\r\n".to_vec()),
        ]);
        let oid = unchanged_with_index(root, || {
            build_commit(&repo, &repo.head, &inputs, "filters\n", None)
        })
        .unwrap();
        for (path, bytes) in &inputs {
            fs::write(root.join(path), bytes).unwrap();
            git(root, &["add", "--", path]);
            assert_eq!(
                git(root, &["rev-parse", &format!("{oid}:{path}")]),
                git(root, &["rev-parse", &format!(":{path}")])
            );
        }
        #[cfg(unix)]
        {
            git(root, &["config", "filter.upper.clean", "cat"]);
            unchanged_with_index(root, || {
                build_commit(
                    &repo,
                    &repo.head,
                    &files("filtered.md", b"ok\n"),
                    "ok",
                    None,
                )
            })
            .unwrap();
            git(root, &["config", "filter.upper.clean", "exit 1"]);
            assert!(unchanged_with_index(root, || build_commit(
                &repo,
                &repo.head,
                &files("filtered.md", b"fail\n"),
                "fail",
                None
            ))
            .is_err());
            // unchanged checks this thread's actual temporary-index directories (including
            // index/lock files), without counting concurrent Store operations as leaks.
        }
    }
    #[test]
    fn symbolic_hidden_ref_cleanup_never_deletes_user_branch() {
        if !available() {
            return;
        }
        let dir = fixture();
        let root = dir.path();
        let repo = context(root);
        let branch = git(root, &["symbolic-ref", "HEAD"]);
        git(
            root,
            &[
                "symbolic-ref",
                "refs/notemd/share/p/snapshots/alias",
                branch.trim(),
            ],
        );
        unchanged(root, || delete_project_refs(&repo, "p")).unwrap();
        assert_eq!(git(root, &["rev-parse", "HEAD"]).trim(), repo.head);
        assert!(git_ops::run_git(
            root,
            &["symbolic-ref", "refs/notemd/share/p/snapshots/alias"]
        )
        .is_err());
    }

    #[test]
    fn sha256_create_only_refs_use_repository_oid_width() {
        if !available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        if git_ops::run_git(root, &["init", "--object-format=sha256", "-q"]).is_err() {
            eprintln!("SKIP sha256 refs: Git does not support SHA-256 repositories");
            return;
        }
        git(root, &["config", "user.name", "Owner"]);
        git(root, &["config", "user.email", "owner@example.test"]);
        fs::write(root.join("entry.md"), b"base\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "initial"]);
        let repo = context(root);
        assert_eq!(repo.head.len(), 64);
        let oid = unchanged(root, || {
            build_commit(
                &repo,
                &repo.head,
                &files("entry.md", b"next\n"),
                "next",
                None,
            )
        })
        .unwrap();
        unchanged(root, || {
            create_ref(&repo, "refs/notemd/share/p/snapshots/s", &oid)
        })
        .unwrap();
        unchanged(root, || {
            create_ref(&repo, "refs/notemd/share/p/snapshots/s", &oid)
        })
        .unwrap();
        assert!(unchanged(root, || create_ref(
            &repo,
            "refs/notemd/share/p/snapshots/s",
            &repo.head
        ))
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn g7_unix_literal_backslash_prefix_never_targets_another_project() {
        if !available() {
            return;
        }
        let dir = fixture();
        let root = dir.path();
        let actual = root.join(r"team\docs");
        let other = root.join("team/docs");
        fs::create_dir_all(&actual).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(actual.join("entry.md"), b"actual project\n").unwrap();
        fs::write(other.join("entry.md"), b"other project\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "distinct project directories"]);

        let repo = unchanged(root, || probe(&actual)).unwrap().unwrap();
        assert_eq!(repo.prefix, "team\\docs/");
        let original =
            unchanged(root, || read_blobs(&repo, &repo.head, &["entry.md".into()])).unwrap();
        assert_eq!(original["entry.md"], b"actual project\n");
        let oid = unchanged(root, || {
            build_commit(
                &repo,
                &repo.head,
                &files("entry.md", b"guest result\n"),
                "review\n",
                None,
            )
        })
        .unwrap();
        let updated = unchanged(root, || read_blobs(&repo, &oid, &["entry.md".into()])).unwrap();
        assert_eq!(updated["entry.md"], b"guest result\n");
        assert_eq!(
            git(
                root,
                &["cat-file", "blob", &format!("{oid}:team\\docs/entry.md")]
            ),
            "guest result\n"
        );
        assert_eq!(
            git(
                root,
                &["cat-file", "blob", &format!("{oid}:team/docs/entry.md")]
            ),
            "other project\n"
        );
    }
}
