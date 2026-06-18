//! Sync-to-Vault: copy the current file into the git-synced Vault and keep a
//! record mapping each vault copy back to its source for conflict-aware refresh.

pub mod logic;
pub mod store;
