//! Linux GUI startup escape hatches. Parsing never executes or expands shell input.
use std::path::Path;

pub fn parse(input: &str) -> Result<Vec<(String, String)>, usize> {
    let mut entries = Vec::new();
    for (index, raw) in input.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        let (key, value) = line.split_once('=').ok_or(index + 1)?;
        let key = key.trim();
        let value = value.trim();
        if !matches!(key, "WEBKIT_DISABLE_DMABUF_RENDERER" | "WEBKIT_DISABLE_COMPOSITING_MODE" | "GDK_BACKEND" | "GDK_SCALE" | "GDK_DPI_SCALE")
            || value.is_empty()
            || !value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ',' | ':' | '=')) {
            return Err(index + 1);
        }
        entries.push((key.to_string(), value.to_string()));
    }
    Ok(entries)
}

pub fn read(path: &Path) -> Result<Vec<(String, String)>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => parse(&text).map_err(|line| format!("invalid configuration at line {line}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("cannot read configuration: {}", error.kind())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_literal_allowlisted_assignments_from_fixture() {
        let path = std::env::temp_dir().join(format!("notemd-linux-env-{}.conf", std::process::id()));
        std::fs::write(&path, "# comment\n\nWEBKIT_DISABLE_DMABUF_RENDERER=1\nWEBKIT_DISABLE_COMPOSITING_MODE=1\nGDK_BACKEND=x11\nGDK_SCALE=2\nGDK_DPI_SCALE=1.5\n").unwrap();
        let result = read(&path);
        std::fs::remove_file(path).unwrap();
        assert_eq!(result.unwrap(), vec![("WEBKIT_DISABLE_DMABUF_RENDERER".into(),"1".into()),("WEBKIT_DISABLE_COMPOSITING_MODE".into(),"1".into()),("GDK_BACKEND".into(),"x11".into()),("GDK_SCALE".into(),"2".into()),("GDK_DPI_SCALE".into(),"1.5".into())]);
    }
    #[test]
    fn rejects_unknown_keys_malformed_lines_and_executable_expressions() {
        for input in ["PATH=x", "export GDK_SCALE=2", "GDK_SCALE", "GDK_SCALE=", "GDK_SCALE=$(touch /tmp/pwn)", "GDK_SCALE=`id`", "GDK_SCALE=$HOME", "GDK_SCALE=2;id", "GDK_SCALE=2\0"] {
            assert!(parse(input).is_err(), "{input:?}");
        }
    }
    #[test]
    fn missing_file_is_normal_and_error_does_not_echo_values() {
        assert!(read(Path::new("/notemd-missing-config-test/linux-env.conf")).unwrap().is_empty());
        assert_eq!(parse("# ignored\nSECRET=credential"), Err(2));
    }
}

/// Called only by GUI main, before Tauri/GTK or background threads exist.
#[cfg(target_os = "linux")]
pub fn apply() {
    let Some(base) = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty())
        .map(std::path::PathBuf::from).or_else(dirs::config_dir) else { return; };
    match read(&base.join(crate::app_dirs::BUNDLE_ID).join("linux-env.conf")) {
        Ok(entries) => for (key, value) in entries { std::env::set_var(key, value); },
        Err(message) => eprintln!("[linux-env] {message}"),
    }
}
