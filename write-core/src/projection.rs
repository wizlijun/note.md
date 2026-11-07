//! A file pair is a recoverable projection, never a two-file atomic transaction.
use crate::{Error, Result};
use crate::storage::{FilePair, sha256};
use serde::{Deserialize, Serialize};
use std::{fs::{self, OpenOptions}, io::Write, path::{Path, PathBuf}};
use uuid::Uuid;

fn io(error: std::io::Error) -> Error { Error::Invalid(format!("projection: {error}")) }
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Baseline { pub markdown_sha256: Option<String>, pub metadata_sha256: Option<String> }
fn read_hash(path:&Path) -> Result<Option<String>> {
    match fs::symlink_metadata(path) {
        Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => Err(Error::Invalid("projection target is not a regular file".into())),
        Ok(_) => fs::read(path).map(|bytes|Some(sha256(&bytes))).map_err(io),
        Err(error) if error.kind()==std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io(error)),
    }
}
pub fn paths(vault:&Path, filename:&str) -> Result<(PathBuf,PathBuf)> {
    if !filename.ends_with(".writing.md") || filename.contains(['/', '\\', '\0']) || filename.starts_with('.') {
        return Err(Error::Invalid("invalid writing filename".into()));
    }
    let mut dir=fs::canonicalize(vault).map_err(io)?;
    for name in ["inbox","writings"] {
        dir.push(name);
        match fs::symlink_metadata(&dir) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => return Err(Error::Invalid("writing directory must not be a symlink".into())),
            Ok(_) => {},
            Err(error) if error.kind()==std::io::ErrorKind::NotFound => fs::create_dir(&dir).map_err(io)?,
            Err(error) => return Err(io(error)),
        }
    }
    Ok((dir.join(filename),dir.join(format!("{}.meta.json",filename.strip_suffix(".md").unwrap()))))
}
fn replace(path:&Path, bytes:&[u8]) -> Result<()> {
    let temporary=path.with_file_name(format!(".sumi-{}.tmp",Uuid::new_v4()));
    let result=(|| {
        let mut output=OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(io)?;
        output.write_all(bytes).map_err(io)?; output.sync_all().map_err(io)?;
        fs::rename(&temporary,path).map_err(io)?;
        #[cfg(unix)] fs::File::open(path.parent().unwrap()).and_then(|dir|dir.sync_all()).map_err(io)?;
        Ok(())
    })();
    if temporary.exists() { let _=fs::remove_file(&temporary); }
    result
}
/// Accept only the prior published bytes or this exact pending projection.
/// The latter is essential when recovering after writing only one of the files.
/// External processes that ignore file coordination still have a TOCTOU window;
/// callers must retain recovery state and must not advertise arbitrary-writer CAS.
pub fn publish(vault:&Path, filename:&str, pair:&FilePair, baseline:&Baseline) -> Result<Baseline> {
    let (markdown,metadata)=paths(vault,filename)?;
    let next=Baseline { markdown_sha256:Some(sha256(pair.markdown.as_bytes())), metadata_sha256:Some(sha256(pair.metadata.as_bytes())) };
    let current_md=read_hash(&markdown)?; let current_meta=read_hash(&metadata)?;
    if (current_md!=baseline.markdown_sha256 && current_md!=next.markdown_sha256)
        || (current_meta!=baseline.metadata_sha256 && current_meta!=next.metadata_sha256) {
        return Err(Error::Invalid("external projection change; preserve and import before writing".into()));
    }
    if current_md!=next.markdown_sha256 { replace(&markdown,pair.markdown.as_bytes())?; }
    // A watcher or external tool can run while the first file is being replaced.
    if read_hash(&metadata)?!=current_meta { return Err(Error::Invalid("external metadata change during projection".into())); }
    if current_meta!=next.metadata_sha256 { replace(&metadata,pair.metadata.as_bytes())?; }
    if read_hash(&markdown)?!=next.markdown_sha256 || read_hash(&metadata)?!=next.metadata_sha256 {
        return Err(Error::Invalid("projection changed before verification".into()));
    }
    Ok(next)
}
