use std::path::Path;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Config {
    pub remote: String,
    pub branch: String,
    pub debounce_ms: u64,
    pub pull_interval_secs: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            remote: "origin".into(),
            branch: "main".into(),
            debounce_ms: 2000,
            pull_interval_secs: 30,
        }
    }
}

impl Config {
    pub fn load(repo_path: &Path) -> Self {
        let config_path = repo_path.join(".vaultgitsync.toml");
        if config_path.exists() {
            let content = std::fs::read_to_string(&config_path).unwrap_or_default();
            toml::from_str(&content).unwrap_or_default()
        } else {
            Self::default()
        }
    }
}
