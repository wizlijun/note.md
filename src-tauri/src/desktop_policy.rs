pub fn supports_global_shortcuts(os: &str, wayland_display: Option<&str>, gdk_backend: Option<&str>) -> bool {
    os != "ios" && !(os == "linux" && wayland_display.is_some() && gdk_backend != Some("x11"))
}

pub fn window_decorations(os: &str, hyprland: Option<&str>, override_value: Option<bool>) -> bool {
    os != "ios" && (os != "linux" || override_value.unwrap_or(hyprland.is_none()))
}

/// Plugin UIs do not provide the host's custom titlebar or resize affordances.
pub fn decorations_for_window(os: &str, label: &str, host_decorations: bool) -> bool {
    (os == "linux" && label.starts_with("plugin-")) || host_decorations
}

pub fn plugin_window_resizable(os: &str, manifest_resizable: bool) -> bool {
    os == "linux" || manifest_resizable
}

pub fn track_window_state(os: &str, label: &str) -> bool {
    !(os == "linux" && label.starts_with("plugin-"))
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
    #[test]
    fn linux_plugins_remain_operable_when_host_decorations_are_disabled() {
        assert!(decorations_for_window("linux", "plugin-notemd-sumi-main", false));
        assert!(decorations_for_window("linux", "plugin-test-settings", false));
        assert!(!decorations_for_window("linux", "main", false));
        assert!(decorations_for_window("linux", "main", true));
        assert!(!decorations_for_window("macos", "plugin-notemd-sumi-main", false));
        assert!(!decorations_for_window("ios", "plugin-notemd-sumi-main", false));
        assert!(plugin_window_resizable("linux", false));
        assert!(!plugin_window_resizable("macos", false));
        assert!(plugin_window_resizable("macos", true));
    }
    #[test]
    fn newly_created_linux_plugins_do_not_restore_stale_offscreen_or_fullscreen_state() {
        assert!(!track_window_state("linux", "plugin-notemd-sumi-main"));
        assert!(!track_window_state("linux", "plugin-third-party-settings"));
        assert!(track_window_state("linux", "main"));
        assert!(track_window_state("linux", "settings"));
        assert!(track_window_state("macos", "plugin-notemd-sumi-main"));
        assert!(track_window_state("windows", "plugin-notemd-sumi-main"));
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
