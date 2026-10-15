pub fn supports_global_shortcuts(os: &str, wayland_display: Option<&str>, gdk_backend: Option<&str>) -> bool {
    os != "ios" && !(os == "linux" && wayland_display.is_some() && gdk_backend != Some("x11"))
}

pub fn window_decorations(os: &str, hyprland: Option<&str>, override_value: Option<bool>) -> bool {
    os != "ios" && (os != "linux" || override_value.unwrap_or(hyprland.is_none()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wayland_skips_shortcuts_except_explicit_x11_backend() {
        assert!(!supports_global_shortcuts("linux", Some("wayland-1"), None));
        assert!(!supports_global_shortcuts("linux", Some(""), Some("wayland")));
        assert!(supports_global_shortcuts("linux", Some("wayland-1"), Some("x11")));
        assert!(supports_global_shortcuts("linux", None, None));
        assert!(supports_global_shortcuts("macos", Some("wayland-1"), None));
        assert!(!supports_global_shortcuts("ios", None, None));
    }
    #[test]
    fn decorations_override_only_changes_linux_policy() {
        assert!(!window_decorations("linux", Some("instance"), None));
        assert!(window_decorations("linux", None, None));
        assert!(window_decorations("linux", Some("instance"), Some(true)));
        assert!(!window_decorations("linux", None, Some(false)));
        assert!(window_decorations("macos", Some("instance"), Some(false)));
    }
}

/// A successful persistence is a committed preference even if some live windows fail.
pub fn persist_and_apply<T, W>(
    persist: impl FnOnce() -> Result<T, String>,
    windows: impl IntoIterator<Item = (String, W)>,
    mut apply: impl FnMut(W, &T) -> Result<(), String>,
) -> Result<(T, Vec<(String, String)>), String> {
    let committed = persist()?;
    let mut failures = Vec::new();
    for (label, window) in windows {
        if let Err(error) = apply(window, &committed) { failures.push((label, error)); }
    }
    Ok((committed, failures))
}

#[cfg(test)]
mod commit_tests {
    use super::*;
    use std::cell::RefCell;
    #[test]
    fn committed_preference_survives_one_window_failure_and_attempts_every_window() {
        let path = std::env::temp_dir().join(format!("notemd-decoration-commit-{}.json", std::process::id()));
        let applied = RefCell::new(Vec::new());
        let result = persist_and_apply(
            || { std::fs::write(&path, "false").map_err(|e| e.to_string())?; Ok(false) },
            ["first", "closed", "last"].map(|label| (label.into(), label)),
            |label, committed| {
                assert_eq!(std::fs::read_to_string(&path).unwrap(), "false");
                assert!(!committed);
                applied.borrow_mut().push(label);
                if label == "closed" { Err("window closed".into()) } else { Ok(()) }
            },
        );
        let disk = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(disk, "false");
        assert_eq!(result, Ok((false, vec![("closed".into(), "window closed".into())])));
        assert_eq!(*applied.borrow(), ["first", "closed", "last"]);
    }
    #[test]
    fn write_failure_preserves_previous_disk_preference_and_does_not_apply_windows() {
        let path = std::env::temp_dir().join(format!("notemd-decoration-write-failure-{}.json", std::process::id()));
        std::fs::write(&path, "true").unwrap();
        let applied = RefCell::new(Vec::new());
        let result = persist_and_apply(
            || { std::fs::write(path.join("not-a-directory"), "false").map_err(|e| e.to_string())?; Ok(false) },
            [("main".into(), "main")],
            |label, _| { applied.borrow_mut().push(label); Ok(()) },
        );
        assert!(result.is_err());
        assert!(applied.borrow().is_empty());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "true");
        std::fs::remove_file(&path).unwrap();
    }
}
