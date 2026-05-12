use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

pub fn start(repo_path: &Path, tx: mpsc::Sender<Vec<PathBuf>>) -> notify::Result<RecommendedWatcher> {
    let watch_path = repo_path.to_path_buf();
    let filter_path = watch_path.clone();

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                if should_process(&event, &filter_path) {
                    let _ = tx.send(event.paths);
                }
            }
        },
        notify::Config::default().with_poll_interval(Duration::from_secs(2)),
    )?;

    watcher.watch(watch_path.as_ref(), RecursiveMode::Recursive)?;
    Ok(watcher)
}

fn should_process(event: &Event, repo_path: &Path) -> bool {
    let dominated_by_git = event.paths.iter().all(|p| {
        p.strip_prefix(repo_path)
            .map(|rel| rel.starts_with(".git"))
            .unwrap_or(false)
    });
    if dominated_by_git {
        return false;
    }

    matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    )
}
