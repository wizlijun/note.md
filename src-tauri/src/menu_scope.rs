//! Main-document menu commands must not escape a focused Linux plugin window.
pub fn forward_to_main(os: &str, focused_window: Option<&str>, command: &str) -> bool {
    if command.starts_with("plugin-window-close:") { return false; }
    os != "linux" || !focused_window.is_some_and(|label| label.starts_with("plugin-"))
        || command.starts_with("plugin:")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plugin_edit_commands_never_reach_the_main_document() {
        for command in ["file-new", "file-save", "file-undo", "file-redo", "file-close", "preferences"] {
            assert!(!forward_to_main("linux", Some("plugin-notemd.next-main"), command));
            assert!(forward_to_main("linux", Some("main"), command));
            assert!(forward_to_main("macos", Some("plugin-notemd.next-main"), command));
        }
    }
    #[test]
    fn plugin_launches_remain_available_and_scoped_close_never_broadcasts() {
        assert!(forward_to_main("linux", Some("plugin-notemd.next-main"), "plugin:notemd.sumi:open"));
        assert!(!forward_to_main("linux", Some("main"), "plugin-window-close:plugin-notemd.next-main"));
        assert!(forward_to_main("linux", None, "file-new"));
    }
}
