use crate::storage;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

pub const SKILL_RELATIVE_DIR: &str = ".agents/skills/build-conversation-dictionary";
pub const AGENTS_RELATIVE_PATH: &str = "AGENTS.md";

const AGENTS_START: &str = "<!-- notemd:conversation-dictionary:start -->";
const AGENTS_END: &str = "<!-- notemd:conversation-dictionary:end -->";
const AGENTS_BLOCK: &str = r#"<!-- notemd:conversation-dictionary:start -->
## Conversation Dictionary / 沟通词典

- When the user asks to build or refresh ASR corrections from historical communication transcripts, use `$build-conversation-dictionary` from `.agents/skills/build-conversation-dictionary/`.
- Analyze only meetings, calls, voice messages, or public conversations the user participated in. Exclude YouTube, podcasts, and other media the user only consumed.
- Generate an evidence-backed review dataset under `ssot/meetings/conversation-dictionary-drafts/`; never edit `ssot/meetings/conversation-dictionary.yml` directly.
- Importing a dataset only creates pending proposals. Only the user may approve selected changes in the Conversation Dictionary window.
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

const EXAMPLE_YAML: &str = include_str!(
    "../../../../skills/build-conversation-dictionary/references/conversation-dictionary.example.yml"
);

pub fn default_example() -> Value {
    serde_yaml::from_str(EXAMPLE_YAML)
        .expect("bundled Conversation Dictionary example must be valid")
}

pub fn ensure_agent_integration(vault: &Path) -> Result<Value, String> {
    let skill_files_updated = install_skill(vault)?;
    let agents_updated = ensure_agents_block(vault)?;
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

fn install_skill(vault: &Path) -> Result<usize, String> {
    let mut updated = 0;
    for (relative, contents) in SKILL_FILES {
        let relative_path = Path::new(SKILL_RELATIVE_DIR).join(relative);
        let path = storage::ensure_safe_parent(vault, &relative_path)?;
        match fs::read(&path) {
            Ok(current) if current == *contents => {}
            Ok(_) => {
                return Err(format!(
                    "refusing to overwrite customized Skill file {}",
                    path.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                storage::atomic_bytes_create_new(&path, contents)?;
                updated += 1;
            }
            Err(error) => return Err(format!("{}: {error}", path.display())),
        }
        if relative.starts_with("scripts/") {
            make_executable(&path)?;
        }
    }
    Ok(updated)
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

fn ensure_agents_block(vault: &Path) -> Result<bool, String> {
    let relative = Path::new(AGENTS_RELATIVE_PATH);
    let path = storage::ensure_safe_parent(vault, relative)?;
    let (existing, existed) = match fs::read(&path) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(|value| (value, true))
            .map_err(|_| "AGENTS.md must be UTF-8 before Conversation Dictionary can manage it")?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (String::new(), false),
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    let next = upsert_agents_block(&existing)?;
    if next == existing {
        return Ok(false);
    }
    if existed {
        let current = fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        if current != existing.as_bytes() {
            return Err("AGENTS.md changed while Conversation Dictionary was initializing".into());
        }
        storage::atomic_bytes(&path, next.as_bytes())?;
    } else {
        storage::atomic_bytes_create_new(&path, next.as_bytes())?;
    }
    Ok(true)
}

fn agents_block_is_current(vault: &Path) -> Result<bool, String> {
    let path = storage::resolve_inside(vault, Path::new(AGENTS_RELATIVE_PATH))?;
    let existing = match fs::read(&path) {
        Ok(bytes) => String::from_utf8(bytes)
            .map_err(|_| "AGENTS.md must be UTF-8 before Conversation Dictionary can inspect it")?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    Ok(existing.contains(AGENTS_BLOCK))
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
                return Err("Conversation Dictionary AGENTS.md managed block is malformed".into());
            }
            let managed = &existing[start..end];
            if managed != AGENTS_BLOCK.trim_end_matches('\n') {
                return Err(
                    "Conversation Dictionary AGENTS.md managed block was customized; review it manually"
                        .into(),
                );
            }
            Ok(existing.to_string())
        }
        _ => Err(
            "Conversation Dictionary AGENTS.md managed block is duplicated or incomplete".into(),
        ),
    }
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)
        .map_err(|error| error.to_string())?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), String> {
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
