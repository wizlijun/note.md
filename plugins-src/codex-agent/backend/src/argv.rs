//! Build one `codex exec` invocation.
//!
//! The prompt is intentionally represented by the final `-` and written to
//! stdin by the engine. Besides avoiding shell quoting entirely, this keeps a
//! large task prompt out of the OS argv size limit and process listings.
use std::path::Path;

pub fn build(model: Option<&str>, workspace: &Path, sandbox: &str) -> Vec<String> {
    let mut out = vec![
        "-a".into(),
        "never".into(),
        "exec".into(),
        "--json".into(),
        "--ephemeral".into(),
        "--skip-git-repo-check".into(),
        "-C".into(),
        workspace.to_string_lossy().into_owned(),
        "--sandbox".into(),
        sandbox.into(),
    ];
    if let Some(model) = model.filter(|m| !m.trim().is_empty()) {
        out.push("--model".into());
        out.push(model.to_string());
    }
    // A literal dash tells `codex exec` to read the complete prompt from stdin.
    out.push("-".into());
    out
}

/// Research retains native shell retrieval and live web search, with a fixed
/// read-only sandbox regardless of the editable task policy.
pub fn build_research(model: Option<&str>, workspace: &Path) -> Vec<String> {
    isolate_extensions(build_isolated(model, workspace, true), true)
}

/// A search protocol run receives its complete packet in stdin. Keep Codex
/// authenticated, but disable every local/discoverable information path so a
/// prompt-injected question or source cannot browse beyond that frozen packet.
pub fn build_input_only(model: Option<&str>, workspace: &Path) -> Vec<String> {
    build_isolated(model, workspace, false)
}

fn build_isolated(model: Option<&str>, workspace: &Path, research: bool) -> Vec<String> {
    let mut out = build(model, workspace, "read-only");
    let stdin_marker = out.pop().expect("build always ends in stdin marker");
    out.extend([
        "--strict-config".into(),
        "--ignore-user-config".into(),
        "--ignore-rules".into(),
        if research { "--enable" } else { "--disable" }.into(),
        "shell_tool".into(),
        if research { "--enable" } else { "--disable" }.into(),
        "unified_exec".into(),
        "--disable".into(),
        "view_image".into(),
        "-c".into(),
        if research { "web_search=\"live\"" } else { "web_search=\"disabled\"" }.into(),
        "-c".into(),
        "agents.enabled=false".into(),
        "-c".into(),
        "apps._default.enabled=false".into(),
        "-c".into(),
        "features.skill_mcp_dependency_install=false".into(),
    ]);
    out.push(stdin_marker);
    out
}

/// A strict task receives a frozen context packet, not access to the Vault.
/// Disable extension discovery and the code-mode execution host as well as
/// shell tools: remote models may still advertise code-mode tool schemas, but
/// the CLI must reject their execution locally.
pub fn build_strict_readonly(model: Option<&str>, workspace: &Path) -> Vec<String> {
    isolate_extensions(build_input_only(model, workspace), false)
}

fn isolate_extensions(mut out: Vec<String>, research: bool) -> Vec<String> {
    let stdin_marker = out.pop().expect("input-only argv ends in stdin marker");
    for feature in [
        "apps", "plugins", "hooks", "multi_agent", "multi_agent_v2",
        "skill_search", "tool_suggest",
        "sleep_tool", "goals", "browser_use", "computer_use", "image_generation",
        "workspace_dependencies", "shell_snapshot",
    ] {
        out.extend(["--disable".into(), feature.into()]);
    }
    // Current models dispatch native tools through the code-mode router. The
    // router uses this same sandbox/permission gate; disabling it would also
    // disable the permitted shell and web tools during research.
    for feature in ["code_mode_host", "code_mode"] {
        out.extend([if research { "--enable" } else { "--disable" }.into(), feature.into()]);
    }
    out.extend([
        "--enable".into(), "skip_host_skill_discovery".into(),
        "-c".into(), "project_doc_max_bytes=0".into(),
    ]);
    out.push(stdin_marker);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_headless_jsonl_run_with_explicit_boundaries() {
        assert_eq!(
            build(Some("gpt-5.6-terra"), Path::new("/v"), "workspace-write",),
            vec![
                "-a",
                "never",
                "exec",
                "--json",
                "--ephemeral",
                "--skip-git-repo-check",
                "-C",
                "/v",
                "--sandbox",
                "workspace-write",
                "--model",
                "gpt-5.6-terra",
                "-",
            ]
        );
    }

    #[test]
    fn leaves_model_selection_to_codex_when_the_task_does_not_pin_one() {
        let got = build(None, Path::new("/vault"), "read-only");
        assert!(!got.iter().any(|a| a == "--model"));
        assert_eq!(got.last().map(String::as_str), Some("-"));
    }

    #[test]
    fn blank_model_is_the_same_as_no_model() {
        let got = build(Some("  "), Path::new("/vault"), "danger-full-access");
        assert!(!got.iter().any(|a| a == "--model"));
    }

    #[test]
    fn input_only_disables_local_and_discoverable_tools() {
        let got = build_input_only(Some("gpt-5.6-terra"), Path::new("/isolated"));
        for pair in [
            ["--disable", "shell_tool"],
            ["--disable", "unified_exec"],
            ["--disable", "view_image"],
            ["-c", "web_search=\"disabled\""],
            ["-c", "agents.enabled=false"],
            ["-c", "apps._default.enabled=false"],
        ] {
            assert!(
                got.windows(2).any(|window| window == pair),
                "missing {pair:?}: {got:?}"
            );
        }
        assert!(got.iter().any(|arg| arg == "--ignore-user-config"));
        assert!(got.iter().any(|arg| arg == "--ignore-rules"));
        assert!(got.iter().any(|arg| arg == "--strict-config"));
        assert!(!got.iter().any(|arg| arg == "tools.view_image=false"));
        assert_eq!(got.last().map(String::as_str), Some("-"));
    }

    #[test]
    fn strict_readonly_disables_extensions_and_code_mode_execution() {
        let got = build_strict_readonly(Some("gpt-test"), Path::new("/isolated"));
        for feature in ["shell_tool", "unified_exec", "view_image", "apps", "plugins",
            "hooks", "multi_agent", "code_mode_host", "browser_use", "computer_use",
            "image_generation", "workspace_dependencies"] {
            assert!(got.windows(2).any(|w| w == ["--disable", feature]), "{feature}");
        }
        assert!(got.windows(2).any(|w| w == ["-c", "project_doc_max_bytes=0"]));
        assert!(got.windows(2).any(|w| w == ["--enable", "skip_host_skill_discovery"]));
        assert_eq!(got.last().map(String::as_str), Some("-"));
    }
    #[test]
    fn research_isolates_extensions_but_retains_native_retrieval() {
        let args = build_research(Some("gpt-test"), Path::new("/isolated"));
        for pair in [["--enable", "shell_tool"], ["--enable", "unified_exec"],
            ["-c", "web_search=\"live\""], ["--sandbox", "read-only"]] {
            assert!(args.windows(2).any(|window| window == pair), "{pair:?}");
        }
        for feature in ["apps", "plugins", "hooks", "multi_agent"] {
            assert!(args.windows(2).any(|window| window == ["--disable", feature]));
        }
        assert!(args.windows(2).any(|window| window == ["--enable", "code_mode_host"]));
        for flag in ["--strict-config", "--ignore-user-config", "--ignore-rules"] {
            assert!(args.iter().any(|arg| arg == flag));
        }
    }

}
