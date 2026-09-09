//! Declarative, read-only file views. The host owns document I/O and fallback.
use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};

use crate::ManifestV2;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FileViewContribution {
    pub id: String,
    pub entry: String,
    /// Host-handled menu command that opens this view for the active file.
    /// ASCII [a-z0-9][a-z0-9._-]*, at most 128 characters; no process activation.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_value"
    )]
    #[schemars(
        with = "String",
        length(min = 1, max = 128),
        regex(pattern = "^[a-z0-9][a-z0-9._-]*$")
    )]
    pub open_command: Option<String>,
    #[serde(default, deserialize_with = "view_priority")]
    #[schemars(range(min = -1000, max = 1000))]
    pub priority: i32,
    #[schemars(length(min = 1, max = 32))]
    pub selectors: Vec<FileViewSelector>,
}

/// Selectors are ORed; fields within one selector are ANDed. Each value list
/// is ORed; distinct frontmatter keys are ANDed.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FileViewSelector {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_value"
    )]
    #[schemars(with = "Vec<String>", length(min = 1, max = 32))]
    pub file_extensions: Option<Vec<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_value"
    )]
    #[schemars(with = "Vec<String>", length(min = 1, max = 32))]
    pub file_name_patterns: Option<Vec<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_value"
    )]
    #[schemars(with = "Vec<String>", length(min = 1, max = 32))]
    pub path_patterns: Option<Vec<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_value"
    )]
    #[schemars(with = "BTreeMap<String, Vec<FileViewScalar>>")]
    pub frontmatter: Option<BTreeMap<String, Vec<FileViewScalar>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum FileViewScalar {
    String(String),
    Number(f64),
    Boolean(bool),
}

// Omitted fields are optional; an explicitly null condition is invalid.
fn present_value<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

fn view_priority<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i32, D::Error> {
    let value = f64::deserialize(deserializer)?;
    if value.fract() != 0.0 || !(-1000.0..=1000.0).contains(&value) {
        return Err(serde::de::Error::custom(
            "file view priority must be an integer between -1000 and 1000",
        ));
    }
    Ok(value as i32)
}

fn nonempty(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= max && !value.contains('\0')
}

fn strings_valid(values: &[String], predicate: impl Fn(&str) -> bool) -> bool {
    !values.is_empty()
        && values.len() <= 32
        && values
            .iter()
            .all(|value| nonempty(value, 256) && predicate(value))
}

pub fn validate_file_views(manifest: &ManifestV2) -> Result<(), String> {
    let views = &manifest.contributes.file_views;
    if views.is_empty() {
        return Ok(());
    }
    if manifest
        .ui
        .as_deref()
        .map_or(true, |value| value.trim().is_empty())
    {
        return Err("contributes.file_views requires ui".into());
    }
    if views.len() > 32 {
        return Err("contributes.file_views supports at most 32 views".into());
    }
    let mut ids = BTreeSet::new();
    let mut open_commands: BTreeSet<&str> = manifest
        .contributes
        .windows
        .iter()
        .filter_map(|window| window.open_command.as_deref())
        .collect();
    for view in views {
        let error = || {
            format!(
                "file view '{}': invalid declaration or empty selector",
                view.id
            )
        };
        if !nonempty(&view.id, 128)
            || !view
                .id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            || !ids.insert(&view.id)
            || !(-1000..=1000).contains(&view.priority)
        {
            return Err(error());
        }
        if let Some(command) = &view.open_command {
            if !nonempty(command, 128)
                || !command
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                || !command.chars().all(|c| {
                    c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-')
                })
            {
                return Err(format!(
                    "file view '{}': open_command must match [a-z0-9][a-z0-9._-]* (1-128 characters)",
                    view.id
                ));
            }
            if !open_commands.insert(command) {
                return Err(format!(
                    "file view '{}': open_command '{}' is already used by another view or window",
                    view.id, command
                ));
            }
        }
        if !nonempty(&view.entry, 256)
            || !view.entry.ends_with(".html")
            || view.entry.contains(['\\', '%', ':', '?', '#'])
            || view
                .entry
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(format!(
                "file view '{}': entry must be a relative HTML path",
                view.id
            ));
        }
        if view.selectors.is_empty() || view.selectors.len() > 32 {
            return Err(error());
        }
        for selector in &view.selectors {
            if selector.file_extensions.is_none()
                && selector.file_name_patterns.is_none()
                && selector.path_patterns.is_none()
                && selector.frontmatter.is_none()
            {
                return Err(error());
            }
            if let Some(values) = &selector.file_extensions {
                if !strings_valid(values, |value| {
                    let value = value.trim().trim_start_matches('.');
                    value
                        .chars()
                        .next()
                        .map_or(false, |c| c.is_ascii_alphanumeric())
                        && value
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                }) {
                    return Err(error());
                }
            }
            if let Some(values) = &selector.file_name_patterns {
                if !strings_valid(values, |value| !value.contains(['/', '\\'])) {
                    return Err(error());
                }
            }
            if let Some(values) = &selector.path_patterns {
                if !strings_valid(values, |value| !value.contains('\\')) {
                    return Err(error());
                }
            }
            if let Some(properties) = &selector.frontmatter {
                if properties.is_empty() || properties.len() > 32 {
                    return Err(error());
                }
                for (key, values) in properties {
                    if !nonempty(key, 128) || values.is_empty() || values.len() > 32 {
                        return Err(error());
                    }
                    for value in values {
                        if match value {
                            FileViewScalar::String(value) => !nonempty(value, 256),
                            FileViewScalar::Number(value) => !value.is_finite(),
                            FileViewScalar::Boolean(_) => false,
                        } {
                            return Err(error());
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn manifest(views: Value) -> Value {
        json!({
            "manifest_version": 2, "id": "notemd.example", "name": "Example", "version": "1.0.0",
            "kind": "native", "engines": { "notemd": ">=6.909.1" }, "ui": "ui/",
            "activation": { "events": [] }, "contributes": { "file_views": views }, "capabilities": []
        })
    }

    fn valid(raw: Value) -> bool {
        serde_json::from_value::<ManifestV2>(raw)
            .is_ok_and(|m| crate::validate_manifest(&m, "6.909.1").is_ok())
    }

    #[test]
    fn file_view_validation_matches_shared_frontend_vectors() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../protocol/fixtures/file-view-validation.json"
        ))
        .unwrap();
        for case in cases {
            assert_eq!(
                valid(manifest(json!([case["view"]]))),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn file_views_require_ui_unique_ids_and_bounded_registry() {
        let view = json!({"id":"report", "entry":"index.html", "selectors":[{"file_extensions":["json"]}]});
        let mut raw = manifest(json!([view.clone()]));
        raw.as_object_mut().unwrap().remove("ui");
        raw["binary"] = json!({"aarch64-apple-darwin":"bin/plugin"});
        assert!(!valid(raw));
        assert!(!valid(manifest(json!([view.clone(), view.clone()]))));
        assert!(!valid(manifest(Value::Array(
            (0..33)
                .map(|i| {
                    let mut value = view.clone();
                    value["id"] = json!(format!("view-{i}"));
                    value
                })
                .collect()
        ))));
        assert!(valid(manifest(json!([]))));
    }

    #[test]
    fn file_view_commands_need_no_menu_or_activation_but_must_be_unambiguous() {
        let view = json!({"id":"report", "entry":"index.html", "open_command":"open-report", "selectors":[{"file_extensions":["json"]}]});
        // A host-handled menu command does not require a process or activation event.
        assert!(valid(manifest(json!([view.clone()]))));
        let mut second = view.clone();
        second["id"] = json!("other");
        assert!(!valid(manifest(json!([view.clone(), second.clone()]))));
        second["open_command"] = json!("open-other");
        assert!(valid(manifest(json!([view.clone(), second]))));

        let mut raw = manifest(json!([view]));
        raw["contributes"]["windows"] = json!([{
            "id":"settings", "entry":"settings.html", "width":500, "height":400,
            "open_command":"open-report"
        }]);
        assert!(!valid(raw.clone()));
        raw["contributes"]["windows"][0]["open_command"] = json!("settings");
        assert!(valid(raw));
    }

    #[test]
    fn file_view_command_schema_enforces_type_and_bounds() {
        let schema = serde_json::to_value(schemars::schema_for!(crate::ManifestV2)).unwrap();
        let validator = jsonschema::JSONSchema::compile(&schema).unwrap();
        let mut raw = manifest(
            json!([{"id":"report", "entry":"index.html", "selectors":[{"file_extensions":["json"]}]}]),
        );
        assert!(validator.is_valid(&raw));
        for command in [json!("open-report"), json!("a".repeat(128))] {
            raw["contributes"]["file_views"][0]["open_command"] = command;
            assert!(validator.is_valid(&raw));
        }
        for command in [
            Value::Null,
            json!(1),
            json!(""),
            json!("Open"),
            json!("open report"),
            json!("open\n"),
            json!("a".repeat(129)),
        ] {
            raw["contributes"]["file_views"][0]["open_command"] = command.clone();
            assert!(
                !validator.is_valid(&raw),
                "schema accepted invalid command {command}"
            );
        }
    }

    #[test]
    fn file_view_generated_schema_is_typed_and_rejects_null_conditions() {
        let schema = serde_json::to_value(schemars::schema_for!(crate::ManifestV2)).unwrap();
        let validator = jsonschema::JSONSchema::compile(&schema).unwrap();
        let good = manifest(
            json!([{"id":"timeline", "entry":"index.html", "selectors":[{"frontmatter":{"type":["timeline"]}}]}]),
        );
        assert!(validator.is_valid(&good));
        let mut bad = good;
        bad["contributes"]["file_views"][0]["selectors"][0]["file_extensions"] = Value::Null;
        assert!(!validator.is_valid(&bad));
    }

    #[test]
    fn file_view_serialization_keeps_optional_conditions_absent() {
        let raw = manifest(
            json!([{"id":"report", "entry":"index.html", "selectors":[{"file_extensions":["json"]}]}]),
        );
        let m: ManifestV2 = serde_json::from_value(raw).unwrap();
        let serialized = serde_json::to_value(&m.contributes.file_views[0]).unwrap();
        assert!(serialized["selectors"][0].get("frontmatter").is_none());
        assert!(serialized.get("open_command").is_none());
        assert_eq!(serialized["priority"], json!(0));
    }

    #[test]
    fn file_view_command_survives_serialization() {
        let raw = manifest(
            json!([{"id":"report", "entry":"index.html", "open_command":"open-report", "selectors":[{"file_extensions":["json"]}]}]),
        );
        let m: ManifestV2 = serde_json::from_value(raw).unwrap();
        assert_eq!(
            m.contributes.file_views[0].open_command.as_deref(),
            Some("open-report")
        );
        let serialized = serde_json::to_value(&m.contributes.file_views[0]).unwrap();
        assert_eq!(serialized["open_command"], json!("open-report"));
    }
}
