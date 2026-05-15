use std::path::Path;
use git2::{
    Repository, FetchOptions, PushOptions, RemoteCallbacks, Cred,
    IndexAddOption, build::CheckoutBuilder,
};

use super::{VaultError, VaultIosManager, conflict, sig::{author_sig, timestamp_compact}};

#[derive(Debug)]
pub enum SyncOutcome {
    PullOnly,
    NoOp,
    Pushed { conflicts: Vec<String> },
}

fn make_credentials_cb<'a>(pat: &'a str) -> RemoteCallbacks<'a> {
    let pat_owned = pat.to_string();
    let mut cb = RemoteCallbacks::new();
    cb.credentials(move |_url, _user, _allowed| {
        Cred::userpass_plaintext("x-access-token", &pat_owned)
    });
    cb
}

fn has_workdir_changes(repo: &Repository) -> Result<bool, VaultError> {
    let statuses = repo.statuses(None)?;
    Ok(!statuses.is_empty())
}

fn fast_forward(repo: &Repository, branch: &str) -> Result<(), VaultError> {
    let refname = format!("refs/remotes/origin/{branch}");
    let remote_oid = repo.refname_to_id(&refname)?;
    let mut local_ref = repo.find_reference(&format!("refs/heads/{branch}"))?;
    local_ref.set_target(remote_oid, "vault: ff")?;
    repo.set_head(&format!("refs/heads/{branch}"))?;
    let mut co = CheckoutBuilder::new();
    co.force();
    repo.checkout_head(Some(&mut co))?;
    Ok(())
}

pub fn sync_once(
    mgr: &VaultIosManager,
    vault_dir: &Path,
    branch: &str,
    _remote_url_for_logging: &str,
    pat: &str,
) -> Result<SyncOutcome, VaultError> {
    let repo = Repository::open(vault_dir)?;
    let mut conflicts_log = Vec::<String>::new();

    // 1. fetch
    {
        let mut fo = FetchOptions::new();
        fo.remote_callbacks(make_credentials_cb(pat));
        repo.find_remote("origin")?.fetch(&[branch], Some(&mut fo), None)?;
    }

    let dirty = has_workdir_changes(&repo)?;

    if !dirty {
        let local_oid = repo.refname_to_id(&format!("refs/heads/{branch}"))?;
        let remote_oid = repo.refname_to_id(&format!("refs/remotes/origin/{branch}"))?;
        if local_oid == remote_oid {
            return Ok(SyncOutcome::NoOp);
        }
        let merge_base = repo.merge_base(local_oid, remote_oid).ok();
        if merge_base == Some(local_oid) {
            fast_forward(&repo, branch)?;
            return Ok(SyncOutcome::PullOnly);
        }
        // Divergence with no local changes — pragmatic: reset --hard origin/branch.
        let target = repo.find_object(remote_oid, None)?;
        repo.reset(&target, git2::ResetType::Hard, None)?;
        return Ok(SyncOutcome::PullOnly);
    }

    // 2. Dirty path: stash → rebase → pop → handle conflicts → commit → push.
    let sig = author_sig(mgr)?;
    let mut repo_mut = Repository::open(vault_dir)?;
    let _stash_oid = repo_mut.stash_save(&sig, "vault-auto", None)?;

    let remote_oid = repo.refname_to_id(&format!("refs/remotes/origin/{branch}"))?;
    let onto = repo.find_annotated_commit(remote_oid)?;
    let head = repo.head()?.peel_to_commit()?;
    let upstream = repo.find_annotated_commit(head.id())?;

    let mut rebase = match repo.rebase(Some(&upstream), Some(&onto), Some(&onto), None) {
        Ok(r) => r,
        Err(_) => {
            let _ = repo_mut.stash_pop(0, None);
            return Err(VaultError::RebaseFailed);
        }
    };

    while let Some(op) = rebase.next() {
        op.map_err(VaultError::from)?;
        rebase.commit(None, &sig, None).map_err(VaultError::from)?;
    }
    rebase.finish(Some(&sig)).map_err(VaultError::from)?;

    // libgit2's rebase leaves HEAD detached even when 0 ops ran. Point HEAD
    // back at the branch ref and fast-forward the branch to the post-rebase
    // tip so subsequent commits attach to the branch (not a detached HEAD).
    let branch_ref = format!("refs/heads/{branch}");
    let head_oid_after_rebase = repo
        .head()?
        .target()
        .unwrap_or_else(|| repo.refname_to_id(&branch_ref).unwrap());
    if let Ok(mut br) = repo.find_reference(&branch_ref) {
        br.set_target(head_oid_after_rebase, "vault: rebase result")?;
    }
    repo.set_head(&branch_ref)?;

    // 3. Pop stash; on conflict, run conflict::handle.
    let pop_result = repo_mut.stash_pop(0, None);
    if let Err(e) = pop_result {
        if e.code() == git2::ErrorCode::Conflict || e.message().contains("conflict") {
            conflict::handle(&repo, &mut conflicts_log)?;
            *mgr.has_conflicts.lock().unwrap() = !conflicts_log.is_empty();
        } else {
            return Err(VaultError::from(e));
        }
    }

    // 4. add -A + commit.
    let mut index = repo.index()?;
    index.add_all(["."].iter(), IndexAddOption::DEFAULT, None)?;
    index.write()?;

    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;
    let parent = repo.head()?.peel_to_commit()?;
    let parent_tree = parent.tree()?;
    if tree.id() != parent_tree.id() {
        let msg = format!("vault: auto-sync {}", timestamp_compact());
        repo.commit(Some("HEAD"), &sig, &sig, &msg, &tree, &[&parent])?;
    }

    // 5. push.
    {
        let mut po = PushOptions::new();
        po.remote_callbacks(make_credentials_cb(pat));
        let refspec = format!("refs/heads/{0}:refs/heads/{0}", branch);
        repo.find_remote("origin")?.push(&[&refspec], Some(&mut po))?;
    }

    Ok(SyncOutcome::Pushed { conflicts: conflicts_log })
}
