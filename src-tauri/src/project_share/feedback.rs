//! Versioned submission wire format. Normalize only when reading annotations.
use super::{valid_id, Annotation, Edit, ProjectFeedbackV1};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashSet;

type Result<T> = std::result::Result<T, String>;
const MAX_SAFE_OFFSET: usize = 9_007_199_254_740_991;

// Missing optional fields are allowed; explicit null is not a v2 value.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> std::result::Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}
// JSON 6, 6.0 and -0 have the same integer meaning in the browser contract.
fn present_offset<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Option<usize>, D::Error> {
    let number = serde_json::Number::deserialize(d)?;
    let value = number
        .as_f64()
        .ok_or_else(|| serde::de::Error::custom("invalid selector offset"))?;
    if value < 0.0 || value > MAX_SAFE_OFFSET as f64 || value.fract() != 0.0 {
        return Err(serde::de::Error::custom("unsafe selector offset"));
    }
    Ok(Some(value as usize))
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectFeedbackV2 {
    pub schema_version: u32,
    #[serde(rename = "project_id")]
    pub project_id: String,
    pub snapshot_id: String,
    pub submission_id: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub supersedes: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub rebased_from: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub message: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub contributor: Option<ProjectContributor>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub client: Option<ProjectClient>,
    #[serde(deserialize_with = "strict_edits")]
    pub edits: Vec<Edit>,
    pub annotations: Vec<ProjectAnnotationV2>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectContributor {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub name: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub ai_assisted: Option<bool>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectClient {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub kind: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub version: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectAnnotationV2 {
    pub path: String,
    pub selector: FeedbackSelector,
    pub comment: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub kind: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FeedbackSelector {
    pub exact: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub prefix: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub suffix: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_offset"
    )]
    pub start: Option<usize>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_offset"
    )]
    pub end: Option<usize>,
}
#[derive(Debug, Clone)]
pub struct NormalizedAnnotation {
    pub path: String,
    pub selector: FeedbackSelector,
    pub comment: String,
    pub kind: String,
}

// Only v2 edits deny unknown keys; historical v1 edits remain permissive.
fn strict_edits<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Vec<Edit>, D::Error> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct StrictEdit {
        path: String,
        base_hash: String,
        after_markdown: String,
    }
    Vec::<StrictEdit>::deserialize(d).map(|edits| {
        edits
            .into_iter()
            .map(|e| Edit {
                path: e.path,
                base_hash: e.base_hash,
                after_markdown: e.after_markdown,
            })
            .collect()
    })
}
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum ProjectFeedbackPayload {
    V1(ProjectFeedbackV1),
    V2(ProjectFeedbackV2),
}
impl<'de> Deserialize<'de> for ProjectFeedbackPayload {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let mut value = serde_json::Value::deserialize(d)?;
        match value.get("schemaVersion").and_then(|v| v.as_f64()) {
            Some(1.0) => serde_json::from_value(value)
                .map(Self::V1)
                .map_err(serde::de::Error::custom),
            Some(2.0) => {
                // Serde also accepts structs as positional arrays. The v2 wire
                // protocol requires JSON objects at each nested struct boundary.
                for key in ["contributor", "client"] {
                    if value.get(key).is_some_and(|v| !v.is_object()) {
                        return Err(serde::de::Error::custom("expected feedback object"));
                    }
                }
                for key in ["edits", "annotations"] {
                    if let Some(items) = value.get(key).and_then(|v| v.as_array()) {
                        for item in items {
                            if !item.is_object()
                                || (key == "annotations"
                                    && !item.get("selector").is_some_and(|v| v.is_object()))
                            {
                                return Err(serde::de::Error::custom(
                                    "expected feedback item object",
                                ));
                            }
                        }
                    }
                }
                value["schemaVersion"] = serde_json::json!(2);
                serde_json::from_value(value)
                    .map(Self::V2)
                    .map_err(serde::de::Error::custom)
            }
            _ => Err(serde::de::Error::custom(
                "unsupported feedback schemaVersion",
            )),
        }
    }
}
impl From<ProjectFeedbackV1> for ProjectFeedbackPayload {
    fn from(value: ProjectFeedbackV1) -> Self {
        Self::V1(value)
    }
}
impl ProjectFeedbackPayload {
    pub fn schema_version(&self) -> u32 {
        match self {
            Self::V1(v) => v.schema_version,
            Self::V2(v) => v.schema_version,
        }
    }
    pub fn project_id(&self) -> &str {
        match self {
            Self::V1(v) => &v.project_id,
            Self::V2(v) => &v.project_id,
        }
    }
    pub fn snapshot_id(&self) -> &str {
        match self {
            Self::V1(v) => &v.snapshot_id,
            Self::V2(v) => &v.snapshot_id,
        }
    }
    pub fn submission_id(&self) -> &str {
        match self {
            Self::V1(v) => &v.submission_id,
            Self::V2(v) => &v.submission_id,
        }
    }
    pub fn edits(&self) -> &[Edit] {
        match self {
            Self::V1(v) => &v.edits,
            Self::V2(v) => &v.edits,
        }
    }
    pub fn contributor_name(&self) -> Option<&str> {
        match self {
            Self::V1(v) => v.name.as_deref(),
            Self::V2(v) => v.contributor.as_ref().and_then(|c| c.name.as_deref()),
        }
    }
    pub fn supersedes(&self) -> Option<&str> {
        match self {
            Self::V1(_) => None,
            Self::V2(v) => v.supersedes.as_deref(),
        }
    }
    pub fn annotations_normalized(&self) -> Vec<NormalizedAnnotation> {
        match self {
            Self::V1(v) => v
                .annotations
                .iter()
                .map(|a: &Annotation| NormalizedAnnotation {
                    path: a.path.clone(),
                    comment: a.comment.clone(),
                    kind: "comment".into(),
                    selector: FeedbackSelector {
                        exact: a.quote.clone(),
                        prefix: None,
                        suffix: None,
                        start: a.start,
                        end: a.end,
                    },
                })
                .collect(),
            Self::V2(v) => v
                .annotations
                .iter()
                .map(|a| NormalizedAnnotation {
                    path: a.path.clone(),
                    comment: a.comment.clone(),
                    selector: a.selector.clone(),
                    kind: a.kind.clone().unwrap_or_else(|| "comment".into()),
                })
                .collect(),
        }
    }
    pub fn validate_shape(&self) -> Result<()> {
        let Self::V2(v) = self else {
            return if self.schema_version() == 1 {
                Ok(())
            } else {
                Err("unsupported feedback schemaVersion".into())
            };
        };
        if v.schema_version != 2 {
            return Err("unsupported feedback schemaVersion".into());
        }
        for id in [&v.project_id, &v.snapshot_id, &v.submission_id] {
            valid_id(id)?;
        }
        for (id, own) in [
            (v.supersedes.as_ref(), &v.submission_id),
            (v.rebased_from.as_ref(), &v.snapshot_id),
        ] {
            if let Some(id) = id {
                valid_id(id)?;
                if id == own {
                    return Err("self-referencing feedback".into());
                }
            }
        }
        if v.message
            .as_ref()
            .is_some_and(|s| units(s) > 2000 || s.contains('\0'))
        {
            return Err("invalid message".into());
        }
        if let Some(c) = &v.contributor {
            if c.name
                .as_ref()
                .is_some_and(|s| units(s) > 80 || s.chars().any(char::is_control))
            {
                return Err("invalid contributor name".into());
            }
        }
        if let Some(c) = &v.client {
            if c.kind
                .as_ref()
                .is_some_and(|s| !["browser", "browser-fallback", "notemd"].contains(&s.as_str()))
                || c.version.as_ref().is_some_and(|s| units(s) > 32)
            {
                return Err("invalid client".into());
            }
        }
        if v.edits.len() > 2000 || v.annotations.len() > 2000 {
            return Err("too many feedback items".into());
        }
        let mut seen = HashSet::new();
        for e in &v.edits {
            relative_path(&e.path)?;
            if !seen.insert(&e.path) {
                return Err("duplicate edit".into());
            }
            if e.base_hash.len() != 64
                || !e
                    .base_hash
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            {
                return Err("invalid base hash".into());
            }
        }
        for a in &v.annotations {
            relative_path(&a.path)?;
            if !(1..=10000).contains(&units(&a.comment))
                || a.kind
                    .as_ref()
                    .is_some_and(|s| !["comment", "question", "blocker"].contains(&s.as_str()))
            {
                return Err("invalid annotation".into());
            }
            let s = &a.selector;
            if units(&s.exact) > 2000
                || s.prefix.as_ref().is_some_and(|p| units(p) > 64)
                || s.suffix.as_ref().is_some_and(|p| units(p) > 64)
                || (s.exact.is_empty()
                    && s.prefix.as_deref().unwrap_or("").is_empty()
                    && s.suffix.as_deref().unwrap_or("").is_empty())
            {
                return Err("invalid selector text".into());
            }
            if s.start.is_some_and(|n| n > MAX_SAFE_OFFSET)
                || s.end.is_some_and(|n| n > MAX_SAFE_OFFSET)
            {
                return Err("unsafe selector offset".into());
            }
            if let (Some(start), Some(end)) = (s.start, s.end) {
                if end.checked_sub(start) != Some(units(&s.exact)) {
                    return Err("invalid selector span".into());
                }
            }
        }
        Ok(())
    }
    #[cfg(test)]
    pub(super) fn v1_mut(&mut self) -> &mut ProjectFeedbackV1 {
        match self {
            Self::V1(v) => v,
            Self::V2(_) => panic!("legacy fixture expected"),
        }
    }
}
fn units(text: &str) -> usize {
    text.encode_utf16().count()
}
fn relative_path(path: &str) -> Result<()> {
    if path.is_empty()
        || path.starts_with('/')
        || path.contains(['\\', ':', '\0'])
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err("unsafe relative path".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_feedback_fixtures() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/project-feedback");
        for (group, valid) in [("valid", true), ("invalid", false)] {
            let mut paths: Vec<_> = std::fs::read_dir(root.join(group))
                .unwrap()
                .map(|e| e.unwrap().path())
                .collect();
            paths.sort();
            assert!(!paths.is_empty());
            for path in paths {
                let raw = std::fs::read_to_string(&path).unwrap();
                let result = serde_json::from_str::<ProjectFeedbackPayload>(&raw)
                    .map_err(|e| e.to_string())
                    .and_then(|p| p.validate_shape());
                assert_eq!(result.is_ok(), valid, "{}: {result:?}", path.display());
            }
        }
    }
    #[test]
    fn v1_null_options_and_unknown_keys_remain_readable() {
        let raw = serde_json::json!({"schemaVersion":1,"project_id":"p","snapshotId":"s","submissionId":"v1", "edits":[{"path":"a.md","baseHash":"legacy","afterMarkdown":"x","extra":1}], "annotations":[{"path":"a.md","quote":"","comment":"","start":null,"end":null,"extra":1}], "name":null,"extra":true});
        let payload: ProjectFeedbackPayload = serde_json::from_value(raw).unwrap();
        payload.validate_shape().unwrap();
        assert_eq!(payload.schema_version(), 1);
        assert_eq!(payload.contributor_name(), None);
        let serialized = serde_json::to_value(&payload).unwrap();
        assert!(serialized["name"].is_null());
        assert!(serialized["annotations"][0]["start"].is_null());
        let again: ProjectFeedbackPayload = serde_json::from_value(serialized.clone()).unwrap();
        assert_eq!(serde_json::to_value(again).unwrap(), serialized);
    }
    #[test]
    fn v2_roundtrip_preserves_optional_fields_and_selector_context() {
        let raw: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/project-feedback/valid/v2-all-optional.json"
        ))
        .unwrap();
        let payload: ProjectFeedbackPayload = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(payload.supersedes(), Some("previous"));
        assert_eq!(payload.contributor_name(), Some("Alice"));
        let notes = payload.annotations_normalized();
        assert_eq!(notes[0].selector.prefix.as_deref(), Some("prefix"));
        assert_eq!(notes[0].selector.suffix.as_deref(), Some("suffix"));
        assert_eq!(notes[0].selector.start, Some(0));
        assert_eq!(notes[0].selector.end, Some(6));
        assert_eq!(notes[0].kind, "blocker");
        assert_eq!(notes[0].comment, "补充来源");
        assert_eq!(serde_json::to_value(payload).unwrap(), raw);
    }
}
