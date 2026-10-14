use super::{Result, MAX_SOURCE};
use crate::sotvault::logic::sha256_hex;
use serde::{
    de::{self, MapAccess, SeqAccess, Visitor},
    Deserialize, Serialize,
};
use serde_json::Value;
use std::{collections::HashSet, fmt};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    #[serde(rename = "project_id")]
    pub project_id: String,
    pub snapshot_id: String,
    pub entry: String,
    pub files: Vec<File>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct File {
    pub path: String,
    pub hash: String,
    pub bytes: usize,
}
#[derive(Debug)]
pub struct Snapshot {
    pub manifest: Manifest,
    pub source: Vec<Vec<u8>>,
}
pub fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
pub fn valid_path(s: &str) -> Result<()> {
    if s.len() > 1024
        || s.chars().any(char::is_control)
        || crate::project_share::validate_relative(s).is_err()
    {
        return Err("unsafe source path".into());
    }
    Ok(())
}
// Deserialize every object through this visitor, including ignored presentation objects.
struct Unique(Value);
impl<'de> Deserialize<'de> for Unique {
    fn deserialize<D: de::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Unique;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("unique-key JSON")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<Unique, E> {
                Ok(Unique(v.into()))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Unique, E> {
                Ok(Unique(v.into()))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<Unique, E> {
                Ok(Unique(v.into()))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<Unique, E> {
                serde_json::Number::from_f64(v)
                    .map(|n| Unique(Value::Number(n)))
                    .ok_or_else(|| E::custom("invalid number"))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<Unique, E> {
                Ok(Unique(v.into()))
            }
            fn visit_string<E: de::Error>(self, v: String) -> std::result::Result<Unique, E> {
                Ok(Unique(v.into()))
            }
            fn visit_unit<E: de::Error>(self) -> std::result::Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Unique, A::Error> {
                let mut out = vec![];
                while let Some(v) = a.next_element::<Unique>()? {
                    out.push(v.0)
                }
                Ok(Unique(Value::Array(out)))
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Unique, A::Error> {
                let mut out = serde_json::Map::new();
                while let Some(k) = a.next_key::<String>()? {
                    if out.contains_key(&k) {
                        return Err(de::Error::custom("duplicate JSON key"));
                    }
                    out.insert(k, a.next_value::<Unique>()?.0);
                }
                Ok(Unique(Value::Object(out)))
            }
        }
        d.deserialize_any(V)
    }
}
pub fn unique_json(bytes: &[u8]) -> Result<Value> {
    serde_json::from_slice::<Unique>(bytes)
        .map(|v| v.0)
        .map_err(|_| "invalid or duplicate-key JSON".into())
}
fn attributes(input: &str) -> Result<std::collections::BTreeMap<String, String>> {
    let b = input.as_bytes();
    let mut i = 0;
    let mut out = std::collections::BTreeMap::new();
    while i < b.len() {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1
        }
        if i == b.len() || &input[i..] == "/" {
            break;
        }
        let start = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && !b"=/>\"'<".contains(&b[i]) {
            i += 1
        }
        if start == i {
            return Err("invalid HTML attribute".into());
        }
        let key = input[start..i].to_ascii_lowercase();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1
        }
        let mut value = String::new();
        if i < b.len() && b[i] == b'=' {
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1
            }
            if i == b.len() {
                return Err("missing HTML attribute value".into());
            }
            if b[i] == b'\'' || b[i] == b'"' {
                let q = b[i];
                i += 1;
                let start = i;
                while i < b.len() && b[i] != q {
                    i += 1
                }
                if i == b.len() {
                    return Err("truncated HTML attribute".into());
                }
                value = input[start..i].into();
                i += 1;
            } else {
                let start = i;
                while i < b.len() && !b[i].is_ascii_whitespace() {
                    i += 1
                }
                value = input[start..i].into();
            }
        }
        if out.insert(key, value).is_some() {
            return Err("duplicate HTML attribute".into());
        }
    }
    Ok(out)
}
fn payload(html: &str) -> Result<&str> {
    let lower = html.to_ascii_lowercase();
    let b = html.as_bytes();
    let mut i = 0;
    let mut found = None;
    while i < b.len() {
        if b[i] != b'<' {
            i += 1;
            continue;
        }
        if html[i..].starts_with("<!--") {
            i = html[i + 4..]
                .find("-->")
                .map(|n| i + 4 + n + 3)
                .ok_or("truncated HTML comment")?;
            continue;
        }
        let start = i;
        i += 1;
        if i == b.len() {
            return Err("truncated HTML tag".into());
        }
        // Declarations/end tags are inert; quoted > is never a boundary.
        let name_start = i;
        while i < b.len() && b[i].is_ascii_alphanumeric() {
            i += 1
        }
        let name = &lower[name_start..i];
        let attrs_start = i;
        let mut quote = None;
        while i < b.len() {
            let c = b[i];
            if let Some(q) = quote {
                if c == q {
                    quote = None
                }
            } else if c == b'\'' || c == b'"' {
                quote = Some(c)
            } else if c == b'>' {
                break;
            }
            i += 1
        }
        if i == b.len() {
            return Err("truncated HTML tag".into());
        }
        let end = i;
        i += 1;
        if name.is_empty() {
            if start == end {
                return Err("invalid tag".into());
            }
            continue;
        }
        let attrs = attributes(&html[attrs_start..end])?;
        let project = attrs.get("id").is_some_and(|s| s == "project-data");
        if project && (name != "script" || found.is_some()) {
            return Err("duplicate or invalid project-data".into());
        }
        if name == "plaintext" {
            break;
        }
        if matches!(
            name,
            "script" | "style" | "textarea" | "title" | "xmp" | "iframe" | "noembed" | "noframes"
        ) {
            let needle = format!("</{name}");
            let mut scan = i;
            let close = loop {
                let p = lower[scan..]
                    .find(&needle)
                    .map(|n| scan + n)
                    .ok_or("truncated raw text")?;
                let next = p + needle.len();
                if b.get(next)
                    .is_some_and(|c| c.is_ascii_whitespace() || *c == b'>' || *c == b'/')
                {
                    break p;
                }
                scan = next;
            };
            if project {
                if attrs.get("type").map(|s| s.to_ascii_lowercase()).as_deref()
                    != Some("application/json")
                {
                    return Err("invalid project-data type".into());
                }
                found = Some(&html[i..close]);
            }
            i = close;
        }
    }
    found.ok_or_else(|| "missing project-data".into())
}
fn decode_base64(s: &str) -> Result<Vec<u8>> {
    if s.len() % 4 != 0 {
        return Err("invalid attachment encoding".into());
    }
    let mut out = vec![];
    for (index, c) in s.as_bytes().chunks(4).enumerate() {
        let mut n = 0u32;
        let mut pad = 0;
        for &v in c {
            n <<= 6;
            if v == b'=' {
                pad += 1
            } else {
                if pad > 0 {
                    return Err("invalid attachment encoding".into());
                }
                n |= match v {
                    b'A'..=b'Z' => (v - b'A') as u32,
                    b'a'..=b'z' => (v - b'a' + 26) as u32,
                    b'0'..=b'9' => (v - b'0' + 52) as u32,
                    b'+' => 62,
                    b'/' => 63,
                    _ => return Err("invalid attachment encoding".into()),
                }
            }
        }
        if pad > 2
            || (pad > 0 && index + 1 != s.len() / 4)
            || (pad == 1 && n & 255 != 0)
            || (pad == 2 && n & 65535 != 0)
        {
            return Err("invalid attachment encoding".into());
        }
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8)
        }
        if pad == 0 {
            out.push(n as u8)
        }
    }
    Ok(out)
}
pub fn extract_public_snapshot(bytes: &[u8]) -> Result<Snapshot> {
    if bytes.len() > MAX_SOURCE {
        return Err("reader exceeds limit".into());
    }
    let html = std::str::from_utf8(bytes).map_err(|_| "invalid reader UTF-8")?;
    let value = unique_json(payload(html)?.as_bytes())?;
    let snap = value
        .get("snapshot")
        .and_then(Value::as_object)
        .ok_or("missing public snapshot")?;
    if snap.keys().any(|k| {
        !matches!(
            k.as_str(),
            "schemaVersion" | "project_id" | "snapshotId" | "entry" | "files"
        )
    }) {
        return Err("non-public snapshot fields".into());
    }
    let text = |key: &str| {
        snap.get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "invalid snapshot field".to_string())
    };
    let mut manifest = Manifest {
        schema_version: 1,
        project_id: text("project_id")?,
        snapshot_id: text("snapshotId")?,
        entry: text("entry")?,
        files: vec![],
    };
    if snap.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || !valid_id(&manifest.project_id)
        || !valid_id(&manifest.snapshot_id)
    {
        return Err("invalid snapshot identity".into());
    }
    valid_path(&manifest.entry)?;
    let files = snap
        .get("files")
        .and_then(Value::as_array)
        .ok_or("missing files")?;
    if files.is_empty() || files.len() > 512 {
        return Err("invalid file count".into());
    }
    let mut seen = HashSet::new();
    let mut source = vec![];
    let mut total = 0;
    let mut entry = false;
    for file in files {
        let obj = file.as_object().ok_or("invalid file")?;
        if obj.keys().any(|k| {
            !matches!(
                k.as_str(),
                "path" | "hash" | "bytes" | "markdown" | "dataUrl" | "modifiedAt"
            )
        }) {
            return Err("non-public file fields".into());
        }
        let path = file["path"].as_str().ok_or("missing path")?;
        valid_path(path)?;
        if !seen.insert(path.to_lowercase()) {
            return Err("duplicate file path".into());
        }
        let hash = file["hash"].as_str().ok_or("missing hash")?;
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("invalid hash".into());
        }
        let size = file["bytes"]
            .as_u64()
            .filter(|n| *n <= MAX_SOURCE as u64)
            .ok_or("invalid size")? as usize;
        let data = match (file.get("markdown"), file.get("dataUrl")) {
            (Some(Value::String(s)), None) => {
                if path == manifest.entry {
                    entry = true
                }
                s.as_bytes().to_vec()
            }
            (None, Some(Value::String(s))) => {
                let (header, body) = s.split_once(',').ok_or("invalid data URL")?;
                if !header.starts_with("data:") || !header.ends_with(";base64") {
                    return Err("invalid data URL".into());
                }
                decode_base64(body)?
            }
            _ => return Err("invalid source content".into()),
        };
        total += data.len();
        if total > MAX_SOURCE || data.len() != size || sha256_hex(&data) != hash {
            return Err("source hash or size mismatch".into());
        }
        manifest.files.push(File {
            path: path.into(),
            hash: hash.into(),
            bytes: size,
        });
        source.push(data);
    }
    if !entry
        || serde_json::to_vec(&manifest)
            .map_err(|_| "invalid manifest")?
            .len()
            > 256 * 1024
    {
        return Err("invalid entry or manifest size".into());
    }
    Ok(Snapshot { manifest, source })
}
#[cfg(test)]
pub mod tests {
    use super::*;
    pub fn html(files: usize) -> Vec<u8> {
        let files:Vec<Value>=(0..files).map(|i|serde_json::json!({"path":format!("{i}.md"),"hash":sha256_hex("\u{feff}<正文\r\n".as_bytes()),"bytes":"\u{feff}<正文\r\n".len(),"markdown":"\u{feff}<正文\r\n"})).collect();
        format!("<script id=\"project-data\" type=\"application/json\">{}</script>",serde_json::json!({"snapshot":{"schemaVersion":1,"project_id":"pid","snapshotId":"sid","entry":"0.md","files":files}})).into_bytes()
    }
    #[test]
    fn reader_rejects_comment_payload_and_duplicate_json_keys() {
        assert!(extract_public_snapshot(
            b"<!-- <script id=\"project-data\" type=\"application/json\">{}</script> -->"
        )
        .is_err());
        assert!(extract_public_snapshot(b"<script id=\"project-data\" type=\"application/json\">{\"snapshot\":{},\"snapshot\":{}}</script>").is_err());
        assert!(unique_json(br#"{"x":{"a":1,"a":2}}"#).is_err());
    }
    #[test]
    fn reader_raw_text_duplicate_attrs_ids_type_truncation_utf8() {
        let h = String::from_utf8(html(1)).unwrap();
        for bad in [
            format!("<!-- {h} -->"),
            format!("<script>let x='{h}'</script>"),
            format!("{h}{h}"),
            h.replace("id=", "id='x' ID="),
            h.replace("application/json", "text/javascript"),
            h[..h.len() - 4].into(),
        ] {
            assert!(extract_public_snapshot(bad.as_bytes()).is_err(), "{bad}")
        }
        assert!(extract_public_snapshot(&[0xff]).is_err());
        assert!(extract_public_snapshot(
            h.replace("<script ", "<SCRIPT ")
                .replace("</script>", "</SCRIPT>")
                .as_bytes()
        )
        .is_ok());
    }
    #[test]
    fn reader_preserves_bom_json_escape_and_count_boundaries() {
        let h = String::from_utf8(html(1))
            .unwrap()
            .replace("<正文", "\\u003c正文");
        let s = extract_public_snapshot(h.as_bytes()).unwrap();
        assert_eq!(s.source[0], "\u{feff}<正文\r\n".as_bytes());
        assert!(extract_public_snapshot(&html(512)).is_ok());
        assert!(extract_public_snapshot(&html(513)).is_err());
    }
    #[test]
    fn reader_paths_fields_hash_and_size() {
        let h = String::from_utf8(html(2)).unwrap();
        for bad in [
            h.replace("1.md", "0.MD"),
            h.replace("0.md", ".note.md"),
            h.replace("0.md", "node_modules/x.md"),
            h.replace("0.md", "id_rsa"),
            h.replace("0.md", "a\\u0001.md"),
            h.replace("\"schemaVersion\":1", "\"schemaVersion\":2"),
            h.replace("\"entry\"", "\"git\":{},\"entry\""),
            h.replace("正文", "改变"),
        ] {
            assert!(extract_public_snapshot(bad.as_bytes()).is_err())
        }
    }
}
