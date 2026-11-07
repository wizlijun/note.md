//! Sumi's platform-independent text and durability core.
//! The Markdown body is a Y.Text; timing is an immutable event set in the same document.
pub mod document;
pub use document::*;

pub mod storage;

pub mod render;

pub mod catalog;
pub mod projection;

pub mod import;

/// Merge a complete transport journal without requiring each partial update to
/// contain page identity. Validate the resulting state through Document::load/apply_remote.
pub fn merge_wire_updates(updates: &[Vec<u8>]) -> Result<Vec<u8>> {
    yrs::merge_updates_v1(updates.iter().map(Vec::as_slice))
        .map_err(|e| Error::Invalid(e.to_string()))
}
