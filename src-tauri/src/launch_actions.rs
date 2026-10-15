#[derive(Debug, PartialEq, Eq)]
pub enum Action { SmartSearch, Plugin { plugin_id: String, window: String } }
#[derive(Debug, Default, PartialEq, Eq)]
pub struct LaunchRequest { pub action: Option<Action>, pub has_action: bool, pub files: Vec<String> }

pub fn parse(argv: &[String]) -> LaunchRequest {
    let mut request = LaunchRequest::default();
    let mut args = argv.iter().skip(1).peekable();
    let mut action_count = 0;
    while let Some(arg) = args.next() {
        if arg == "--action" || arg.starts_with("--action=") {
            request.has_action = true;
            action_count += 1;
            let value = if let Some(value) = arg.strip_prefix("--action=") { Some(value) }
                else if args.peek().is_some_and(|next| !next.starts_with('-')) { args.next().map(String::as_str) }
                else { None };
            request.action = value.and_then(parse_action);
        } else if !arg.starts_with('-') {
            request.files.push(arg.clone());
        }
    }
    if action_count != 1 { request.action = None; }
    request
}

fn parse_action(value: &str) -> Option<Action> {
    if value == "smart-search" { return Some(Action::SmartSearch); }
    let (plugin_id, window) = value.strip_prefix("plugin:")?.split_once(':')?;
    let valid = |part: &str| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && part != "." && part != "..";
    if !valid(plugin_id) || !valid(window) { return None; }
    Some(Action::Plugin { plugin_id: plugin_id.into(), window: window.into() })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> { values.iter().map(|s| s.to_string()).collect() }
    #[test]
    fn consumes_action_and_value_preserving_regular_file_arguments() {
        let request = parse(&args(&["notemd", "--gui", "--action", "smart-search", "/tmp/n.md"]));
        assert_eq!(request.action, Some(Action::SmartSearch));
        assert_eq!(request.files, ["/tmp/n.md"]);
        assert!(request.has_action);
    }
    #[test]
    fn plugin_target_has_exactly_two_nonempty_safe_identifiers() {
        assert_eq!(parse(&args(&["notemd", "--action", "plugin:com.example:capture"])).action,
            Some(Action::Plugin { plugin_id: "com.example".into(), window: "capture".into() }));
        for value in ["plugin::capture", "plugin:id:", "plugin:id:win:extra", "plugin:../id:win", "unknown", "smart-search.html"] {
            let request = parse(&args(&["notemd", "--action", value]));
            assert!(request.has_action);
            assert_eq!(request.action, None, "{value}");
            assert!(request.files.is_empty(), "{value}");
        }
    }
    #[test]
    fn missing_duplicate_and_equals_actions_do_not_become_files() {
        for values in [vec!["notemd", "--action"], vec!["notemd", "--action", "smart-search", "--action", "smart-search"], vec!["notemd", "--action=unknown"]] {
            let request = parse(&args(&values));
            assert!(request.has_action);
            assert!(request.action.is_none());
            assert!(request.files.is_empty());
        }
    }
    #[test]
    fn deep_links_and_background_flags_keep_their_existing_routes() {
        let request = parse(&args(&["notemd", "--cli-background", "notemd://share/open?u=x", "a.md"]));
        assert!(!request.has_action);
        assert_eq!(request.files, ["notemd://share/open?u=x", "a.md"]);
    }
}

/// Invoked by the delayed file callback with the originating launch's focus policy.
pub fn deliver_file(activate_main: bool, show_main: impl FnOnce(), deliver: impl FnOnce()) {
    if activate_main { show_main(); }
    deliver();
}

#[cfg(test)]
mod delayed_file_tests {
    use super::*;
    use std::cell::RefCell;
    #[test]
    fn mixed_action_files_keep_delivery_without_delayed_main_focus() {
        for action in ["smart-search", "plugin:com.example:capture"] {
            let request = parse(&["notemd", "--gui", "--action", action, "/tmp/n.md"].map(String::from));
            assert_eq!(request.files, ["/tmp/n.md"]);
            let events = RefCell::new(Vec::new());
            let activate_main = !request.has_action;
            let delayed = || deliver_file(activate_main,
                || events.borrow_mut().push("main.show/focus"),
                || events.borrow_mut().push("file.delivery"));
            events.borrow_mut().push("action.focus");
            delayed();
            assert_eq!(*events.borrow(), ["action.focus", "file.delivery"], "{action}");
        }
    }
    #[test]
    fn ordinary_file_open_still_shows_and_focuses_main_before_delivery() {
        let request = parse(&["notemd", "--gui", "/tmp/n.md"].map(String::from));
        let events = RefCell::new(Vec::new());
        deliver_file(!request.has_action,
            || events.borrow_mut().push("main.show/focus"),
            || events.borrow_mut().push("file.delivery"));
        assert_eq!(*events.borrow(), ["main.show/focus", "file.delivery"]);
    }
}
