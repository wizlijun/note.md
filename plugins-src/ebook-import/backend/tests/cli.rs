//! Exercise the distributable backend process and SDK command entry, not a
//! parallel test-only importer. All Vaults, settings, conversion and OCR are local.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

const CATALOG: &str = "schema_version: 1\ntopics:\n  - id: software\n    label: 软件工程\n    description: 软件开发方法\n    index_file: 软件工程.index.md\n    vocabulary:\n      - term: 设计\n        description: 系统设计\n      - term: 测试\n        description: 软件验证\n";

struct Plugin {
    child: Child,
    input: ChildStdin,
    output: Receiver<Value>,
    next_id: u64,
    vault: PathBuf,
    logs: Vec<String>,
    configured: bool,
}

impl Plugin {
    fn new(root: &Path, library: &str, ocr_url: Option<&str>) -> Self {
        Self::with_config(root, library, ocr_url, true)
    }

    fn with_config(root: &Path, library: &str, ocr_url: Option<&str>, configured: bool) -> Self {
        let vault = root.join("vault");
        let data = root.join("plugin-data");
        std::fs::create_dir_all(vault.join(library)).unwrap();
        std::fs::create_dir_all(vault.join(".notemd")).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(vault.join(library).join("topics.yml"), CATALOG).unwrap();
        std::fs::write(
            vault.join(".notemd/ebook-import.json"),
            json!({ "ebooks_root": library, "provider": "wechat", "wechat_url": ocr_url.unwrap_or("http://127.0.0.1:1/unused") }).to_string(),
        ).unwrap();
        let config = root.join("shared.json");
        std::fs::write(
            &config,
            if configured {
                json!({"sotvault": vault})
            } else {
                json!({})
            }
            .to_string(),
        )
        .unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_notemd-ebook-import"))
            .env("NOTEMD_SHARED_CONFIG", config)
            .env("HTTPS_PROXY", "http://127.0.0.1:1")
            .env("ALL_PROXY", "http://127.0.0.1:1")
            .env("NO_PROXY", "127.0.0.1,localhost")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, output) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Ok(value) = serde_json::from_str(&line) {
                    if tx.send(value).is_err() {
                        break;
                    }
                }
            }
        });
        let mut plugin = Self {
            child,
            input,
            output,
            next_id: 1,
            vault,
            logs: vec![],
            configured,
        };
        plugin.request(
            "$initialize",
            json!({
                "protocol_version": 2, "host_version": "1.0.0", "locale": "en", "theme": "light",
                "plugin_root": root, "data_dir": data,
            }),
        );
        plugin.request("$activate", json!({"event":"onCli:ebook"}));
        // Finish the asynchronous host lookup before testing read-only discovery.
        while configured
            && !plugin
                .logs
                .iter()
                .any(|line| line.contains("ebook-import ready"))
        {
            let value = plugin.read();
            plugin.host_message(&value);
        }
        plugin
    }

    fn read(&self) -> Value {
        self.output
            .recv_timeout(Duration::from_secs(45))
            .expect("plugin did not respond")
    }

    fn host_message(&mut self, value: &Value) {
        if value["method"] == "host.vault.info" {
            writeln!(
                self.input,
                "{}",
                json!({"jsonrpc":"2.0", "id":value["id"], "result": if self.configured { json!({"root":self.vault}) } else { json!({}) }})
            )
            .unwrap();
            self.input.flush().unwrap();
        }
        if value["method"] == "host.log.info" {
            self.logs.push(
                value["params"]["message"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            );
        }
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        writeln!(
            self.input,
            "{}",
            json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params})
        )
        .unwrap();
        self.input.flush().unwrap();
        loop {
            let value = self.read();
            self.host_message(&value);
            if value["id"] == id && value.get("method").is_none() {
                return value;
            }
        }
    }

    fn cli(&mut self, file: Option<&Path>, flags: Value) -> Value {
        let args = file
            .map(|file| json!({"file":file}))
            .unwrap_or_else(|| json!({}));
        self.request(
            "command.execute",
            json!({"command":"import", "context":{"cli":{"args":args,"flags":flags}}}),
        )
    }
}

impl Drop for Plugin {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn visit(base: &Path, path: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in std::fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                out.insert(path.strip_prefix(base).unwrap().to_path_buf(), vec![]);
                visit(base, &path, out);
            } else {
                out.insert(
                    path.strip_prefix(base).unwrap().to_path_buf(),
                    std::fs::read(&path).unwrap(),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    visit(root, root, &mut out);
    out
}

#[test]
fn discovery_uses_the_real_catalog_and_does_not_seed_or_repair_files() {
    let tmp = tempfile::tempdir().unwrap();
    let mut plugin = Plugin::new(tmp.path(), "books", None);
    assert!(!plugin.vault.join("agents").exists());
    assert!(!plugin.vault.join("books/软件工程.index.md").exists());
    let before = snapshot(&plugin.vault);
    let value = plugin.cli(None, json!({"list-topics":true}));
    assert_eq!(value["result"]["ebooks_root"], "books");
    assert_eq!(value["result"]["topics"][0]["id"], "software");
    assert_eq!(value["result"]["topics"][0]["label"], "软件工程");
    assert_eq!(snapshot(&plugin.vault), before);
    let missing = plugin.cli(None, json!({"list-topics":true,"root":"missing"}));
    assert!(missing["error"]["message"]
        .as_str()
        .unwrap()
        .contains("configure topics"));
    assert_eq!(snapshot(&plugin.vault), before);
}

#[test]
fn invalid_import_arguments_fail_before_creating_work_or_books() {
    let tmp = tempfile::tempdir().unwrap();
    let mut plugin = Plugin::new(tmp.path(), "books", None);
    let file = tmp.path().join("book.epub");
    std::fs::write(&file, b"not consumed").unwrap();
    for (input, flags, expected) in [
        (None, json!({}), "usage:"),
        (
            None,
            json!({"list-topics":true,"topic":""}),
            "cannot be combined",
        ),
        (
            None,
            json!({"list-topics":true,"ocr-provider":""}),
            "cannot be combined",
        ),
        (None, json!({"list-topics":true,"root":""}), "non-empty"),
        (
            Some(file.as_path()),
            json!({"topic":"software","ocr":true,"ocr-provider":""}),
            "non-empty",
        ),
        (Some(file.as_path()), json!({}), "usage:"),
        (Some(file.as_path()), json!({"topic":"  "}), "non-empty"),
        (
            Some(file.as_path()),
            json!({"topic":"software", "ocr-provider":"wechat"}),
            "requires --ocr",
        ),
        (
            Some(file.as_path()),
            json!({"topic":"software", "ocr":true,"ocr-provider":"typo"}),
            "unsupported OCR provider",
        ),
        (
            Some(file.as_path()),
            json!({"topic":"software", "ocr":true,"ocr-provider":"baidu"}),
            "only supports PDF",
        ),
        (
            Some(file.as_path()),
            json!({"topic":"unknown"}),
            "--list-topics",
        ),
        (
            Some(file.as_path()),
            json!({"list-topics":true}),
            "cannot be combined",
        ),
        (
            None,
            json!({"list-topics":true,"ocr":true}),
            "cannot be combined",
        ),
        (
            None,
            json!({"list-topics":true,"root":"../outside"}),
            "vault-relative",
        ),
    ] {
        let value = plugin.cli(input, flags);
        assert!(
            value["error"]["message"]
                .as_str()
                .unwrap()
                .contains(expected),
            "{value}"
        );
    }
    assert!(!tmp.path().join("plugin-data/work").exists());
    assert_eq!(
        std::fs::read_dir(plugin.vault.join("books"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn explicit_vault_works_without_current_vault_and_rejects_invalid_targets() {
    let tmp = tempfile::tempdir().unwrap();
    let mut plugin = Plugin::with_config(tmp.path(), "books", None, false);
    let no_target = plugin.cli(None, json!({"list-topics":true}));
    assert!(no_target["error"]["message"]
        .as_str()
        .unwrap()
        .contains("no vault"));
    let before = snapshot(&plugin.vault);
    let explicit = plugin.cli(None, json!({"list-topics":true,"vault":plugin.vault}));
    assert_eq!(
        explicit["result"]["topics"][0]["id"], "software",
        "{explicit}"
    );
    for invalid in [
        json!(""),
        json!("   "),
        json!("relative"),
        json!(tmp.path().join("missing")),
        json!(tmp.path().join("shared.json")),
    ] {
        let response = plugin.cli(None, json!({"list-topics":true,"vault":invalid}));
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("--vault must be"));
    }
    assert_eq!(snapshot(&plugin.vault), before);
    assert_eq!(
        std::fs::read_to_string(tmp.path().join("shared.json")).unwrap(),
        "{}"
    );
}

#[test]
fn explicit_vault_overrides_the_host_without_changing_either_configuration() {
    let tmp = tempfile::tempdir().unwrap();
    let mut plugin = Plugin::new(tmp.path(), "books", None);
    let other = tmp.path().join("other-vault");
    std::fs::create_dir_all(other.join("ssot/ebooks")).unwrap();
    std::fs::write(
        other.join("ssot/ebooks/topics.yml"),
        CATALOG.replace("software", "different"),
    )
    .unwrap();
    let before = snapshot(tmp.path());
    let explicit = plugin.cli(None, json!({"list-topics":true,"vault":other}));
    assert_eq!(explicit["result"]["topics"][0]["id"], "different");
    let current = plugin.cli(None, json!({"list-topics":true}));
    assert_eq!(current["result"]["topics"][0]["id"], "software");
    assert_eq!(snapshot(tmp.path()), before);
}

fn configure_converter(root: &Path, delay_seconds: u64) -> PathBuf {
    let htmlz = root.join("fixture.htmlz");
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&htmlz).unwrap());
    zip.start_file("index.html", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(b"<html><body><h1>Local fixture</h1><p>Imported text.</p></body></html>")
        .unwrap();
    zip.finish().unwrap();
    let converter = root.join("ebook-convert");
    std::fs::write(&converter, format!("#!/bin/sh\n[ \"$1\" = \"--version\" ] && {{ echo 'calibre fixture'; exit 0; }}\nsleep {delay_seconds}\ntouch '{}'\ncp '{}' \"$2\"\n", root.join("converted").display(), htmlz.display())).unwrap();
    std::fs::set_permissions(&converter, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(
        root.join("plugin-data/device.json"),
        json!({"calibre_path":converter}).to_string(),
    )
    .unwrap();
    let file = root.join("中文 book.epub");
    std::fs::write(&file, b"input fixture").unwrap();
    file
}

#[test]
fn slow_conversion_stays_alive_and_commits_the_same_library_artifacts() {
    let tmp = tempfile::tempdir().unwrap();
    let mut plugin = Plugin::with_config(tmp.path(), "configured-books", None, false);
    std::fs::create_dir_all(plugin.vault.join("override-books")).unwrap();
    std::fs::write(plugin.vault.join("override-books/topics.yml"), CATALOG).unwrap();
    let file = configure_converter(tmp.path(), 31);
    let value = plugin.cli(
        Some(&file),
        json!({"topic":"  software  ","root":"override-books", "vault":plugin.vault}),
    );
    let result = &value["result"];
    assert_eq!(result["ocr"], false, "{value}");
    assert!(result["provider"].is_null());
    assert_eq!(result["topic_id"], "software");
    assert!(result["dest_rel"]
        .as_str()
        .unwrap()
        .starts_with("override-books/"));
    let dest = Path::new(result["dest"].as_str().unwrap());
    assert_eq!(
        plugin
            .vault
            .canonicalize()
            .unwrap()
            .join(result["dest_rel"].as_str().unwrap()),
        dest
    );
    assert!(std::fs::read_to_string(dest.join("book.typeset.md"))
        .unwrap()
        .contains("Imported text."));
    assert!(dest.join("config.txt").is_file());
    assert!(std::fs::read_to_string(dest.join("meta.yml"))
        .unwrap()
        .contains("topic_id: software"));
    assert!(plugin
        .vault
        .join("override-books/软件工程.index.md")
        .is_file());
    assert!(plugin
        .logs
        .iter()
        .any(|line| line.starts_with("Import stage:")));
    assert!(plugin
        .logs
        .iter()
        .any(|line| line == "Ebook import is still running"));
    assert!(!plugin
        .vault
        .join("configured-books/软件工程.index.md")
        .exists());
}

fn one_page_pdf() -> Vec<u8> {
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 24 24] /Contents 4 0 R /Resources << >> >>",
        "<< /Length 0 >>\nstream\n\nendstream",
    ];
    let mut bytes = b"%PDF-1.4\n".to_vec();
    let mut offsets = vec![];
    for (i, object) in objects.iter().enumerate() {
        offsets.push(bytes.len());
        bytes.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", i + 1).as_bytes());
    }
    let xref = bytes.len();
    bytes.extend_from_slice(b"xref\n0 5\n0000000000 65535 f \n");
    for offset in offsets {
        bytes.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    bytes.extend_from_slice(
        format!("trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
    );
    bytes
}

#[test]
fn ocr_cli_uses_the_local_service_and_emits_page_progress() {
    let tmp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/ocr", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut headers = String::new();
        let mut length = 0;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
            if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                length = value.trim().parse::<usize>().unwrap();
            }
            headers.push_str(&line);
        }
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        assert!(headers.starts_with("POST /ocr "));
        assert!(headers.contains("multipart/form-data"));
        assert!(body.windows(4).any(|part| part == b"\x89PNG"));
        let response =
            json!({"success":true,"content":"# Scanned fixture\n\nOCR local content."}).to_string();
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
    });
    let mut plugin = Plugin::new(tmp.path(), "books", Some(&url));
    let pdf = tmp.path().join("scanned.PDF");
    std::fs::write(&pdf, one_page_pdf()).unwrap();
    let value = plugin.cli(
        Some(&pdf),
        json!({"topic":"software","ocr":true,"ocr-provider":"wechat"}),
    );
    server.join().unwrap();
    assert_eq!(value["result"]["ocr"], true, "{value}");
    assert_eq!(value["result"]["provider"], "wechat");
    let dest = Path::new(value["result"]["dest"].as_str().unwrap());
    assert!(std::fs::read_to_string(dest.join("book.typeset.md"))
        .unwrap()
        .contains("OCR local content."));
    assert!(plugin
        .logs
        .iter()
        .any(|line| line == "Import ocr: 1/1 pages"));
}

fn seed_recovery(vault: &Path, classification: bool) -> PathBuf {
    let catalog: Value = serde_yaml::from_str(CATALOG).unwrap();
    let (relative, inventory, proposal) = if classification {
        let book = vault.join("books/2026-09/Existing");
        std::fs::create_dir_all(&book).unwrap();
        std::fs::write(
            book.join("book.typeset.md"),
            "---\ntype: Book\ntitle: Existing\n---\n",
        )
        .unwrap();
        std::fs::write(book.join("meta.yml"), "{}\n").unwrap();
        let revision = format!("sha256:{:x}", Sha256::digest(CATALOG.as_bytes()));
        (
            "topic-classification",
            json!({
                "schema_version":1,"book_count":1,"catalog_revision":revision,
                "topics":catalog["topics"],
                "books":[{"rel":"2026-09/Existing","title":"Existing","creator":null,"publisher":null,"language":null,"added_at":null,"current_topic_id":null,"evidence":{}}],
            }),
            json!({"schema_version":1,"catalog_revision":revision,"assignments":[{"book":"2026-09/Existing","topic_id":"software"}]}),
        )
    } else {
        let mut topics = catalog["topics"].as_array().unwrap().clone();
        let mut other = topics[0].clone();
        other["id"] = json!("business");
        other["label"] = json!("Business");
        other["index_file"] = json!("Business.index.md");
        topics.push(other);
        (
            "topic-design",
            json!({"schema_version":2,"book_count":0,"books":[]}),
            json!({"schema_version":1,"topics":topics,"assignments":[]}),
        )
    };
    let dir = vault.join(".notemd/ebook-import").join(relative);
    std::fs::create_dir_all(&dir).unwrap();
    let bytes = serde_json::to_vec(&inventory).unwrap();
    std::fs::write(dir.join("inventory.yml"), &bytes).unwrap();
    let mut proposal = proposal;
    proposal["inventory_sha256"] = json!(format!("{:x}", Sha256::digest(&bytes)));
    let journal = dir.join("apply-journal.json");
    std::fs::write(&journal, proposal.to_string()).unwrap();
    journal
}

#[test]
fn queries_leave_journals_untouched_and_import_recovers_before_adding_a_book() {
    for classification in [false, true] {
        let tmp = tempfile::tempdir().unwrap();
        let mut plugin = Plugin::new(tmp.path(), "books", None);
        let journal = seed_recovery(&plugin.vault, classification);
        let before = snapshot(&plugin.vault);
        let listed = plugin.cli(None, json!({"list-topics":true}));
        assert!(listed.get("result").is_some(), "{listed}");
        assert_eq!(snapshot(&plugin.vault), before);
        let file = configure_converter(tmp.path(), 0);
        let imported = plugin.cli(Some(&file), json!({"topic":"software"}));
        assert!(imported.get("result").is_some(), "{imported}");
        assert!(!journal.exists());
        assert!(tmp.path().join("converted").exists());
        if classification {
            let meta =
                std::fs::read_to_string(plugin.vault.join("books/2026-09/Existing/meta.yml"))
                    .unwrap();
            assert!(meta.contains("topic_id: software"), "{meta}");
        } else {
            assert!(plugin.vault.join("books/Business.index.md").exists());
        }
    }
}

#[test]
fn failed_journal_recovery_blocks_conversion_and_preserves_the_library() {
    for classification in [false, true] {
        let tmp = tempfile::tempdir().unwrap();
        let mut plugin = Plugin::new(tmp.path(), "books", None);
        let journal = seed_recovery(&plugin.vault, classification);
        std::fs::write(&journal, "invalid journal").unwrap();
        let file = configure_converter(tmp.path(), 0);
        let before = snapshot(&plugin.vault);
        let imported = plugin.cli(Some(&file), json!({"topic":"software"}));
        assert!(
            imported["error"]["message"]
                .as_str()
                .unwrap()
                .contains("recovery required before import"),
            "{imported}"
        );
        assert_eq!(snapshot(&plugin.vault), before);
        assert!(!tmp.path().join("converted").exists());
        assert!(!tmp.path().join("plugin-data/work").exists());
    }
}

#[test]
fn root_override_does_not_replay_another_librarys_journal() {
    for classification in [false, true] {
        let tmp = tempfile::tempdir().unwrap();
        let mut plugin = Plugin::new(tmp.path(), "books", None);
        let journal = seed_recovery(&plugin.vault, classification);
        std::fs::create_dir_all(plugin.vault.join("alternate")).unwrap();
        std::fs::write(plugin.vault.join("alternate/topics.yml"), CATALOG).unwrap();
        let file = configure_converter(tmp.path(), 0);
        let before = snapshot(&plugin.vault);
        let listed = plugin.cli(None, json!({"list-topics":true,"root":"alternate"}));
        assert!(listed.get("result").is_some());
        let imported = plugin.cli(Some(&file), json!({"topic":"software","root":"alternate"}));
        assert!(
            imported["error"]["message"]
                .as_str()
                .unwrap()
                .contains("configured ebook library"),
            "{imported}"
        );
        assert_eq!(snapshot(&plugin.vault), before);
        assert!(journal.exists());
        assert!(!tmp.path().join("converted").exists());
    }
}

#[test]
fn valid_root_override_does_not_depend_on_an_unused_invalid_saved_root() {
    let tmp = tempfile::tempdir().unwrap();
    let mut plugin = Plugin::new(tmp.path(), "books", None);
    std::fs::write(
        plugin.vault.join(".notemd/ebook-import.json"),
        json!({"ebooks_root":"../outside"}).to_string(),
    )
    .unwrap();
    let file = configure_converter(tmp.path(), 0);
    let result = plugin.cli(Some(&file), json!({"topic":"software","root":"books"}));
    assert!(result.get("result").is_some(), "{result}");
    assert!(tmp.path().join("converted").exists());
}
