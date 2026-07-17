//! HMAC-authenticated wire frames. Ported verbatim from
//! src-tauri/src/openclaw/protocol.rs (no tauri coupling).

use hmac::{Hmac, Mac};
use sha2::Sha256;
use serde::{Deserialize, Serialize};
use serde_json::Value;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
pub enum Frame {
    #[serde(rename = "hello")]
    Hello { token: String, device: String },
    #[serde(rename = "welcome")]
    Welcome { channel_caps: Vec<String> },
    #[serde(rename = "user.message")]
    UserMessage {
        session: String,
        text: String,
        #[serde(default)]
        attachments: Vec<Value>,
    },
    #[serde(rename = "user.cancel")]
    UserCancel { session: String, msg_id: String },
    #[serde(rename = "user.request_file")]
    UserRequestFile { session: String, path: String },
    #[serde(rename = "user.attach.upload")]
    UserAttachUpload { session: String, blob_id: String, filename: String, bytes_b64: String },
    #[serde(rename = "agent.message.delta")]
    AgentDelta { session: String, msg_id: String, text: String },
    #[serde(rename = "agent.message.end")]
    AgentEnd {
        session: String,
        msg_id: String,
        text: String,
        #[serde(default)]
        stop_reason: Option<String>,
    },
    #[serde(rename = "agent.file_content")]
    AgentFileContent {
        session: String,
        path: String,
        content: String,
        #[serde(default)]
        media_type: Option<String>,
    },
    #[serde(rename = "session.list")]
    SessionList,
    #[serde(rename = "session.list.result")]
    SessionListResult {
        sessions: Vec<Value>,
        #[serde(default)]
        focus: Option<String>,
    },
    #[serde(rename = "session.new")]
    SessionNew {
        #[serde(default)]
        title: Option<String>,
    },
    #[serde(rename = "session.open")]
    SessionOpen { id: String },
    #[serde(rename = "session.replay")]
    SessionReplay {
        id: String,
        #[serde(default)]
        after_msg_id: Option<String>,
    },
    #[serde(other)]
    Other,
}

pub fn wrap_for_wire(frame: &Frame, token: &str) -> Result<String, String> {
    let mut v = serde_json::to_value(frame).map_err(|e| e.to_string())?;
    if let Value::Object(ref mut map) = v {
        map.insert("v".into(), Value::from(1));
    }
    let body = serde_json::to_string(&v).map_err(|e| e.to_string())?;
    let mac = compute_mac(&body, token);
    if let Value::Object(ref mut map) = v {
        map.insert("mac".into(), Value::String(mac));
    }
    serde_json::to_string(&v).map_err(|e| e.to_string())
}

pub fn unwrap_from_wire(line: &str, token: &str) -> Result<Frame, String> {
    let mut v: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
    let mac = v
        .as_object_mut()
        .and_then(|m| m.remove("mac"))
        .and_then(|m| m.as_str().map(|s| s.to_string()))
        .ok_or_else(|| "missing mac".to_string())?;
    let body = serde_json::to_string(&v).map_err(|e| e.to_string())?;
    let expected = compute_mac(&body, token);
    if !constant_time_eq(expected.as_bytes(), mac.as_bytes()) {
        return Err("mac verification failed".into());
    }
    serde_json::from_value::<Frame>(v).map_err(|e| e.to_string())
}

fn compute_mac(body: &str, token: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(token.as_bytes()).expect("key");
    mac.update(body.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_user_message_frame() {
        let frame = Frame::UserMessage {
            session: "s1".to_string(),
            text: "hello".to_string(),
            attachments: vec![],
        };
        let token = "t".repeat(64);
        let line = wrap_for_wire(&frame, &token).unwrap();
        let parsed = unwrap_from_wire(&line, &token).unwrap();
        match parsed {
            Frame::UserMessage { session, text, .. } => {
                assert_eq!(session, "s1");
                assert_eq!(text, "hello");
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn rejects_tampered_mac() {
        let frame = Frame::UserMessage {
            session: "s".into(),
            text: "x".into(),
            attachments: vec![],
        };
        let line = wrap_for_wire(&frame, "k").unwrap();
        let mut bad = line.clone();
        if let Some(idx) = bad.find("hello") {
            bad.replace_range(idx..idx + 1, "H");
        } else if let Some(idx) = bad.find('x') {
            bad.replace_range(idx..idx + 1, "y");
        }
        assert!(unwrap_from_wire(&bad, "k").is_err());
    }

    #[test]
    fn rejects_wrong_token() {
        let frame = Frame::UserMessage {
            session: "s".into(),
            text: "hi".into(),
            attachments: vec![],
        };
        let line = wrap_for_wire(&frame, "correct-token").unwrap();
        assert!(unwrap_from_wire(&line, "wrong-token").is_err());
    }
}
