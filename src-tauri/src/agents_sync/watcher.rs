//! Non-recursive watch on the vault root; only AGENTS.md / CLAUDE.md events
//! pass through. Debouncing happens in the consumer thread (mod.rs).

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

pub const AGENTS_FILE: &str = "AGENTS.md";
pub const CLAUDE_FILE: &str = "CLAUDE.md";

pub fn start(vault_root: &Path, tx: mpsc::Sender<()>) -> notify::Result<RecommendedWatcher> {
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                if should_process(&event) {
                    let _ = tx.send(());
                }
            }
        },
        notify::Config::default().with_poll_interval(Duration::from_secs(2)),
    )?;
    watcher.watch(vault_root, RecursiveMode::NonRecursive)?;
    Ok(watcher)
}

fn should_process(event: &Event) -> bool {
    if !matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    ) {
        return false;
    }
    event.paths.iter().any(|p| {
        p.file_name()
            .and_then(|n| n.to_str())
            .map(|n| n == AGENTS_FILE || n == CLAUDE_FILE)
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind};
    use std::path::PathBuf;

    fn modify_event(name: &str) -> Event {
        Event::new(EventKind::Modify(ModifyKind::Any))
            .add_path(PathBuf::from(format!("/vault/{name}")))
    }

    #[test]
    fn agents_and_claude_pass() {
        assert!(should_process(&modify_event("AGENTS.md")));
        assert!(should_process(&modify_event("CLAUDE.md")));
    }

    #[test]
    fn other_files_are_ignored() {
        assert!(!should_process(&modify_event("README.md")));
        assert!(!should_process(&modify_event("agents.md.tmp")));
    }

    #[test]
    fn create_and_remove_pass_access_does_not() {
        let create = Event::new(EventKind::Create(CreateKind::File))
            .add_path(PathBuf::from("/vault/AGENTS.md"));
        assert!(should_process(&create));
        let access = Event::new(EventKind::Access(notify::event::AccessKind::Any))
            .add_path(PathBuf::from("/vault/AGENTS.md"));
        assert!(!should_process(&access));
    }
}
