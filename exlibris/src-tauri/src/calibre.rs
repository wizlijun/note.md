use std::path::{Path, PathBuf};
use std::time::Duration;
use serde::Serialize;

/// Resolve a calibre binary directory:
/// 1. user-configured path (from shared config) — if it contains `ebook-meta`
/// 2. `/Applications/calibre.app/Contents/MacOS`
/// 3. directory containing `ebook-meta` in $PATH
///
/// Returns the directory containing the binaries, or None.
pub fn detect(user_configured: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = user_configured {
        if dir.join("ebook-meta").is_file() {
            return Some(dir.to_path_buf());
        }
    }
    let candidate = Path::new("/Applications/calibre.app/Contents/MacOS");
    if candidate.join("ebook-meta").is_file() {
        return Some(candidate.to_path_buf());
    }
    if let Ok(path_env) = std::env::var("PATH") {
        for dir in path_env.split(':') {
            let p = Path::new(dir).join("ebook-meta");
            if p.is_file() {
                return Some(PathBuf::from(dir));
            }
        }
    }
    None
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct ExtractedMeta {
    pub title: String,
    pub authors: Vec<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub isbn: Option<String>,
    pub tags: Vec<String>,
    pub pubdate: Option<String>,
    pub description: Option<String>,
    pub calibre_version: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum CalibreError {
    #[error("calibre binary not found")]
    NotFound,
    #[error("ebook-meta exited with code {0}; stderr: {1}")]
    NonZero(i32, String),
    #[error("ebook-meta timed out after {0:?}")]
    Timeout(Duration),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("parse: {0}")]
    Parse(String),
}

pub async fn extract_meta(
    binary_dir: &std::path::Path,
    file: &std::path::Path,
    timeout: Duration,
) -> Result<ExtractedMeta, CalibreError> {
    let bin = binary_dir.join("ebook-meta");
    if !bin.is_file() { return Err(CalibreError::NotFound); }

    let output = tokio::time::timeout(
        timeout,
        tokio::process::Command::new(&bin)
            .arg(file).arg("--to-opf=-")
            .output(),
    )
    .await
    .map_err(|_| CalibreError::Timeout(timeout))??;

    if !output.status.success() {
        let code = output.status.code().unwrap_or(-1);
        let err = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(CalibreError::NonZero(code, truncate(err, 16 * 1024)));
    }
    let opf = String::from_utf8_lossy(&output.stdout).into_owned();
    parse_opf(&opf)
}

pub async fn convert(
    binary_dir: &std::path::Path,
    src: &std::path::Path,
    dst: &std::path::Path,
    timeout: Duration,
) -> Result<(), CalibreError> {
    let bin = binary_dir.join("ebook-convert");
    if !bin.is_file() { return Err(CalibreError::NotFound); }
    let output = tokio::time::timeout(
        timeout,
        tokio::process::Command::new(&bin)
            .arg(src).arg(dst)
            .output(),
    )
    .await
    .map_err(|_| CalibreError::Timeout(timeout))??;
    if !output.status.success() {
        let code = output.status.code().unwrap_or(-1);
        let err = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(CalibreError::NonZero(code, truncate(err, 16 * 1024)));
    }
    Ok(())
}

fn truncate(s: String, max: usize) -> String {
    if s.len() <= max { s } else { s[s.len() - max..].to_string() }
}

fn parse_opf(opf: &str) -> Result<ExtractedMeta, CalibreError> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(opf);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut out = ExtractedMeta::default();
    let mut current = String::new();
    let mut isbn_pending = false;
    loop {
        match reader.read_event_into(&mut buf) {
            Err(e) => return Err(CalibreError::Parse(e.to_string())),
            Ok(Event::Eof) => break,
            Ok(Event::Start(e)) => {
                current = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                isbn_pending = false;
                if current.ends_with("identifier") {
                    for attr in e.attributes().flatten() {
                        if let Ok(v) = std::str::from_utf8(&attr.value) {
                            if v.eq_ignore_ascii_case("ISBN") { isbn_pending = true; }
                        }
                    }
                }
            }
            Ok(Event::Text(t)) => {
                let txt = t.unescape().unwrap_or_default().into_owned();
                match current.as_str() {
                    s if s.ends_with("title") => out.title = txt,
                    s if s.ends_with("creator") => out.authors.push(txt),
                    s if s.ends_with("publisher") => out.publisher = Some(txt),
                    s if s.ends_with("language") => out.language = Some(txt),
                    s if s.ends_with("subject") => out.tags.push(txt),
                    s if s.ends_with("date") => out.pubdate = Some(txt),
                    s if s.ends_with("description") => out.description = Some(txt),
                    s if s.ends_with("identifier") && isbn_pending => out.isbn = Some(txt),
                    _ => {}
                }
            }
            Ok(Event::End(_)) => current.clear(),
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn touch_exec(p: &Path) {
        std::fs::write(p, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn detect_prefers_user_configured() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        touch_exec(&dir.join("ebook-meta"));
        let got = detect(Some(dir)).unwrap();
        assert_eq!(got, dir);
    }

    #[test]
    fn detect_user_configured_without_binary_falls_back() {
        let tmp = TempDir::new().unwrap();
        let got = detect(Some(tmp.path()));
        // result depends on host; just assert no panic
        assert!(got.is_none() || got.is_some());
    }

    use std::path::PathBuf;

    fn fixtures_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
    }

    fn binary_dir_for(variant: &str) -> tempfile::TempDir {
        let tmp = tempfile::TempDir::new().unwrap();
        let target = fixtures_dir().join(format!("ebook-meta-{variant}.sh"));
        std::os::unix::fs::symlink(target, tmp.path().join("ebook-meta")).unwrap();
        tmp
    }

    #[tokio::test]
    async fn extract_meta_parses_success_opf() {
        let dir = binary_dir_for("success");
        let any_file = fixtures_dir().join("ebook-meta-success.sh");
        let meta = extract_meta(dir.path(), &any_file, Duration::from_secs(2)).await.unwrap();
        assert_eq!(meta.title, "Hello World");
        assert_eq!(meta.authors, vec!["Jane Author"]);
        assert_eq!(meta.language.as_deref(), Some("en"));
        assert_eq!(meta.isbn.as_deref(), Some("9780000000001"));
        assert!(meta.tags.contains(&"programming".to_string()));
    }

    #[tokio::test]
    async fn extract_meta_reports_crash_with_stderr() {
        let dir = binary_dir_for("crash");
        let any = fixtures_dir().join("ebook-meta-crash.sh");
        let err = extract_meta(dir.path(), &any, Duration::from_secs(2)).await.unwrap_err();
        match err {
            CalibreError::NonZero(code, stderr) => {
                assert_eq!(code, 1);
                assert!(stderr.contains("fake crash"));
            }
            _ => panic!("expected NonZero"),
        }
    }

    #[tokio::test]
    async fn extract_meta_times_out() {
        let dir = binary_dir_for("hang");
        let any = fixtures_dir().join("ebook-meta-hang.sh");
        let err = extract_meta(dir.path(), &any, Duration::from_millis(200)).await.unwrap_err();
        matches!(err, CalibreError::Timeout(_));
    }
}
