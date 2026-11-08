//! Small font identity and service DTOs. Download URLs and licenses belong only
//! to the Sumi plugin catalog, never to the host's shared protocol.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const ALIASES: [&str; 6] = [
    "Sumi Plex",
    "Sumi WenKai",
    "Sumi Zhaohua",
    "Sumi Youcha",
    "Sumi Fangsong",
    "Sumi CRT",
];

pub fn expected_postscript(alias: &str) -> Option<&'static [&'static str]> {
    match alias {
        "Sumi Plex" => Some(&["IBMPlexMono-Light", "IBMPlexSansSC-Light"]),
        "Sumi WenKai" => Some(&["LXGWWenKaiMonoLite-Regular"]),
        "Sumi Zhaohua" => Some(&["ZhaohuaTypeWriter-Light"]),
        "Sumi Youcha" => Some(&["YouchaSanz-Light"]),
        "Sumi Fangsong" => Some(&["ZhuqueFangsong-Regular"]),
        "Sumi CRT" => Some(&["Unifont"]),
        _ => None,
    }
}

pub fn known_font(alias: &str) -> bool {
    expected_postscript(alias).is_some()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FontStatus {
    pub family: String,
    pub status: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FontFile {
    pub path: PathBuf,
    pub postscript: String,
}

/// Host-only service messages. A WebView must not be allowed to send these
/// directly, and neither paths nor URLs are accepted as request arguments.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub enum FontRequest {
    Statuses,
    Files { family: String },
    Download { family: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum FontResponse {
    Statuses { statuses: Vec<FontStatus> },
    Files { files: Option<Vec<FontFile>> },
    Downloaded,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_identity_includes_single_face_crt_and_rejects_arbitrary_family() {
        assert_eq!(ALIASES.len(), 6);
        assert_eq!(
            expected_postscript("Sumi CRT"),
            Some(["Unifont"].as_slice())
        );
        assert_eq!(expected_postscript("Sumi Plex").unwrap().len(), 2);
        assert_eq!(expected_postscript("TerminusTTF"), None);
        assert!(!known_font("../../font"));
    }

    #[test]
    fn dto_roundtrip_preserves_existing_status_wire_names_and_paths() {
        let response = FontResponse::Statuses {
            statuses: vec![FontStatus {
                family: "Sumi CRT".into(),
                status: "downloading".into(),
                downloaded_bytes: 5,
                total_bytes: 10,
                error: None,
            }],
        };
        let wire = serde_json::to_value(&response).unwrap();
        assert_eq!(wire["statuses"][0]["downloadedBytes"], 5);
        assert_eq!(
            serde_json::from_value::<FontResponse>(wire).unwrap(),
            response
        );
        let response = FontResponse::Files {
            files: Some(vec![FontFile {
                path: PathBuf::from("/private/cache/字体.otf"),
                postscript: "Unifont".into(),
            }]),
        };
        assert_eq!(
            serde_json::from_str::<FontResponse>(&serde_json::to_string(&response).unwrap())
                .unwrap(),
            response
        );
    }

    #[test]
    fn requests_reject_caller_paths_urls_and_unknown_operations() {
        for wire in [
            r#"{"operation":"download","family":"Sumi CRT","url":"https://evil.invalid"}"#,
            r#"{"operation":"files","family":"Sumi CRT","path":"/etc/passwd"}"#,
            r#"{"operation":"install","family":"Sumi CRT"}"#,
        ] {
            assert!(serde_json::from_str::<FontRequest>(wire).is_err());
        }
        let request = FontRequest::Files {
            family: "Sumi CRT".into(),
        };
        assert_eq!(
            serde_json::from_str::<FontRequest>(&serde_json::to_string(&request).unwrap()).unwrap(),
            request
        );
    }
}
