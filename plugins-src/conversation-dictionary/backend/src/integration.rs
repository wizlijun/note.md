use crate::storage;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

pub const SKILL_RELATIVE_DIR: &str = ".agents/skills/build-conversation-dictionary";
pub const AGENTS_RELATIVE_PATH: &str = "AGENTS.md";
const INTEGRATION_JOURNAL_PATH: &str = ".notemd/conversation-dictionary/integration-journal.json";

const AGENTS_START: &str = "<!-- notemd:conversation-dictionary:start -->";
const AGENTS_END: &str = "<!-- notemd:conversation-dictionary:end -->";
const PREVIOUS_AGENTS_BLOCK: &str = r#"<!-- notemd:conversation-dictionary:start -->
## Conversation Dictionary / 沟通词典

- When the user asks to build or refresh ASR corrections from historical communication transcripts, use `$build-conversation-dictionary` from `.agents/skills/build-conversation-dictionary/`.
- Analyze only meetings, calls, voice messages, or public conversations the user participated in. Exclude YouTube, podcasts, and other media the user only consumed.
- Generate an evidence-backed review dataset under `ssot/meetings/conversation-dictionary-drafts/`; never edit `ssot/meetings/conversation-dictionary.yml` directly.
- Importing a dataset only creates pending proposals. Only the user may approve selected changes in the Conversation Dictionary window.
<!-- notemd:conversation-dictionary:end -->
"#;
const PREVIOUS_FORMATTED_AGENTS_BLOCK: &str = r#"<!-- notemd:conversation-dictionary:start -->

## Conversation Dictionary / 沟通词典

- When the user asks to build or refresh ASR corrections from historical communication transcripts, use `$build-conversation-dictionary` from `.agents/skills/build-conversation-dictionary/`.
- Analyze only meetings, calls, voice messages, or public conversations the user participated in. Exclude YouTube, podcasts, and other media the user only consumed.
- Generate an evidence-backed review dataset under `ssot/meetings/conversation-dictionary-drafts/`; never edit `ssot/meetings/conversation-dictionary.yml` directly.
- Importing a dataset only creates pending proposals. Only the user may approve selected changes in the Conversation Dictionary window.

<!-- notemd:conversation-dictionary:end -->
"#;
const PREVIOUS_UNFORMATTED_AGENTS_BLOCK: &str = r#"<!-- notemd:conversation-dictionary:start -->
## Conversation Transcript Corrections / 沟通转写勘误

- When the user asks to build or refresh ASR corrections from historical communication transcripts, use `$build-conversation-dictionary` from `.agents/skills/build-conversation-dictionary/`.
- Analyze only meetings, calls, voice messages, or public conversations the user participated in. Exclude YouTube, podcasts, and other media the user only consumed.
- Generate an evidence-backed review dataset under `ssot/meetings/conversation-dictionary-drafts/`; never edit `ssot/meetings/conversation-dictionary.yml` directly.
- Importing a dataset only creates pending proposals. Only the user may approve selected changes in the Conversation Transcript Corrections window.
<!-- notemd:conversation-dictionary:end -->
"#;
const AGENTS_BLOCK: &str = r#"<!-- notemd:conversation-dictionary:start -->

## Conversation Transcript Corrections / 沟通转写勘误

- When the user asks to build or refresh ASR corrections from historical communication transcripts, use `$build-conversation-dictionary` from `.agents/skills/build-conversation-dictionary/`.
- Analyze only meetings, calls, voice messages, or public conversations the user participated in. Exclude YouTube, podcasts, and other media the user only consumed.
- Generate an evidence-backed review dataset under `ssot/meetings/conversation-dictionary-drafts/`; never edit `ssot/meetings/conversation-dictionary.yml` directly.
- Importing a dataset only creates pending proposals. Only the user may approve selected changes in the Conversation Transcript Corrections window.

<!-- notemd:conversation-dictionary:end -->
"#;

const SKILL_FILES: &[(&str, &[u8])] = &[
    (
        "SKILL.md",
        include_bytes!("../../../../skills/build-conversation-dictionary/SKILL.md"),
    ),
    (
        "agents/openai.yaml",
        include_bytes!("../../../../skills/build-conversation-dictionary/agents/openai.yaml"),
    ),
    (
        "references/conversation-dictionary.example.yml",
        include_bytes!(
            "../../../../skills/build-conversation-dictionary/references/conversation-dictionary.example.yml"
        ),
    ),
    (
        "references/dataset-format.md",
        include_bytes!(
            "../../../../skills/build-conversation-dictionary/references/dataset-format.md"
        ),
    ),
    (
        "scripts/inventory_transcripts.py",
        include_bytes!(
            "../../../../skills/build-conversation-dictionary/scripts/inventory_transcripts.py"
        ),
    ),
    (
        "scripts/test_validate_dataset.py",
        include_bytes!(
            "../../../../skills/build-conversation-dictionary/scripts/test_validate_dataset.py"
        ),
    ),
    (
        "scripts/validate_dataset.py",
        include_bytes!(
            "../../../../skills/build-conversation-dictionary/scripts/validate_dataset.py"
        ),
    ),
];

const PREVIOUS_MANAGED_SKILL_HASHES: &[(&str, &str)] = &[
    (
        "SKILL.md",
        "234ecd1dc1e775743dd90339cf3a083ec401618fc7f9445ecf25d890e2423e14",
    ),
    (
        "SKILL.md",
        "dcc908bc1e08d8acc81413d451b4004e1f25f2033ba8f8da2f6e8decad5eff8a",
    ),
    (
        "agents/openai.yaml",
        "25db5dbe3eef934c70503cf135cbdda9663c039e009290ab4debab6872578957",
    ),
    (
        "references/conversation-dictionary.example.yml",
        "5a054d6fb9bce6f42939e0da84bb91da32d4c775e86e09a80abec2eac8c2a792",
    ),
    (
        "references/conversation-dictionary.example.yml",
        "8843381d402bfcc7d456e70c2c54763eaf0c90c81b812f42bca43ee21647b6e4",
    ),
    (
        "references/dataset-format.md",
        "29972d0a1f0a2c25f9792af6253a13c7c35d066d35157d4848fbe0d90618dea4",
    ),
    (
        "references/dataset-format.md",
        "4053a1253039e98057a03c13a50edeae2c5ce00dada50d687b1da96e2e2d0301",
    ),
    (
        "scripts/inventory_transcripts.py",
        "99b0ba7ede34409f566d90cfb334ebb944054d5793fa0b74c1efb8cbe2b4c2b9",
    ),
    (
        "scripts/test_validate_dataset.py",
        "3c75efc792e558175e9dc0811653ae3b0eac28651c5d524e6669090d4aec7ca6",
    ),
    (
        "scripts/test_validate_dataset.py",
        "9309e80ce159ea35ac4b757e6bfe0b7de011d4ec2e0d1bbc356936929acd5fc0",
    ),
    (
        "scripts/validate_dataset.py",
        "95ef683d2e15a3f5bc1a44cb8a59df4a3a83635de2d4896f5697c4a83a4958fd",
    ),
    (
        "scripts/validate_dataset.py",
        "a9e1bd3e8b03da6a9626f8f6bec35a1c3d628d68e4dd0f904db7b0fe7f912f93",
    ),
];

const EXAMPLE_YAML: &str = include_str!(
    "../../../../skills/build-conversation-dictionary/references/conversation-dictionary.example.yml"
);

#[derive(Debug, Serialize, Deserialize)]
struct IntegrationJournal {
    changes: Vec<IntegrationChange>,
}

#[derive(Debug, Serialize, Deserialize)]
struct IntegrationChange {
    relative_path: String,
    previous: Option<Vec<u8>>,
    next: Vec<u8>,
    previous_mode: Option<u32>,
    next_mode: Option<u32>,
    content_changed: bool,
}

pub fn default_example() -> Value {
    serde_yaml::from_str(EXAMPLE_YAML)
        .expect("bundled Conversation Transcript Corrections example must be valid")
}

pub fn ensure_agent_integration(vault: &Path) -> Result<Value, String> {
    recover_integration_journal(vault)?;
    let mut changes = plan_skill_install(vault)?;
    let skill_files_updated = changes
        .iter()
        .filter(|change| change.content_changed)
        .count();
    let agents_change = plan_agents_block(vault)?;
    let agents_updated = agents_change.is_some();
    if let Some(change) = agents_change {
        changes.push(change);
    }
    apply_integration_changes(vault, changes)?;
    Ok(json!({
        "status": "ready",
        "agents_path": AGENTS_RELATIVE_PATH,
        "agents_updated": agents_updated,
        "skill_path": SKILL_RELATIVE_DIR,
        "skill_files_updated": skill_files_updated,
    }))
}

pub fn agent_integration_status(vault: &Path) -> Value {
    let skill_ready = skill_is_current(vault).unwrap_or(false);
    let agents_ready = agents_block_is_current(vault).unwrap_or(false);
    json!({
        "status": if skill_ready && agents_ready { "ready" } else { "needs_initialization" },
        "agents_path": AGENTS_RELATIVE_PATH,
        "agents_ready": agents_ready,
        "skill_path": SKILL_RELATIVE_DIR,
        "skill_ready": skill_ready,
    })
}

fn plan_skill_install(vault: &Path) -> Result<Vec<IntegrationChange>, String> {
    let mut changes = Vec::new();
    for (relative, contents) in SKILL_FILES {
        let relative_path = Path::new(SKILL_RELATIVE_DIR).join(relative);
        let path = storage::ensure_safe_parent(vault, &relative_path)?;
        let previous = match fs::read(&path) {
            Ok(current) if current == *contents => Some(current),
            Ok(current) => {
                let current_hash = storage::sha256(&current);
                let is_previous_managed =
                    PREVIOUS_MANAGED_SKILL_HASHES
                        .iter()
                        .any(|(known_path, hash)| {
                            *known_path == *relative && *hash == current_hash.as_str()
                        });
                if !is_previous_managed {
                    return Err(format!(
                        "refusing to overwrite customized Skill file {}",
                        path.display()
                    ));
                }
                Some(current)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("{}: {error}", path.display())),
        };
        let previous_mode = file_mode(&path)?;
        let next_mode = relative.starts_with("scripts/").then_some(0o755);
        let content_changed = previous.as_deref() != Some(*contents);
        let mode_changed = next_mode.is_some_and(|mode| previous_mode != Some(mode));
        if content_changed || mode_changed {
            changes.push(IntegrationChange {
                relative_path: relative_path.to_string_lossy().into_owned(),
                previous,
                next: contents.to_vec(),
                previous_mode,
                next_mode,
                content_changed,
            });
        }
    }
    Ok(changes)
}

fn skill_is_current(vault: &Path) -> Result<bool, String> {
    for (relative, contents) in SKILL_FILES {
        let relative_path = Path::new(SKILL_RELATIVE_DIR).join(relative);
        let path = storage::resolve_inside(vault, &relative_path)?;
        if fs::read(path).ok().as_deref() != Some(*contents) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn plan_agents_block(vault: &Path) -> Result<Option<IntegrationChange>, String> {
    let relative = Path::new(AGENTS_RELATIVE_PATH);
    let path = storage::ensure_safe_parent(vault, relative)?;
    let (existing, existed) = match fs::read(&path) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(|value| (value, true))
            .map_err(|_| {
                "AGENTS.md must be UTF-8 before Conversation Transcript Corrections can manage it"
            })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (String::new(), false),
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    let next = upsert_agents_block(&existing)?;
    if next == existing {
        return Ok(None);
    }
    Ok(Some(IntegrationChange {
        relative_path: AGENTS_RELATIVE_PATH.into(),
        previous: existed.then(|| existing.into_bytes()),
        next: next.into_bytes(),
        previous_mode: file_mode(&path)?,
        next_mode: None,
        content_changed: true,
    }))
}

fn apply_integration_changes(vault: &Path, changes: Vec<IntegrationChange>) -> Result<(), String> {
    if changes.is_empty() {
        return Ok(());
    }
    let journal_path = vault.join(INTEGRATION_JOURNAL_PATH);
    storage::atomic_json(&journal_path, &IntegrationJournal { changes })?;
    let result = (|| {
        let journal: IntegrationJournal = storage::read_json(&journal_path)?;
        for change in &journal.changes {
            let path = storage::resolve_inside(vault, Path::new(&change.relative_path))?;
            let current = fs::read(&path).ok();
            if current != change.previous {
                return Err(format!(
                    "{} changed while Conversation Transcript Corrections was initializing",
                    path.display()
                ));
            }
            if change.previous.is_some() {
                storage::atomic_bytes(&path, &change.next)?;
            } else {
                storage::atomic_bytes_create_new(&path, &change.next)?;
            }
            if let Some(mode) = change.next_mode {
                set_file_mode(&path, mode)?;
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        recover_integration_journal(vault)?;
        return Err(error);
    }
    fs::remove_file(journal_path).map_err(|error| error.to_string())?;
    Ok(())
}

fn recover_integration_journal(vault: &Path) -> Result<(), String> {
    let journal_path = vault.join(INTEGRATION_JOURNAL_PATH);
    if !journal_path.exists() {
        return Ok(());
    }
    let journal: IntegrationJournal = storage::read_json(&journal_path)?;
    for change in &journal.changes {
        let path = storage::resolve_inside(vault, Path::new(&change.relative_path))?;
        let current = fs::read(&path).ok();
        if current.as_deref() != Some(change.next.as_slice()) && current != change.previous {
            return Err(format!(
                "integration recovery conflicts with a customized file {}",
                path.display()
            ));
        }
    }
    for change in journal.changes.iter().rev() {
        let path = storage::resolve_inside(vault, Path::new(&change.relative_path))?;
        if let Some(previous) = &change.previous {
            storage::atomic_bytes(&path, previous)?;
            if let Some(mode) = change.previous_mode {
                set_file_mode(&path, mode)?;
            }
        } else if path.exists() {
            fs::remove_file(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        }
    }
    fs::remove_file(journal_path).map_err(|error| error.to_string())?;
    Ok(())
}

fn agents_block_is_current(vault: &Path) -> Result<bool, String> {
    let path = storage::resolve_inside(vault, Path::new(AGENTS_RELATIVE_PATH))?;
    let existing = match fs::read(&path) {
        Ok(bytes) => String::from_utf8(bytes).map_err(|_| {
            "AGENTS.md must be UTF-8 before Conversation Transcript Corrections can inspect it"
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    Ok(existing.contains(AGENTS_BLOCK.trim_end_matches('\n')))
}

fn upsert_agents_block(existing: &str) -> Result<String, String> {
    let starts: Vec<_> = existing.match_indices(AGENTS_START).collect();
    let ends: Vec<_> = existing.match_indices(AGENTS_END).collect();
    match (starts.len(), ends.len()) {
        (0, 0) => {
            let mut next = existing.to_string();
            if !next.is_empty() && !next.ends_with('\n') {
                next.push('\n');
            }
            if !next.is_empty() && !next.ends_with("\n\n") {
                next.push('\n');
            }
            next.push_str(AGENTS_BLOCK);
            Ok(next)
        }
        (1, 1) => {
            let start = starts[0].0;
            let end = ends[0].0 + AGENTS_END.len();
            if start >= ends[0].0 {
                return Err(
                    "Conversation Transcript Corrections AGENTS.md managed block is malformed"
                        .into(),
                );
            }
            let managed = &existing[start..end];
            if managed == AGENTS_BLOCK.trim_end_matches('\n') {
                return Ok(existing.to_string());
            }
            if managed == PREVIOUS_AGENTS_BLOCK.trim_end_matches('\n')
                || managed == PREVIOUS_FORMATTED_AGENTS_BLOCK.trim_end_matches('\n')
                || managed == PREVIOUS_UNFORMATTED_AGENTS_BLOCK.trim_end_matches('\n')
            {
                let mut next = existing.to_string();
                next.replace_range(start..end, AGENTS_BLOCK.trim_end_matches('\n'));
                return Ok(next);
            }
            if managed != AGENTS_BLOCK.trim_end_matches('\n') {
                return Err(
                    "Conversation Transcript Corrections AGENTS.md managed block was customized; review it manually"
                        .into(),
                );
            }
            unreachable!()
        }
        _ => Err(
            "Conversation Transcript Corrections AGENTS.md managed block is duplicated or incomplete"
                .into(),
        ),
    }
}

#[cfg(unix)]
fn file_mode(path: &Path) -> Result<Option<u32>, String> {
    use std::os::unix::fs::PermissionsExt;
    match fs::metadata(path) {
        Ok(metadata) => Ok(Some(metadata.permissions().mode() & 0o777)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(not(unix))]
fn file_mode(_path: &Path) -> Result<Option<u32>, String> {
    Ok(None)
}

#[cfg(unix)]
fn set_file_mode(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)
        .map_err(|error| error.to_string())?
        .permissions();
    permissions.set_mode(mode);
    fs::set_permissions(path, permissions).map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn set_file_mode(_path: &Path, _mode: u32) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialization_is_idempotent_and_preserves_user_agents_content() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("AGENTS.md"),
            "# My Vault\n\nKeep this rule.\n",
        )
        .unwrap();

        let first = ensure_agent_integration(temp.path()).unwrap();
        assert_eq!(first["agents_updated"], true);
        assert_eq!(first["skill_files_updated"], SKILL_FILES.len());
        let after_first = fs::read(temp.path().join("AGENTS.md")).unwrap();
        let second = ensure_agent_integration(temp.path()).unwrap();

        assert_eq!(second["agents_updated"], false);
        assert_eq!(second["skill_files_updated"], 0);
        assert_eq!(
            fs::read(temp.path().join("AGENTS.md")).unwrap(),
            after_first
        );
        let agents = String::from_utf8(after_first).unwrap();
        assert!(agents.starts_with("# My Vault\n\nKeep this rule.\n"));
        assert_eq!(agents.matches(AGENTS_START).count(), 1);
        assert_eq!(agent_integration_status(temp.path())["status"], "ready");
    }

    #[test]
    fn malformed_managed_block_is_rejected_without_rewriting() {
        let existing = format!("# Vault\n\n{AGENTS_START}\nunfinished\n");
        assert!(upsert_agents_block(&existing)
            .unwrap_err()
            .contains("incomplete"));
    }

    #[test]
    fn customized_managed_block_is_rejected_without_rewriting() {
        let existing = format!("{AGENTS_START}\ncustom\n{AGENTS_END}\n");
        assert!(upsert_agents_block(&existing)
            .unwrap_err()
            .contains("customized"));
    }

    #[test]
    fn previous_managed_agents_block_is_upgraded_without_touching_user_content() {
        let existing = format!("# Vault\n\n{PREVIOUS_AGENTS_BLOCK}");
        let updated = upsert_agents_block(&existing).unwrap();
        assert!(updated.starts_with("# Vault\n\n"));
        assert!(updated.contains(AGENTS_BLOCK.trim_end_matches('\n')));
        assert!(!updated.contains("## Conversation Dictionary / 沟通词典"));
    }

    #[test]
    fn previous_formatted_agents_block_is_upgraded_without_touching_user_content() {
        let existing = r#"# Vault

<!-- notemd:conversation-dictionary:start -->

## Conversation Dictionary / 沟通词典

- When the user asks to build or refresh ASR corrections from historical communication transcripts, use `$build-conversation-dictionary` from `.agents/skills/build-conversation-dictionary/`.
- Analyze only meetings, calls, voice messages, or public conversations the user participated in. Exclude YouTube, podcasts, and other media the user only consumed.
- Generate an evidence-backed review dataset under `ssot/meetings/conversation-dictionary-drafts/`; never edit `ssot/meetings/conversation-dictionary.yml` directly.
- Importing a dataset only creates pending proposals. Only the user may approve selected changes in the Conversation Dictionary window.

<!-- notemd:conversation-dictionary:end -->

Keep this rule.
"#;

        let updated = upsert_agents_block(existing).unwrap();

        assert!(updated.starts_with("# Vault\n\n"));
        assert!(updated.ends_with("\nKeep this rule.\n"));
        assert!(updated.contains(AGENTS_BLOCK.trim_end_matches('\n')));
        assert!(!updated.contains("## Conversation Dictionary / 沟通词典"));
    }

    #[test]
    fn previous_unformatted_agents_block_is_upgraded_without_touching_user_content() {
        let existing = format!("# Vault\n\n{PREVIOUS_UNFORMATTED_AGENTS_BLOCK}");
        let updated = upsert_agents_block(&existing).unwrap();
        assert!(updated.starts_with("# Vault\n\n"));
        assert!(updated.contains(AGENTS_BLOCK.trim_end_matches('\n')));
    }

    #[test]
    fn markdown_formatted_managed_agents_block_is_accepted_without_touching_user_content() {
        let existing = r#"# Vault

<!-- notemd:conversation-dictionary:start -->

## Conversation Transcript Corrections / 沟通转写勘误

- When the user asks to build or refresh ASR corrections from historical communication transcripts, use `$build-conversation-dictionary` from `.agents/skills/build-conversation-dictionary/`.
- Analyze only meetings, calls, voice messages, or public conversations the user participated in. Exclude YouTube, podcasts, and other media the user only consumed.
- Generate an evidence-backed review dataset under `ssot/meetings/conversation-dictionary-drafts/`; never edit `ssot/meetings/conversation-dictionary.yml` directly.
- Importing a dataset only creates pending proposals. Only the user may approve selected changes in the Conversation Transcript Corrections window.

<!-- notemd:conversation-dictionary:end -->

Keep this rule.
"#;

        let updated = upsert_agents_block(existing).unwrap();

        assert_eq!(updated, existing);
        assert!(updated.starts_with("# Vault\n\n"));
        assert!(updated.ends_with("\nKeep this rule.\n"));
    }

    #[test]
    fn formatted_managed_agents_block_at_eof_without_newline_is_current() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("AGENTS.md"),
            AGENTS_BLOCK.trim_end_matches('\n'),
        )
        .unwrap();

        assert!(agents_block_is_current(temp.path()).unwrap());
    }

    #[test]
    fn latest_published_skill_hashes_are_accepted_as_managed() {
        assert!(PREVIOUS_MANAGED_SKILL_HASHES.contains(&(
            "SKILL.md",
            "dcc908bc1e08d8acc81413d451b4004e1f25f2033ba8f8da2f6e8decad5eff8a"
        )));
        assert!(PREVIOUS_MANAGED_SKILL_HASHES.contains(&(
            "references/dataset-format.md",
            "4053a1253039e98057a03c13a50edeae2c5ce00dada50d687b1da96e2e2d0301"
        )));
        assert!(PREVIOUS_MANAGED_SKILL_HASHES.contains(&(
            "scripts/validate_dataset.py",
            "a9e1bd3e8b03da6a9626f8f6bec35a1c3d628d68e4dd0f904db7b0fe7f912f93"
        )));
    }

    #[test]
    fn agents_preflight_failure_does_not_install_any_skill_files() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("AGENTS.md"),
            format!("{AGENTS_START}\ncustom\n{AGENTS_END}\n"),
        )
        .unwrap();

        assert!(ensure_agent_integration(temp.path())
            .unwrap_err()
            .contains("customized"));
        assert!(!temp
            .path()
            .join(SKILL_RELATIVE_DIR)
            .join("SKILL.md")
            .exists());
    }

    #[test]
    fn existing_skill_file_is_never_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(SKILL_RELATIVE_DIR).join("SKILL.md");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "custom").unwrap();
        assert!(ensure_agent_integration(temp.path())
            .unwrap_err()
            .contains("refusing to overwrite"));
        assert_eq!(fs::read_to_string(path).unwrap(), "custom");
    }

    #[test]
    fn customized_skill_is_rejected_before_any_missing_files_are_created() {
        let temp = tempfile::tempdir().unwrap();
        let custom = temp
            .path()
            .join(SKILL_RELATIVE_DIR)
            .join("agents/openai.yaml");
        fs::create_dir_all(custom.parent().unwrap()).unwrap();
        fs::write(&custom, "custom").unwrap();
        assert!(ensure_agent_integration(temp.path())
            .unwrap_err()
            .contains("refusing to overwrite"));
        assert!(!temp
            .path()
            .join(SKILL_RELATIVE_DIR)
            .join("SKILL.md")
            .exists());
        assert_eq!(fs::read_to_string(custom).unwrap(), "custom");
    }

    #[test]
    fn interrupted_integration_is_rolled_back_before_retry() {
        let temp = tempfile::tempdir().unwrap();
        let changes = plan_skill_install(temp.path()).unwrap();
        let first_path = temp.path().join(&changes[0].relative_path);
        storage::atomic_json(
            &temp.path().join(INTEGRATION_JOURNAL_PATH),
            &IntegrationJournal { changes },
        )
        .unwrap();
        let journal: IntegrationJournal =
            storage::read_json(&temp.path().join(INTEGRATION_JOURNAL_PATH)).unwrap();
        storage::atomic_bytes_create_new(&first_path, &journal.changes[0].next).unwrap();

        recover_integration_journal(temp.path()).unwrap();

        assert!(!first_path.exists());
        assert!(!temp.path().join(INTEGRATION_JOURNAL_PATH).exists());
        assert_eq!(
            ensure_agent_integration(temp.path()).unwrap()["status"],
            "ready"
        );
    }

    #[cfg(unix)]
    #[test]
    fn skill_install_refuses_symlinked_agents_directory() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), temp.path().join(".agents")).unwrap();
        assert!(ensure_agent_integration(temp.path())
            .unwrap_err()
            .contains("symbolic link"));
    }
}
