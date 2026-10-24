//! Vault-relative archive paths. Existing manifests keep their original layout.
use std::path::PathBuf;

#[derive(Clone, Copy)]
pub(crate) enum Layout {
    Daily,
    Legacy,
}

impl Layout {
    pub(crate) fn root(self) -> PathBuf {
        match self {
            Self::Daily => PathBuf::from("ssot/health"),
            Self::Legacy => PathBuf::from("health"),
        }
    }

    pub(crate) fn day(self, day: &str) -> PathBuf {
        match self {
            Self::Daily if day == "_undated" => self.root().join(day),
            Self::Daily => self.root().join(&day[..4]).join(day),
            Self::Legacy => self.root().join("data").join(day),
        }
    }

    pub(crate) fn summary(self, day: &str) -> PathBuf {
        let directory = match self {
            Self::Daily => self.day(day),
            Self::Legacy => self.root().join("daily"),
        };
        directory.join(format!("{day}-health.md"))
    }

    pub(crate) fn attachments(self, day: &str) -> PathBuf {
        match self {
            Self::Daily => self.day(day).join("attachments"),
            Self::Legacy => self.root().join("attachments").join(day),
        }
    }

    pub(crate) fn shard_link(self, day: &str, filename: &str) -> String {
        match self {
            Self::Daily => filename.into(),
            Self::Legacy => format!("../data/{day}/{filename}"),
        }
    }
}
