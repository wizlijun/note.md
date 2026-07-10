//! Pure decision logic for the AGENTS.md → CLAUDE.md mirror.
//! Hashes are SHA-256 hex of file contents; `None` means the file is missing.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct PairState {
    pub agents_hash: Option<String>,
    pub claude_hash: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncAction {
    /// Nothing to do.
    None,
    /// Copy AGENTS.md over CLAUDE.md, then record the baseline.
    MirrorToClaude,
    /// Files already identical; just record the baseline.
    RefreshBaseline,
    /// CLAUDE.md diverged on its own (or state is ambiguous); ask the user.
    PromptConflict,
}

pub fn decide(current: &PairState, baseline: &PairState) -> SyncAction {
    let agents = match &current.agents_hash {
        Some(h) => h,
        None => return SyncAction::None, // never reverse-generate from CLAUDE.md
    };
    match &current.claude_hash {
        None => SyncAction::MirrorToClaude,
        Some(claude) if claude == agents => {
            if current == baseline {
                SyncAction::None
            } else {
                SyncAction::RefreshBaseline
            }
        }
        Some(_) => {
            let agents_changed = current.agents_hash != baseline.agents_hash;
            let claude_changed = current.claude_hash != baseline.claude_hash;
            match (agents_changed, claude_changed) {
                (true, false) => SyncAction::MirrorToClaude,
                // CLAUDE.md 单独变、两者都变、或基线状态存疑：一律弹窗，不静默覆盖
                _ => SyncAction::PromptConflict,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(agents: Option<&str>, claude: Option<&str>) -> PairState {
        PairState {
            agents_hash: agents.map(String::from),
            claude_hash: claude.map(String::from),
        }
    }

    #[test]
    fn agents_missing_does_nothing_even_if_claude_exists() {
        // 不从 CLAUDE.md 反向生成（spec「不做的事」）
        assert_eq!(decide(&pair(None, Some("c1")), &PairState::default()), SyncAction::None);
        assert_eq!(decide(&pair(None, None), &PairState::default()), SyncAction::None);
    }

    #[test]
    fn claude_missing_mirrors() {
        assert_eq!(decide(&pair(Some("a1"), None), &PairState::default()), SyncAction::MirrorToClaude);
    }

    #[test]
    fn identical_and_matching_baseline_is_noop() {
        let cur = pair(Some("a1"), Some("a1"));
        assert_eq!(decide(&cur, &cur.clone()), SyncAction::None);
    }

    #[test]
    fn identical_but_stale_baseline_refreshes() {
        // 如 git pull 拉下已同步好的两份
        let cur = pair(Some("a2"), Some("a2"));
        let base = pair(Some("a1"), Some("a1"));
        assert_eq!(decide(&cur, &base), SyncAction::RefreshBaseline);
    }

    #[test]
    fn only_agents_changed_mirrors() {
        let cur = pair(Some("a2"), Some("a1"));
        let base = pair(Some("a1"), Some("a1"));
        assert_eq!(decide(&cur, &base), SyncAction::MirrorToClaude);
    }

    #[test]
    fn only_claude_changed_prompts() {
        let cur = pair(Some("a1"), Some("c2"));
        let base = pair(Some("a1"), Some("a1"));
        assert_eq!(decide(&cur, &base), SyncAction::PromptConflict);
    }

    #[test]
    fn both_changed_and_divergent_prompts() {
        // 不静默覆盖，防丢外部写入内容
        let cur = pair(Some("a2"), Some("c2"));
        let base = pair(Some("a1"), Some("a1"));
        assert_eq!(decide(&cur, &base), SyncAction::PromptConflict);
    }

    #[test]
    fn first_run_with_divergent_pair_prompts() {
        // baseline 文件不存在 → 默认空基线
        let cur = pair(Some("a1"), Some("c1"));
        assert_eq!(decide(&cur, &PairState::default()), SyncAction::PromptConflict);
    }

    #[test]
    fn divergent_but_baseline_unchanged_prompts() {
        // 理论上不该出现（基线只在一致时写入），保险起见也弹窗
        let cur = pair(Some("a1"), Some("c1"));
        assert_eq!(decide(&cur, &cur.clone()), SyncAction::PromptConflict);
    }

    #[test]
    fn self_write_suppression_via_baseline() {
        // 镜像写入后基线即等于当前 → watcher 回环事件判为 None
        let cur = pair(Some("a2"), Some("a2"));
        assert_eq!(decide(&cur, &cur.clone()), SyncAction::None);
    }
}
