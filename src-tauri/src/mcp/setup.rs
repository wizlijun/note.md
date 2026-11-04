//! 「复制给 Claude 的设置说明」生成器(2026-11-04 spec §2)。
//!
//! 产品边界:note.md **只提供用法说明**,不读、不写任何其他产品的配置。注册动作
//! 由用户把这段文本交给 Claude,由 agent 在用户逐项确认后执行。
//!
//! 确定性:输入只有二进制绝对路径、版本、语言;同输入逐字节同输出,不含时间戳。

use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// 注册参数固定。直接以绝对路径调用 `.app/Contents/MacOS/notemd` 时,
/// `cli::is_cli_mode` 会按路径判成 GUI —— 必须显式 `--cli`。
pub const SERVER_ARGS: [&str; 2] = ["--cli", "mcp"];
pub const SERVER_NAME: &str = "notemd";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    En,
    Zh,
}

impl Lang {
    /// CLI `--lang` 的取值。未知值返回 `None`,由调用方报参数错误。
    pub fn parse(s: &str) -> Option<Lang> {
        match s {
            "en" => Some(Lang::En),
            "zh" => Some(Lang::Zh),
            _ => None,
        }
    }

    /// 界面语言 → 说明语言:中文界面出中文,其余一律英文(说明主要给 agent 读)。
    pub fn from_ui_locale(locale: &str) -> Lang {
        if locale.to_ascii_lowercase().starts_with("zh") { Lang::Zh } else { Lang::En }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// 仅 macOS 生成;其他平台设置页只给一行注册配置。
    UnsupportedPlatform,
    /// 设置里关掉了 MCP —— 生成一份指向关着的服务的说明没有意义。
    McpDisabled,
    /// 从 DMG 直接运行或处于 App Translocation 隔离路径:这个路径重启后就会失效。
    NotInstalled(PathBuf),
    /// 拿不到自身可执行文件的路径。
    NoExecutable(String),
}

impl Refusal {
    pub fn message(&self, lang: Lang) -> String {
        match (self, lang) {
            (Refusal::UnsupportedPlatform, Lang::Zh) => "设置说明目前只支持 macOS。".into(),
            (Refusal::UnsupportedPlatform, Lang::En) => "Setup instructions are only generated on macOS.".into(),
            (Refusal::McpDisabled, Lang::Zh) => "MCP 服务已在设置中关闭,请先打开再生成。".into(),
            (Refusal::McpDisabled, Lang::En) => "The MCP server is turned off in Settings. Turn it on first.".into(),
            (Refusal::NotInstalled(p), Lang::Zh) => format!(
                "note.md 正从临时位置运行({}),请先把 note.md 拖进「应用程序」文件夹,再从那里打开并生成。",
                p.display()
            ),
            (Refusal::NotInstalled(p), Lang::En) => format!(
                "note.md is running from a temporary location ({}). Move note.md into the Applications folder, open it from there, then generate again.",
                p.display()
            ),
            (Refusal::NoExecutable(e), Lang::Zh) => format!("无法确定 note.md 可执行文件的位置:{e}"),
            (Refusal::NoExecutable(e), Lang::En) => format!("Cannot locate the note.md executable: {e}"),
        }
    }
}

/// 路径是否稳定可注册。`/Volumes/` = 从磁盘映像直接运行;`/AppTranslocation/` =
/// Gatekeeper 隔离运行的随机路径 —— 两者在下次启动后都不再存在。
pub fn check_binary_location(path: &Path) -> Result<(), Refusal> {
    let s = path.to_string_lossy();
    if s.starts_with("/Volumes/") || s.contains("/AppTranslocation/") {
        return Err(Refusal::NotInstalled(path.to_path_buf()));
    }
    Ok(())
}

/// 当前可执行文件的规范绝对路径(经符号链接解析 —— `/usr/local/bin/notemd`
/// 会落到 `.app` 内的真实二进制)。
pub fn current_binary() -> Result<PathBuf, Refusal> {
    let exe = std::env::current_exe().map_err(|e| Refusal::NoExecutable(e.to_string()))?;
    exe.canonicalize().map_err(|e| Refusal::NoExecutable(format!("{}: {e}", exe.display())))
}

/// 一个 MCP server 条目:`{"command": <绝对路径>, "args": ["--cli", "mcp"]}`。
pub fn server_entry(binary: &Path) -> serde_json::Value {
    serde_json::json!({ "command": binary.to_string_lossy(), "args": SERVER_ARGS })
}

/// 非 macOS 设置页给的一行注册配置:`"notemd": {...}`(紧凑 JSON)。
pub fn register_line(binary: &Path) -> String {
    format!("\"{SERVER_NAME}\": {}", server_entry(binary))
}

/// POSIX shell 单引号转义:`'` → `'\''`。
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// 手写排版而非 `to_string_pretty`:后者按字母序把 `args` 排在 `command` 前,
/// 且把参数数组拆成多行 —— 给人看的片段要「命令在前、参数一行」。
fn entry_pretty(binary: &Path) -> String {
    let command = serde_json::Value::from(binary.to_string_lossy());
    let args: Vec<String> = SERVER_ARGS.iter().map(|a| format!("\"{a}\"")).collect();
    format!("{{\n  \"command\": {command},\n  \"args\": [{}]\n}}", args.join(", "))
}

fn desktop_file_pretty(binary: &Path) -> String {
    let entry = entry_pretty(binary).replace('\n', "\n    ");
    format!("{{\n  \"mcpServers\": {{\n    \"{SERVER_NAME}\": {entry}\n  }}\n}}")
}

const TEMPLATE_EN: &str = include_str!("../../templates/mcp-setup.en.md.tmpl");
const TEMPLATE_ZH: &str = include_str!("../../templates/mcp-setup.zh.md.tmpl");

/// 替换占位符;多行值的续行沿用占位符所在行的缩进(列表项里的代码块不能被切断)。
fn fill(template: &str, vars: &[(&str, String)]) -> String {
    let mut out = String::with_capacity(template.len() + 1024);
    for line in template.split_inclusive('\n') {
        let indent: String = line.chars().take_while(|c| *c == ' ').collect();
        let mut line = line.to_string();
        for (key, value) in vars {
            let ph = format!("{{{{{key}}}}}");
            if line.contains(&ph) {
                let value = value.replace('\n', &format!("\n{indent}"));
                line = line.replace(&ph, &value);
            }
        }
        out.push_str(&line);
    }
    out
}

/// 纯函数:生成设置说明全文。
pub fn render(binary: &Path, version: &str, lang: Lang) -> String {
    let bin = binary.to_string_lossy();
    let bin_sh = sh_quote(&bin);
    let initialize = format!(
        concat!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"#,
            r#""protocolVersion":"{}","capabilities":{{}},"#,
            r#""clientInfo":{{"name":"notemd-setup-check","version":"1"}}}}}}"#
        ),
        super::protocol::DEFAULT_PROTOCOL_VERSION
    );
    let tools_list = r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#;
    let vars = [
        ("VERSION", version.to_string()),
        ("BIN_SH", bin_sh.clone()),
        (
            "CLAUDE_CODE_CMD",
            format!("claude mcp add --scope user {SERVER_NAME} -- {bin_sh} {}", SERVER_ARGS.join(" ")),
        ),
        ("DESKTOP_ENTRY", entry_pretty(binary)),
        ("DESKTOP_FILE", desktop_file_pretty(binary)),
        (
            "CHECK_CMD",
            format!(
                "printf '%s\\n' {} {} | {bin_sh} {}",
                sh_quote(&initialize),
                sh_quote(tools_list),
                SERVER_ARGS.join(" ")
            ),
        ),
    ];
    let template = match lang {
        Lang::En => TEMPLATE_EN,
        Lang::Zh => TEMPLATE_ZH,
    };
    fill(template, &vars)
}

/// 生成前的全部前置条件(spec §2.2)。UI 与 CLI 共用。
pub fn prepare(mcp_enabled: bool, lang: Lang) -> Result<String, Refusal> {
    if !cfg!(target_os = "macos") {
        return Err(Refusal::UnsupportedPlatform);
    }
    if !mcp_enabled {
        return Err(Refusal::McpDisabled);
    }
    let bin = current_binary()?;
    check_binary_location(&bin)?;
    Ok(render(&bin, env!("CARGO_PKG_VERSION"), lang))
}

/// 读应用级 settings.json(与 GUI 同一个文件);读不到/坏掉按「开」处理,与 gate 一致。
fn mcp_enabled_from_disk() -> bool {
    let path = crate::cli::resolve_config_dir().join("settings.json");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .map(|v| super::gate::enabled_from_value(&v))
        .unwrap_or(true)
}

/// `notemd mcp setup [--lang en|zh]`:只打印,不拉起 GUI、不碰 IPC。
pub fn run_cli(lang: Lang) -> ExitCode {
    match prepare(mcp_enabled_from_disk(), lang) {
        Ok(text) => {
            print!("{text}");
            ExitCode::SUCCESS
        }
        Err(r) => {
            eprintln!("notemd: {}", r.message(lang));
            ExitCode::from(2)
        }
    }
}

/// 设置页「复制给 Claude 的设置说明」。`Err` 为给用户看的拒绝原因。
#[tauri::command]
pub fn mcp_setup_text(app: tauri::AppHandle, locale: String) -> Result<String, String> {
    let lang = Lang::from_ui_locale(&locale);
    prepare(super::gate::enabled_from_settings(&app), lang).map_err(|r| r.message(lang))
}

/// 非 macOS 设置页那一行注册配置(当前可执行文件绝对路径 + `--cli`)。
#[tauri::command]
pub fn mcp_register_line() -> Result<String, String> {
    current_binary().map(|b| register_line(&b)).map_err(|r| r.message(Lang::En))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BIN: &str = "/Applications/note.md.app/Contents/MacOS/notemd";

    #[test]
    fn lang_parsing_is_closed() {
        assert_eq!(Lang::parse("en"), Some(Lang::En));
        assert_eq!(Lang::parse("zh"), Some(Lang::Zh));
        assert_eq!(Lang::parse("fr"), None);
        assert_eq!(Lang::from_ui_locale("zh-CN"), Lang::Zh);
        assert_eq!(Lang::from_ui_locale("zh"), Lang::Zh);
        assert_eq!(Lang::from_ui_locale("ja"), Lang::En);
        assert_eq!(Lang::from_ui_locale("de"), Lang::En);
    }

    #[test]
    fn rejects_disk_image_and_translocated_paths() {
        assert!(check_binary_location(Path::new(BIN)).is_ok());
        assert!(check_binary_location(Path::new("/Users/me/Applications/note.md.app/Contents/MacOS/notemd")).is_ok());
        for bad in [
            "/Volumes/note.md/note.md.app/Contents/MacOS/notemd",
            "/private/var/folders/xy/T/AppTranslocation/1234-ABCD/d/note.md.app/Contents/MacOS/notemd",
        ] {
            assert_eq!(
                check_binary_location(Path::new(bad)),
                Err(Refusal::NotInstalled(PathBuf::from(bad))),
                "{bad}"
            );
        }
    }

    #[test]
    fn server_entry_uses_absolute_path_and_explicit_cli_flag() {
        assert_eq!(
            server_entry(Path::new(BIN)),
            serde_json::json!({ "command": BIN, "args": ["--cli", "mcp"] })
        );
    }

    #[test]
    fn render_is_deterministic_and_has_no_unfilled_placeholders() {
        for lang in [Lang::En, Lang::Zh] {
            let a = render(Path::new(BIN), "6.1102.1", lang);
            let b = render(Path::new(BIN), "6.1102.1", lang);
            assert_eq!(a, b);
            assert!(!a.contains("{{"), "unfilled placeholder in {lang:?}:\n{a}");
            assert!(a.contains("6.1102.1"));
            assert!(a.contains(&format!(
                "claude mcp add --scope user notemd -- '{BIN}' --cli mcp"
            )));
            assert!(a.contains(&format!("test -x '{BIN}'")));
            assert!(a.contains(&format!("\"command\": \"{BIN}\"")));
            assert!(a.contains("~/Library/Logs/Claude/mcp-server-notemd.log"));
            // 不得出现裸命令注册 —— 那正是 Desktop 拿不到 PATH 时连不上的原因。
            assert!(!a.contains("\"command\": \"notemd\""));
        }
    }

    #[test]
    fn languages_differ_but_code_is_identical() {
        let en = render(Path::new(BIN), "1.0.0", Lang::En);
        let zh = render(Path::new(BIN), "1.0.0", Lang::Zh);
        assert_ne!(en, zh);
        assert!(en.contains("Rules for the agent"));
        assert!(zh.contains("给读到这段文字的 agent 的规则"));
        let code = |s: &str| -> Vec<String> {
            s.split("```").skip(1).step_by(2).map(|b| b.trim().to_string()).collect()
        };
        assert_eq!(code(&en), code(&zh));
    }

    #[test]
    fn multi_line_json_keeps_the_indentation_of_its_placeholder() {
        let text = render(Path::new(BIN), "1.0.0", Lang::En);
        // §3 里那份「新建文件」JSON 位于列表项内,缩进 2 格;每一行都必须保留缩进,
        // 否则 Markdown 会把代码块切断。
        let block = text
            .split("create it with only this content:\n\n  ```json\n")
            .nth(1)
            .and_then(|rest| rest.split("\n  ```").next())
            .expect("new-file JSON block");
        for line in block.lines() {
            assert!(line.starts_with("  "), "lost indentation: {line:?}");
        }
        let parsed: serde_json::Value = serde_json::from_str(block).unwrap();
        assert_eq!(parsed["mcpServers"]["notemd"], server_entry(Path::new(BIN)));
    }

    #[test]
    fn paths_with_quotes_and_spaces_are_escaped_per_context() {
        let odd = "/Users/o'neil/Apps/note \"md\".app/Contents/MacOS/notemd";
        let text = render(Path::new(odd), "1.0.0", Lang::En);
        // shell:单引号包裹,内部 ' → '\''
        assert!(text.contains(r#"test -x '/Users/o'\''neil/Apps/note "md".app/Contents/MacOS/notemd'"#));
        // JSON:标准转义
        assert!(text.contains(r#""command": "/Users/o'neil/Apps/note \"md\".app/Contents/MacOS/notemd""#));
    }

    #[test]
    fn self_check_command_is_valid_mcp_input() {
        let text = render(Path::new(BIN), "1.0.0", Lang::En);
        let line = text.lines().find(|l| l.starts_with("printf ")).expect("self-check line");
        assert!(line.ends_with(&format!("| '{BIN}' --cli mcp")));
        let payloads: Vec<serde_json::Value> = line
            .split('\'')
            .filter(|s| s.starts_with('{'))
            .map(|s| serde_json::from_str(s).unwrap())
            .collect();
        assert_eq!(payloads.len(), 2);
        assert_eq!(payloads[0]["method"], "initialize");
        assert_eq!(payloads[1]["method"], "tools/list");
    }

    #[test]
    fn register_line_is_a_single_json_member() {
        let line = register_line(Path::new("C:\\Program Files\\note.md\\notemd.exe"));
        assert!(!line.contains('\n'));
        let v: serde_json::Value = serde_json::from_str(&format!("{{{line}}}")).unwrap();
        assert_eq!(v["notemd"]["command"], "C:\\Program Files\\note.md\\notemd.exe");
        assert_eq!(v["notemd"]["args"], serde_json::json!(["--cli", "mcp"]));
    }

    /// 快照锁定全文(spec §5.1)。改模板后用
    /// `UPDATE_SNAPSHOTS=1 cargo test --lib mcp::setup` 重新生成并人工审阅 diff。
    #[test]
    fn rendered_text_matches_snapshots() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/mcp/snapshots");
        for (lang, name) in [(Lang::En, "setup.en.md"), (Lang::Zh, "setup.zh.md")] {
            let got = render(Path::new(BIN), "0.0.0-snapshot", lang);
            let path = dir.join(name);
            if std::env::var_os("UPDATE_SNAPSHOTS").is_some() {
                std::fs::create_dir_all(&dir).unwrap();
                std::fs::write(&path, &got).unwrap();
            }
            let want = std::fs::read_to_string(&path).expect("snapshot missing; run with UPDATE_SNAPSHOTS=1");
            assert_eq!(got, want, "{name} drifted");
        }
    }

    #[test]
    fn hand_formatted_json_parses_to_the_canonical_entry() {
        let odd = Path::new("/Users/o'neil/note \"md\".app/Contents/MacOS/notemd");
        let entry: serde_json::Value = serde_json::from_str(&entry_pretty(odd)).unwrap();
        assert_eq!(entry, server_entry(odd));
        let file: serde_json::Value = serde_json::from_str(&desktop_file_pretty(odd)).unwrap();
        assert_eq!(file, serde_json::json!({ "mcpServers": { "notemd": server_entry(odd) } }));
    }

    #[test]
    fn refusal_messages_exist_in_both_languages() {
        for r in [
            Refusal::UnsupportedPlatform,
            Refusal::McpDisabled,
            Refusal::NotInstalled(PathBuf::from("/Volumes/x")),
            Refusal::NoExecutable("boom".into()),
        ] {
            assert!(!r.message(Lang::En).is_empty());
            assert!(!r.message(Lang::Zh).is_empty());
        }
    }
}
