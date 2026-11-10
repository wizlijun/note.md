//! Optional model-assisted enhancements to smart lookup: shared types here,
//! pure routing/selection/rerank functions in [`candidates`].
#![allow(dead_code)]

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::smart_model::{AuthMode, ModelError};

pub(crate) mod candidates;

pub(crate) const ENHANCE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EnhanceStatus {
    Ok,
    Skipped,
    NotConfigured,
    NoConsent,
    Timeout,
    KeyInvalid,
    Unreachable,
    Invalid,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
    ZeroHits,
    Pinned,
    FewTerms,
    Repaired,
    NoCandidates,
    AutoBudgetUsed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Missing {
    Url,
    Model,
    Key,
    Insecure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Trigger {
    Auto,
    User,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Tier {
    Fit,
    Unsure,
    Unfit,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JevRequestConfig {
    pub url: String,
    pub model: String,
    pub auth_mode: AuthMode,
    pub consent_host: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatRequestConfig {
    pub url: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDto {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// Map a model error to a status and a coarse status class. Never carries
/// error detail (it may contain secrets).
pub(crate) fn status_for(error: &ModelError) -> (EnhanceStatus, Option<String>) {
    match error {
        ModelError::Timeout => (EnhanceStatus::Timeout, None),
        ModelError::Http(401) | ModelError::Http(403) => {
            (EnhanceStatus::KeyInvalid, Some("4xx".to_string()))
        }
        ModelError::Http(n) => (EnhanceStatus::Unreachable, Some(format!("{}xx", n / 100))),
        ModelError::Transport(_) => (EnhanceStatus::Unreachable, None),
        ModelError::Invalid(_) => (EnhanceStatus::Invalid, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_errors_map_to_statuses_without_detail() {
        assert_eq!(status_for(&ModelError::Http(401)), (EnhanceStatus::KeyInvalid, Some("4xx".into())));
        assert_eq!(status_for(&ModelError::Http(403)), (EnhanceStatus::KeyInvalid, Some("4xx".into())));
        assert_eq!(status_for(&ModelError::Http(429)), (EnhanceStatus::Unreachable, Some("4xx".into())));
        assert_eq!(status_for(&ModelError::Http(502)), (EnhanceStatus::Unreachable, Some("5xx".into())));
        assert_eq!(status_for(&ModelError::Transport("dns sk-secret".into())), (EnhanceStatus::Unreachable, None));
        assert_eq!(status_for(&ModelError::Timeout), (EnhanceStatus::Timeout, None));
        assert_eq!(status_for(&ModelError::Invalid("x".into())), (EnhanceStatus::Invalid, None));
    }
}
