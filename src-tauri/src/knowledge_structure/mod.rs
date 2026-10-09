//! Validated knowledge snapshots. The single Vault file is authoritative;
//! runtime state only journals a save interrupted between rename and commit.

pub mod history;
pub mod store;

pub use history::{history, read_at};
pub use store::{discard_pending, load, recover, save};

pub const TEMP_PREFIX: &str = ".knowledge-structure-";
pub const TEMP_EXCLUDE_PATHSPEC: &str = ":(exclude,glob).notemd/habitat/.knowledge-structure-*.tmp";

pub(crate) use history::{guard_before_sync_commit, guard_before_sync_merge, resolve_sync_merge};
