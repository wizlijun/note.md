//! Attachment destinations are relative to the independently selected library.
use std::path::PathBuf;
#[derive(Clone, Copy)]
pub(crate) struct Layout;
impl Layout {
    pub(crate) fn attachments(self, day: &str) -> PathBuf {
        PathBuf::from("attachments").join(day)
    }
}
