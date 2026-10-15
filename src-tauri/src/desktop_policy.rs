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
