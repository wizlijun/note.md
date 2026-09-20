use notemd_conversation_dictionary::model::{
    BatchCommitRequest, NormalizeFormalNamesRequest, ProposalInput, ResolveRequest,
};
use notemd_conversation_dictionary::DictionaryService;
use notemd_plugin_sdk as sdk;
use sdk::plugin_protocol as proto;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
struct State {
    vault: Option<PathBuf>,
    author: Option<String>,
    vault_checked: bool,
}

struct VaultContext {
    root: PathBuf,
    author: String,
}

pub struct ConversationDictionaryPlugin {
    state: Arc<Mutex<State>>,
}

impl ConversationDictionaryPlugin {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(State::default())),
        }
    }

    fn service(&self) -> Result<DictionaryService, String> {
        let vault = self
            .state
            .lock()
            .unwrap()
            .vault
            .clone()
            .ok_or("no Vault configured")?;
        Ok(DictionaryService::new(vault))
    }

    fn initialization_context(&self) -> Result<(DictionaryService, String), String> {
        for _ in 0..60 {
            let state = self.state.lock().unwrap();
            if state.vault_checked {
                let vault = state.vault.clone().ok_or("no Vault configured")?;
                let author = state
                    .author
                    .clone()
                    .ok_or("the current Vault author is unavailable")?;
                return Ok((DictionaryService::new(vault), author));
            }
            drop(state);
            std::thread::sleep(Duration::from_millis(50));
        }
        Err("timed out while reading the current Vault identity".into())
    }

    fn execute_cli(&self, context: &Value) -> Result<Value, String> {
        let action = cli_str(context, "action").ok_or("action is required")?;
        let service = self.service()?;
        let result = match action.as_str() {
            "status" => Ok(service.status()),
            "check" => service.check(),
            "list" => {
                let domain = cli_str(context, "domain").ok_or("--domain is required for list")?;
                service.list(&domain)
            }
            "resolve" => {
                let input = cli_str(context, "input").ok_or("--input is required for resolve")?;
                let request: ResolveRequest = read_json_input(service.vault(), &input)?;
                serde_json::to_value(service.resolve(request)?).map_err(|error| error.to_string())
            }
            "propose" => {
                let input = cli_str(context, "input").ok_or("--input is required for propose")?;
                let request: ProposalInput = read_json_input(service.vault(), &input)?;
                service.propose(request)
            }
            "pending" => service.pending(cli_str(context, "id").as_deref()),
            "dataset-check" => {
                let input =
                    cli_str(context, "input").ok_or("--input is required for dataset-check")?;
                service.dataset_check_path(&input)
            }
            "dataset-import" => {
                let input =
                    cli_str(context, "input").ok_or("--input is required for dataset-import")?;
                service.dataset_import_path(&input)
            }
            "approve" | "confirm" | "commit" | "batch-commit" => {
                Err("human approval is only available in the Conversation Dictionary window".into())
            }
            other => Err(format!("unknown action '{other}'")),
        }?;
        Ok(cli_success(&action, result))
    }
}

fn cli_success(action: &str, data: Value) -> Value {
    json!({
        "__notemd_cli_result": {
            "exit_code": 0,
            "message": format!("Conversation Dictionary {action} completed"),
            "data": data,
        }
    })
}

fn read_json_input<T: serde::de::DeserializeOwned>(vault: &Path, input: &str) -> Result<T, String> {
    let input_path = Path::new(input);
    let joined = if input_path.is_absolute() {
        input_path.to_path_buf()
    } else {
        vault.join(input_path)
    };
    let path = joined
        .canonicalize()
        .map_err(|error| format!("{}: {error}", joined.display()))?;
    let root = vault.canonicalize().map_err(|error| error.to_string())?;
    if !path.starts_with(&root) {
        return Err("input must be inside the current Vault".into());
    }
    let bytes = fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("{}: {error}", path.display()))
}

fn cli_str(context: &Value, key: &str) -> Option<String> {
    for pointer in [
        format!("/cli/args/{key}"),
        format!("/cli/flags/{key}"),
        format!("/cli/{key}"),
        format!("/{key}"),
    ] {
        if let Some(value) = context
            .pointer(&pointer)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            return Some(value.to_string());
        }
    }
    None
}

async fn vault_from_host(host: &sdk::Host) -> Option<VaultContext> {
    for attempt in 1..=3 {
        match host.request("host.vault.info", json!({})).await {
            Ok(value) => {
                let root = value
                    .get("root")
                    .and_then(Value::as_str)
                    .filter(|root| !root.is_empty());
                let author = value
                    .get("author")
                    .and_then(Value::as_str)
                    .filter(|author| author.starts_with("human:") && author.len() > 6);
                if let (Some(root), Some(author)) = (root, author) {
                    return Some(VaultContext {
                        root: PathBuf::from(root),
                        author: author.to_string(),
                    });
                }
            }
            Err(error) => {
                host.log_warn(&format!("host.vault.info failed (try {attempt}): {error}"))
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    None
}

fn shared_config_vault() -> Option<PathBuf> {
    let path = std::env::var("NOTEMD_SHARED_CONFIG")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|home| home.join("Library/Application Support/net.notemd.app/shared.json"))
        })?;
    let value: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    value
        .get("sotvault")
        .and_then(Value::as_str)
        .filter(|root| !root.is_empty())
        .map(PathBuf::from)
}

impl sdk::NotemdPlugin for ConversationDictionaryPlugin {
    fn activate(&mut self, host: &sdk::Host, params: &proto::ActivateParams) -> Result<(), String> {
        let seeded = shared_config_vault();
        if params.event.starts_with("onCli:") {
            let mut state = self.state.lock().unwrap();
            state.vault = seeded;
            state.author = None;
            state.vault_checked = true;
            return Ok(());
        }
        if let Some(vault) = &seeded {
            self.state.lock().unwrap().vault = Some(vault.clone());
        }
        let state = self.state.clone();
        let host = host.clone();
        tokio::spawn(async move {
            let resolved = vault_from_host(&host).await;
            let mut state = state.lock().unwrap();
            if let Some(context) = resolved {
                state.vault = Some(context.root);
                state.author = Some(context.author);
            } else if state.vault.is_none() {
                state.vault = seeded;
            }
            state.vault_checked = true;
        });
        Ok(())
    }

    fn deactivate(&mut self, _host: &sdk::Host) {}

    fn execute_command(
        &mut self,
        _host: &sdk::Host,
        params: &proto::ExecuteCommandParams,
    ) -> Result<Value, String> {
        if params.command != "conversation-dictionary" {
            return Err(format!("unknown command '{}'", params.command));
        }
        self.execute_cli(&params.context)
    }

    fn on_ui_request(
        &mut self,
        _host: &sdk::Host,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let method = method.strip_prefix("plugin.").unwrap_or(method);
        if method == "initialize" {
            let (service, author) = self.initialization_context()?;
            return service.ensure_initialized(&author);
        }
        let service = self.service()?;
        match method {
            "bootstrap" => service.bootstrap(),
            "dataset_check" => {
                let input = params
                    .get("input")
                    .and_then(Value::as_str)
                    .ok_or("input is required")?;
                service.dataset_check_path(input)
            }
            "dataset_import" => {
                let input = params
                    .get("input")
                    .and_then(Value::as_str)
                    .ok_or("input is required")?;
                service.dataset_import_path(input)
            }
            "batch_commit" => {
                let request: BatchCommitRequest =
                    serde_json::from_value(params).map_err(|error| error.to_string())?;
                service.batch_commit(request)
            }
            "normalize_formal_names" => {
                let request: NormalizeFormalNamesRequest =
                    serde_json::from_value(params).map_err(|error| error.to_string())?;
                service.normalize_formal_names(request)
            }
            "batch_evidence" => {
                let run_id = params
                    .get("run_id")
                    .and_then(Value::as_str)
                    .ok_or("run_id is required")?;
                let proposal_id = params
                    .get("proposal_id")
                    .and_then(Value::as_str)
                    .ok_or("proposal_id is required")?;
                service.batch_evidence(run_id, proposal_id)
            }
            "candidate_dismiss" => {
                Err("candidate decisions are not part of the first implementation slice".into())
            }
            "open_dictionary" => Ok(json!({
                "path": notemd_conversation_dictionary::storage::dictionary_path(service.vault())?
                    .strip_prefix(service.vault()).unwrap_or(Path::new(""))
                    .to_string_lossy()
            })),
            other => Err(format!("unknown UI method '{other}'")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_action_is_read_from_the_declared_positional_argument() {
        let context = json!({"cli":{"args":{"action":"status"},"flags":{"domain":"d_work"}}});
        assert_eq!(cli_str(&context, "action").as_deref(), Some("status"));
        assert_eq!(cli_str(&context, "domain").as_deref(), Some("d_work"));
    }

    #[test]
    fn manifest_matches_current_protocol_and_host() {
        let manifest: proto::ManifestV2 =
            serde_json::from_str(include_str!("../../manifest.v2.json")).unwrap();
        proto::validate_manifest(&manifest, "6.916.1").unwrap();
    }
}
