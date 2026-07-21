use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub message: String,
}

pub struct LogBuffer {
    entries: Mutex<VecDeque<LogEntry>>,
    capacity: usize,
}

impl LogBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            entries: Mutex::new(VecDeque::with_capacity(capacity)),
            capacity,
        }
    }

    pub fn push(&self, level: &str, message: &str) {
        let entry = LogEntry {
            timestamp: now_str(),
            level: level.to_string(),
            message: message.to_string(),
        };
        let mut entries = self.entries.lock().unwrap();
        if entries.len() >= self.capacity {
            entries.pop_front();
        }
        entries.push_back(entry);
        // Mirror into the unified log bus (category=git-sync). Existing storage
        // above is untouched; this is additive so the Logs window can tail it.
        crate::log_bus::push_cat("git-sync", "backend", &level.to_ascii_lowercase(), message.to_string());
    }

    pub fn entries(&self) -> Vec<LogEntry> {
        self.entries.lock().unwrap().iter().cloned().collect()
    }
}

fn now_str() -> String {
    use std::time::SystemTime;
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{secs}")
}
