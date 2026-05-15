use std::path::Path;
use git2::{build::RepoBuilder, FetchOptions, RemoteCallbacks, Cred, Progress};

use super::VaultError;

pub struct CloneProgress {
    pub stage: String,
    pub received_objects: usize,
    pub total_objects: usize,
    pub bytes: usize,
}

pub fn clone_repo<P: Fn(CloneProgress)>(
    remote_url: &str,
    branch: &str,
    pat: &str,
    dest: &Path,
    on_progress: P,
) -> Result<(), VaultError> {
    if dest.exists() {
        std::fs::remove_dir_all(dest)?;
    }

    let pat_owned = pat.to_string();
    let mut cb = RemoteCallbacks::new();
    cb.credentials(move |_url, _username_from_url, _allowed| {
        Cred::userpass_plaintext("x-access-token", &pat_owned)
    });
    cb.transfer_progress(|stats: Progress| {
        on_progress(CloneProgress {
            stage: "receiving".into(),
            received_objects: stats.received_objects(),
            total_objects: stats.total_objects(),
            bytes: stats.received_bytes(),
        });
        true
    });

    let mut fo = FetchOptions::new();
    fo.remote_callbacks(cb);

    let mut builder = RepoBuilder::new();
    builder.fetch_options(fo);
    builder.branch(branch);

    builder.clone(remote_url, dest).map_err(VaultError::from)?;
    Ok(())
}
