//! Credentials stay in the macOS Keychain. HTTP clients never follow redirects.
use crate::providers::{HttpResponse, Transport};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use fs2::FileExt;
use rand::RngCore;
use reqwest::{
    blocking::{Client, Response},
    redirect::Policy,
    Url,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const SERVICE: &str = "net.notemd.health-sync";
const OURA_TOKEN: &str = "https://api.ouraring.com/oauth/token";
const GARMIN_TOKEN_PATH: &str = "/personalapitoken-service/personal-api/personal-api-key/token";
const JSON_LIMIT: u64 = 64 * 1024 * 1024;
const ZIP_LIMIT: u64 = 256 * 1024 * 1024;
const TOKEN_LIMIT: u64 = 128 * 1024;
const CALLBACK_LIMIT: usize = 8192;
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);

/// Garmin accounts and credentials are isolated between the two official regions.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GarminRegion {
    #[default]
    Global,
    China,
}
impl GarminRegion {
    fn from_params(params: &Value) -> Result<Self, String> {
        match params.get("region") {
            None => Ok(Self::Global),
            Some(value) => serde_json::from_value(value.clone())
                .map_err(|_| "Garmin region must be global or china".into()),
        }
    }
    fn base_url(self) -> &'static str {
        match self {
            Self::Global => "https://personal.connectapi.garmin.com",
            Self::China => "https://personal.connectapi.garmin.cn",
        }
    }
    fn scope_subject(self, subject: String) -> String {
        if self == Self::China {
            subject.replacen("garmin:", "garmin:china:", 1)
        } else {
            subject
        }
    }
    fn from_subject(subject: &str) -> Self {
        if subject.starts_with("garmin:china:") {
            Self::China
        } else {
            Self::Global
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "lowercase")]
enum Credential {
    Garmin {
        api_key: String,
        #[serde(default)]
        region: GarminRegion,
    },
    Oura {
        client_id: String,
        client_secret: String,
        redirect_uri: String,
        access_token: String,
        refresh_token: String,
        expires_at: u64,
    },
}

trait SecretStore {
    fn get(&self, account: &str) -> Result<Option<Credential>, String>;
    fn set(&self, account: &str, credential: &Credential) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}
struct Keychain;
#[cfg(target_os = "macos")]
impl SecretStore for Keychain {
    fn get(&self, account: &str) -> Result<Option<Credential>, String> {
        match security_framework::passwords::get_generic_password(SERVICE, account) {
            Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|_| {
                "Health credentials in Keychain are invalid; reconnect the provider".into()
            }),
            Err(error) if error.code() == -25300 => Ok(None),
            Err(_) => Err("Cannot read health credentials from macOS Keychain".into()),
        }
    }
    fn set(&self, account: &str, credential: &Credential) -> Result<(), String> {
        let bytes =
            serde_json::to_vec(credential).map_err(|_| "Cannot encode health credentials")?;
        security_framework::passwords::set_generic_password(SERVICE, account, &bytes)
            .map_err(|_| "Cannot save health credentials to macOS Keychain".into())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        match security_framework::passwords::delete_generic_password(SERVICE, account) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == -25300 => Ok(()),
            Err(_) => Err("Cannot remove health credentials from macOS Keychain".into()),
        }
    }
}
#[cfg(not(target_os = "macos"))]
impl SecretStore for Keychain {
    fn get(&self, _: &str) -> Result<Option<Credential>, String> {
        Err("Health provider authentication requires macOS Keychain".into())
    }
    fn set(&self, _: &str, _: &Credential) -> Result<(), String> {
        Err("Health provider authentication requires macOS Keychain".into())
    }
    fn delete(&self, _: &str) -> Result<(), String> {
        Err("Health provider authentication requires macOS Keychain".into())
    }
}

#[derive(Clone)]
struct Pending {
    state: String,
    pending: bool,
    error: Option<String>,
}
static PENDING: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn source_name(source: &str) -> Result<(), String> {
    if matches!(source, "garmin" | "oura") {
        Ok(())
    } else {
        Err("Provider must be garmin or oura".into())
    }
}
fn identity(vault: &Path, source: &str) -> Result<(PathBuf, String, String), String> {
    source_name(source)?;
    let canonical = fs::canonicalize(vault).map_err(|_| "Cannot resolve health vault")?;
    if !canonical.is_dir() {
        return Err("Health vault must be a directory".into());
    }
    let hash = format!(
        "{:x}",
        Sha256::digest(canonical.as_os_str().as_encoded_bytes())
    );
    Ok((canonical, format!("{hash}-{source}"), hash))
}
fn state_directory(hash: &str, source: &str) -> Result<PathBuf, String> {
    source_name(source)?;
    let dir = crate::store::default_state_base()?.join(hash);
    safe_state_path(&dir)?;
    Ok(dir)
}
fn safe_state_path(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("Authentication state must not contain symbolic links".into())
            }
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err("Cannot inspect authentication state path".into())
            }
            _ => {}
        }
    }
    Ok(())
}
fn auth_lock(hash: &str, source: &str) -> Result<File, String> {
    let dir = state_directory(hash, source)?;
    fs::create_dir_all(&dir).map_err(|_| "Cannot create local authentication lock directory")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot protect authentication lock directory")?;
    }
    let path = dir.join(format!("{source}-auth.lock"));
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Authentication lock must not be a symbolic link".into());
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|_| "Cannot open authentication lock")?;
    file.lock_exclusive()
        .map_err(|_| "Cannot lock provider authentication")?;
    Ok(file)
}

/// Non-secret state persists independently from credentials: disconnect must
/// invalidate callbacks in other processes and must never erase account binding.
#[derive(Clone, Serialize, Deserialize)]
struct AuthorizationState {
    epoch: String,
    subject: Option<String>,
    #[serde(default)]
    authorized: bool,
}
fn state_path(hash: &str, source: &str) -> Result<PathBuf, String> {
    Ok(state_directory(hash, source)?.join(format!("{source}-authorization.json")))
}
fn read_state(path: &Path) -> Result<Option<AuthorizationState>, String> {
    safe_state_path(path)?;
    let file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot read authorization state".into()),
    };
    let mut bytes = vec![];
    file.take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read authorization state")?;
    if bytes.len() > 65536 {
        return Err("Invalid authorization state size".into());
    }
    let state: AuthorizationState =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid authorization state")?;
    if state.epoch.len() != 43
        || !state
            .epoch
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        || state
            .subject
            .as_ref()
            .is_some_and(|s| s.len() > 256 || s.chars().any(char::is_control))
    {
        return Err("Invalid authorization state".into());
    }
    Ok(Some(state))
}
fn write_state(path: &Path, state: &impl Serialize) -> Result<(), String> {
    safe_state_path(path)?;
    let parent = path.parent().ok_or("Invalid authorization state path")?;
    let mut temp =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "Cannot stage authorization state")?;
    serde_json::to_writer(&mut temp, state).map_err(|_| "Cannot encode authorization state")?;
    temp.as_file()
        .sync_all()
        .map_err(|_| "Cannot persist authorization state")?;
    temp.persist(path)
        .map_err(|_| "Cannot replace authorization state")?;
    File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|_| "Cannot persist authorization directory".into())
}
fn epoch_matches(path: &Path, epoch: &str) -> Result<AuthorizationState, String> {
    read_state(path)?
        .filter(|s| s.epoch == epoch)
        .ok_or_else(|| {
            "Provider authorization was cancelled or replaced; reconnect or retry".into()
        })
}
fn active_state(path: &Path) -> Result<AuthorizationState, String> {
    read_state(path)?
        .filter(|s| s.authorized && s.subject.is_some())
        .ok_or_else(|| "Complete provider authorization before syncing".into())
}
fn integer_id(value: &Value) -> Option<String> {
    match value {
        Value::Number(v) => v.as_u64().filter(|n| *n > 0).map(|n| n.to_string()),
        Value::String(v) if !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()) => v
            .parse::<u64>()
            .ok()
            .filter(|n| *n > 0)
            .map(|n| n.to_string()),
        _ => None,
    }
}
fn response_subject(source: &str, collection: &str, body: &Value) -> Option<String> {
    if source == "oura" && collection == "personal_info" {
        return body["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 200 && !id.chars().any(char::is_control))
            .map(|id| format!("oura:{id}"));
    }
    if source != "garmin" {
        return None;
    }
    let id = match collection {
        "daily_summary_legacy" => integer_id(&body["userProfileId"]),
        "daily_summaries" => body["data"].as_array().and_then(|items| {
            items
                .iter()
                .find_map(|item| integer_id(&item["userProfilePk"]))
        }),
        "activities" => integer_id(&body["ownerId"]),
        "activity_details" => integer_id(&body["userProfileId"]),
        "heart_rate" | "sleep" => integer_id(&body["userProfilePK"]),
        "hrv" => integer_id(&body["userProfilePk"]),
        _ => None,
    }?;
    Some(format!("garmin:{id}"))
}
fn archived_subject(vault: &Path, source: &str, required: bool) -> Result<Option<String>, String> {
    let store = crate::store::Store::new(vault, &crate::store::default_state_base()?)?;
    let Some(manifest) = store.manifest()? else {
        return Ok(None);
    };
    if !manifest.sources.contains_key(source) || !manifest.sources[source].accounts.is_empty() {
        // Account-scoped archives must never be collapsed into one provider owner.
        return Ok(None);
    }
    let collections: &[&str] = if source == "oura" {
        &["personal_info"]
    } else {
        &[
            "daily_summary_legacy",
            "activities",
            "daily_summaries",
            "heart_rate",
            "sleep",
            "hrv",
            "activity_details",
        ]
    };
    let region = manifest.sources[source].garmin_region.unwrap_or_default();
    let mut found = None;
    for collection in collections {
        let metric = format!("{source}.{collection}");
        let result = store.query_filtered(
            crate::store::QueryFilter {
                metric: Some(&metric),
                source: Some(source),
                ..Default::default()
            },
            1,
            0,
        )?;
        if let Some(subject) = result["records"]
            .as_array()
            .and_then(|rows| rows.first())
            .and_then(|record| response_subject(source, collection, &record["payload"]))
        {
            let subject = if source == "garmin" {
                region.scope_subject(subject)
            } else {
                subject
            };
            if found.as_ref().is_some_and(|old| old != &subject) {
                return Err(
                    "Existing health archive contains conflicting provider account identifiers"
                        .into(),
                );
            }
            found = Some(subject);
        }
    }
    if found.is_none() && required {
        return Err("Cannot confirm the account identity of this vault's existing provider data. Use a new vault or restore an archive containing a verified provider user ID; existing data was preserved".into());
    }
    Ok(found)
}
/// Non-secret account catalog; credentials remain in separate Keychain slots.
#[derive(Clone, Serialize, Deserialize)]
struct AccountCatalog {
    schema_version: u32,
    active_account_id: Option<String>,
    active_epoch: String,
    accounts: BTreeMap<String, SavedAccount>,
    authorization_id: Option<String>,
    #[serde(default)]
    authorization_deadline: Option<u64>,
    completed_account_id: Option<String>,
    pending: bool,
    error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct SavedAccount {
    subject: String,
    label: String,
    #[serde(default)]
    legacy: bool,
}
pub fn account_id_for_subject(subject: &str) -> String {
    format!("{:x}", Sha256::digest(subject.as_bytes()))
}
fn catalog_path(hash: &str, source: &str) -> Result<PathBuf, String> {
    Ok(state_directory(hash, source)?.join(format!("{source}-accounts.json")))
}
fn pending_path(hash: &str, source: &str) -> Result<PathBuf, String> {
    Ok(state_directory(hash, source)?.join(format!("{source}-pending-authorization.json")))
}
fn account_state_path(
    hash: &str,
    source: &str,
    id: &str,
    entry: &SavedAccount,
) -> Result<PathBuf, String> {
    if entry.legacy {
        state_path(hash, source)
    } else {
        Ok(state_directory(hash, source)?.join(format!("{source}-{id}-authorization.json")))
    }
}
fn credential_slot(hash: &str, source: &str, id: &str, entry: &SavedAccount) -> String {
    if entry.legacy {
        format!("{hash}-{source}")
    } else {
        format!("{hash}-{source}-{id}")
    }
}
fn valid_account_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn default_label(source: &str, subject: &str, id: &str) -> String {
    let region = if source == "garmin" {
        match GarminRegion::from_subject(subject) {
            GarminRegion::Global => " Global",
            GarminRegion::China => " China",
        }
    } else {
        ""
    };
    format!("{source}{region} · {}", &id[..8])
}
fn connection_label(params: &Value) -> Result<Option<String>, String> {
    match params.get("label") {
        None => Ok(None),
        Some(Value::String(label))
            if !label.trim().is_empty()
                && label.len() <= 128
                && !label.chars().any(char::is_control) =>
        {
            Ok(Some(label.trim().to_owned()))
        }
        _ => Err("Account label must be 1..128 bytes without control characters".into()),
    }
}
fn read_catalog(path: &Path) -> Result<Option<AccountCatalog>, String> {
    safe_state_path(path)?;
    let file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot read provider accounts".into()),
    };
    let mut bytes = vec![];
    file.take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read provider accounts")?;
    if bytes.len() > 65536 {
        return Err("Invalid provider accounts size".into());
    }
    let mut catalog: AccountCatalog =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid provider accounts")?;
    let valid_epoch = |epoch: &str| {
        epoch.len() == 43
            && epoch
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    if catalog.schema_version != 1
        || !valid_epoch(&catalog.active_epoch)
        || catalog.accounts.len() > 64
        || catalog.accounts.values().filter(|a| a.legacy).count() > 1
        || catalog.accounts.iter().any(|(id, entry)| {
            !valid_account_id(id)
                || account_id_for_subject(&entry.subject) != *id
                || entry.subject.len() > 256
                || entry.subject.chars().any(char::is_control)
                || entry.label.is_empty()
                || entry.label.len() > 128
                || entry.label.chars().any(char::is_control)
        })
        || catalog
            .active_account_id
            .as_ref()
            .is_some_and(|id| !catalog.accounts.contains_key(id))
        || catalog
            .completed_account_id
            .as_ref()
            .is_some_and(|id| !catalog.accounts.contains_key(id))
        || catalog
            .authorization_id
            .as_ref()
            .is_some_and(|epoch| !valid_epoch(epoch))
        || (catalog.pending && catalog.authorization_id.is_none())
    {
        return Err("Invalid provider accounts".into());
    }
    if catalog.pending
        && catalog
            .authorization_deadline
            .is_none_or(|deadline| now().is_ok_and(|time| time >= deadline))
    {
        catalog.pending = false;
        catalog.error = Some("Provider authorization expired; reconnect".into());
    }
    Ok(Some(catalog))
}
/// Must hold auth_lock. Migration retains the old Keychain/state slots, avoiding
/// a copy/delete transaction and never reactivating a disconnected credential.
fn account_catalog(vault: &Path, hash: &str, source: &str) -> Result<AccountCatalog, String> {
    let path = catalog_path(hash, source)?;
    if let Some(catalog) = read_catalog(&path)? {
        return Ok(catalog);
    }
    let old = read_state(&state_path(hash, source)?)?;
    let old_subject = old.as_ref().and_then(|state| state.subject.clone());
    // Unknown legacy ownership remains unassigned; the store refuses to replace it.
    let archived = archived_subject(vault, source, false)?;
    if old_subject
        .as_ref()
        .zip(archived.as_ref())
        .is_some_and(|(a, b)| a != b)
    {
        return Err("Provider account binding disagrees with existing health data".into());
    }
    let mut catalog = AccountCatalog {
        schema_version: 1,
        active_account_id: None,
        active_epoch: random_string(32),
        accounts: BTreeMap::new(),
        authorization_id: None,
        authorization_deadline: None,
        completed_account_id: None,
        pending: false,
        error: None,
    };
    if let Some(subject) = old_subject.or(archived) {
        let id = account_id_for_subject(&subject);
        let entry = SavedAccount {
            label: default_label(source, &subject, &id),
            subject: subject.clone(),
            legacy: true,
        };
        if old.is_none() {
            write_state(
                &state_path(hash, source)?,
                &AuthorizationState {
                    epoch: random_string(32),
                    subject: Some(subject),
                    authorized: false,
                },
            )?;
        }
        catalog.active_account_id = Some(id.clone());
        catalog.accounts.insert(id, entry);
    }
    write_state(&path, &catalog)?;
    Ok(catalog)
}
fn verified_legacy_account_id(
    vault: &Path,
    source: &str,
    catalog: &AccountCatalog,
) -> Result<Option<String>, String> {
    let local = catalog
        .accounts
        .iter()
        .find(|(_, entry)| entry.legacy)
        .map(|(id, _)| id.clone());
    let archived =
        archived_subject(vault, source, false)?.map(|subject| account_id_for_subject(&subject));
    if local
        .as_ref()
        .zip(archived.as_ref())
        .is_some_and(|(a, b)| a != b)
    {
        return Err("Legacy provider account binding disagrees with existing health data".into());
    }
    Ok(local.or(archived))
}
fn begin_connection(vault: &Path, hash: &str, source: &str) -> Result<String, String> {
    let _lock = auth_lock(hash, source)?;
    let mut catalog = account_catalog(vault, hash, source)?;
    let epoch = random_string(32);
    write_state(
        &pending_path(hash, source)?,
        &AuthorizationState {
            epoch: epoch.clone(),
            subject: None,
            authorized: false,
        },
    )?;
    catalog.authorization_id = Some(epoch.clone());
    // Include the bounded token/identity exchange after the callback deadline.
    catalog.authorization_deadline = Some(now()?.saturating_add(CALLBACK_TIMEOUT.as_secs() + 120));
    catalog.completed_account_id = None;
    catalog.pending = true;
    catalog.error = None;
    write_state(&catalog_path(hash, source)?, &catalog)?;
    Ok(epoch)
}
struct VerifiedConnection<'a> {
    subject: &'a str,
    credential: &'a Credential,
    label: Option<&'a str>,
}
fn complete_connection(
    store: &dyn SecretStore,
    vault: &Path,
    hash: &str,
    source: &str,
    epoch: &str,
    verified: VerifiedConnection<'_>,
) -> Result<String, String> {
    let VerifiedConnection {
        subject,
        credential,
        label,
    } = verified;
    // Caller holds the provider auth lock across credential/state/catalog writes.
    epoch_matches(&pending_path(hash, source)?, epoch)?;
    let mut catalog = account_catalog(vault, hash, source)?;
    if !catalog.pending || catalog.authorization_id.as_deref() != Some(epoch) {
        return Err("Provider authorization was cancelled or replaced; reconnect or retry".into());
    }
    let id = account_id_for_subject(subject);
    if !catalog.accounts.contains_key(&id) && catalog.accounts.len() >= 64 {
        return Err("At most 64 accounts can be saved per provider".into());
    }
    let mut entry = catalog
        .accounts
        .get(&id)
        .cloned()
        .unwrap_or_else(|| SavedAccount {
            subject: subject.into(),
            label: default_label(source, subject, &id),
            legacy: false,
        });
    if let Some(label) = label {
        entry.label = label.into();
    }
    let path = account_state_path(hash, source, &id, &entry)?;
    write_state(
        &path,
        &AuthorizationState {
            epoch: epoch.into(),
            subject: Some(subject.into()),
            authorized: false,
        },
    )?;
    save_authorized(
        store,
        &credential_slot(hash, source, &id, &entry),
        &path,
        epoch,
        subject,
        credential,
    )?;
    catalog.accounts.insert(id.clone(), entry);
    if catalog.active_account_id.is_none() {
        catalog.active_account_id = Some(id.clone());
        catalog.active_epoch = random_string(32);
    }
    catalog.pending = false;
    catalog.completed_account_id = Some(id.clone());
    catalog.error = None;
    write_state(&catalog_path(hash, source)?, &catalog)?;
    Ok(id)
}
fn connection_failed(hash: &str, source: &str, epoch: &str, error: &str) {
    let Ok(_lock) = auth_lock(hash, source) else {
        return;
    };
    let Ok(path) = catalog_path(hash, source) else {
        return;
    };
    let Ok(Some(mut catalog)) = read_catalog(&path) else {
        return;
    };
    if catalog.authorization_id.as_deref() == Some(epoch) {
        catalog.pending = false;
        catalog.error = Some(error.into());
        let _ = write_state(&path, &catalog);
    }
}
fn save_authorized(
    store: &dyn SecretStore,
    account: &str,
    path: &Path,
    epoch: &str,
    subject: &str,
    credential: &Credential,
) -> Result<(), String> {
    let mut state = epoch_matches(path, epoch)?;
    if let Credential::Garmin { region, .. } = credential {
        if !subject.starts_with("garmin:") || GarminRegion::from_subject(subject) != *region {
            return Err("Garmin credential region disagrees with the verified account".into());
        }
    }
    if state
        .subject
        .as_deref()
        .is_some_and(|previous| previous != subject)
    {
        return Err("This vault is bound to a different provider account. Use a separate vault; existing credentials and data were preserved".into());
    }
    state.subject = Some(subject.into());
    // Bind before granting credential use. A Keychain write failure leaves a
    // conservative binding rather than credentials without an identity guard.
    state.authorized = false;
    write_state(path, &state)?;
    store.set(account, credential)?;
    state.authorized = true;
    write_state(path, &state)
}
fn identity_json(
    http: &Client,
    token: &str,
    source: &str,
    region: GarminRegion,
    path: &str,
    query: &[(&str, String)],
) -> Result<Value, String> {
    let response = http
        .get(data_url(source, region, path)?)
        .query(query)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .send()
        .map_err(|_| "Cannot verify provider account identity")?;
    match response.status().as_u16() {
        204 | 403 | 404 => Ok(Value::Null),
        200 => serde_json::from_slice(&read_limited(response, JSON_LIMIT)?)
            .map_err(|_| "Invalid provider identity response".into()),
        status => Err(format!(
            "Cannot verify provider account identity (HTTP {status})"
        )),
    }
}
fn verified_subject(
    http: &Client,
    token: &str,
    source: &str,
    region: GarminRegion,
) -> Result<String, String> {
    if source == "oura" {
        let body = identity_json(
            http,
            token,
            source,
            region,
            "/v2/usercollection/personal_info",
            &[],
        )?;
        return response_subject(source, "personal_info", &body).ok_or_else(|| {
            "Cannot verify Oura account ID; grant personal information access and reconnect".into()
        });
    }
    let body = identity_json(
        http,
        token,
        source,
        region,
        "/usersummary-service/usersummary/daily",
        &[(
            "calendarDate",
            chrono::Local::now().format("%Y-%m-%d").to_string(),
        )],
    )?;
    if let Some(subject) = response_subject(source, "daily_summary_legacy", &body) {
        return Ok(region.scope_subject(subject));
    }
    // A user may have no data today. An existing activity still identifies its
    // owner, independently of API-key rotation and mutable display names.
    let activities = identity_json(
        http,
        token,
        source,
        region,
        "/activitylist-service/activities/search/activities",
        &[("start", "0".into()), ("limit", "1".into())],
    )?;
    activities.as_array().and_then(|items| items.first()).and_then(|row| response_subject(source, "activities", row))
        .map(|subject| region.scope_subject(subject))
        .ok_or_else(|| "Cannot verify Garmin account ID from daily data or an existing activity; no credentials were activated".into())
}
fn http_client() -> Result<Client, String> {
    Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(15))
        .user_agent("note.md-health-sync/0.1")
        .build()
        .map_err(|_| "Cannot create health HTTP client".into())
}
fn now() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|_| "System clock is invalid".into())
}
fn field(params: &Value, name: &str) -> Result<String, String> {
    params
        .get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.len() <= 8192 && !s.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or_else(|| format!("Missing or invalid {name}"))
}
fn read_limited(mut response: Response, limit: u64) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err("Provider response exceeds the size limit".into());
    }
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read provider response")?;
    if bytes.len() as u64 > limit {
        return Err("Provider response exceeds the size limit".into());
    }
    Ok(bytes)
}
fn garmin_token_request(
    http: &Client,
    api_key: &str,
    region: GarminRegion,
) -> Result<reqwest::blocking::RequestBuilder, String> {
    Ok(http
        .post(data_url("garmin", region, GARMIN_TOKEN_PATH)?)
        .header("Authorization", format!("ApiKey {api_key}"))
        .header("Accept", "*/*"))
}
fn garmin_token(http: &Client, api_key: &str, region: GarminRegion) -> Result<String, String> {
    let response = garmin_token_request(http, api_key, region)?
        .send()
        .map_err(|_| "Garmin token exchange could not reach the server")?;
    if !response.status().is_success() {
        return Err(format!(
            "Garmin token exchange failed (HTTP {})",
            response.status().as_u16()
        ));
    }
    let bytes = read_limited(response, TOKEN_LIMIT)?;
    let token = std::str::from_utf8(&bytes)
        .map_err(|_| "Garmin token response is invalid")?
        .trim();
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3
        || parts.iter().any(|s| {
            s.is_empty()
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
    {
        return Err("Garmin token response is not a JWT".into());
    }
    Ok(token.into())
}

fn redirect(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Invalid Oura redirect_uri")?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() == Some(0)
        || url.path().contains('%')
    {
        return Err("Oura redirect_uri must be a registered HTTP loopback URL on 127.0.0.1 or localhost, without credentials, query or fragment".into());
    }
    Ok(url)
}
fn random_string(bytes: usize) -> String {
    let mut input = vec![0; bytes];
    rand::rng().fill_bytes(&mut input);
    URL_SAFE_NO_PAD.encode(input)
}
fn authorize_url(client_id: &str, redirect_uri: &str, state: &str, verifier: &str) -> String {
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut url = Url::parse("https://cloud.ouraring.com/oauth/authorize").unwrap();
    url.query_pairs_mut().extend_pairs([
        ("response_type", "code"),
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        (
            "scope",
            "personal daily heartrate workout tag session spo2 heart_health",
        ),
        ("state", state),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
    ]);
    url.into()
}

pub fn connect(vault: &Path, source: &str, params: &Value) -> Result<Value, String> {
    let (vault, account, hash) = identity(vault, source)?;
    let label = connection_label(params)?;
    if source == "garmin" {
        let api_key = field(params, "api_key")?;
        let region = GarminRegion::from_params(params)?;
        let epoch = begin_connection(&vault, &hash, source)?;
        let result = (|| {
            let http = http_client()?;
            let token = garmin_token(&http, &api_key, region)?;
            let subject = verified_subject(&http, &token, source, region)?;
            let _lock = auth_lock(&hash, source)?;
            complete_connection(
                &Keychain,
                &vault,
                &hash,
                source,
                &epoch,
                VerifiedConnection {
                    subject: &subject,
                    credential: &Credential::Garmin { api_key, region },
                    label: label.as_deref(),
                },
            )
        })();
        return match result {
            Ok(id) => Ok(
                json!({"source":"garmin","region":region,"connected":true,"pending":false,"generation":epoch,"authorization_id":epoch,"completed_account_id":id,"account_id":id}),
            ),
            Err(error) => {
                connection_failed(&hash, source, &epoch, &error);
                Err(error)
            }
        };
    }
    let client_id = field(params, "client_id")?;
    let client_secret = field(params, "client_secret")?;
    let redirect_uri = match params.get("redirect_uri") {
        None | Some(Value::Null) => "http://127.0.0.1:8765/callback".into(),
        _ => field(params, "redirect_uri")?,
    };
    let url = redirect(&redirect_uri)?;
    // Bind before starting an attempt, so a busy port cannot cancel another sign-in.
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, url.port_or_known_default().unwrap())).map_err(|_| "Cannot listen on the registered Oura loopback port; close another sign-in attempt or choose another registered port")?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "Cannot configure Oura callback listener")?;
    let epoch = begin_connection(&vault, &hash, source)?;
    let authorization_path = pending_path(&hash, source)?;
    let state = random_string(32);
    let verifier = random_string(64);
    let authorize = authorize_url(&client_id, &redirect_uri, &state, &verifier);
    pending()
        .lock()
        .map_err(|_| "Authentication state is unavailable")?
        .insert(
            account.clone(),
            Pending {
                state: state.clone(),
                pending: true,
                error: None,
            },
        );
    let authorization_id = epoch.clone();
    thread::spawn(move || {
        let result = receive_authorization(
            listener,
            &url,
            &state,
            &account,
            &authorization_path,
            &epoch,
        )
        .and_then(|code| {
            let http = http_client()?;
            let tokens = token_request(
                &http,
                &[
                    ("grant_type", "authorization_code"),
                    ("code", &code),
                    ("redirect_uri", &redirect_uri),
                    ("client_id", &client_id),
                    ("client_secret", &client_secret),
                    ("code_verifier", &verifier),
                ],
            )?;
            let credential = token_credential(&client_id, &client_secret, &redirect_uri, &tokens)?;
            let subject = verified_subject(
                &http,
                &field(&tokens, "access_token")?,
                "oura",
                GarminRegion::Global,
            )?;
            let _lock = auth_lock(&hash, "oura")?;
            let states = pending()
                .lock()
                .map_err(|_| "Authentication state is unavailable")?;
            if !states
                .get(&account)
                .is_some_and(|p| p.pending && p.state == state)
            {
                return Err("Oura authorization was cancelled".into());
            }
            complete_connection(
                &Keychain,
                &vault,
                &hash,
                "oura",
                &epoch,
                VerifiedConnection {
                    subject: &subject,
                    credential: &credential,
                    label: label.as_deref(),
                },
            )
        });
        if let Err(error) = &result {
            connection_failed(&hash, "oura", &epoch, error);
        }
        if let Ok(mut states) = pending().lock() {
            if let Some(current) = states.get_mut(&account).filter(|p| p.state == state) {
                current.pending = false;
                current.error = result.err();
            }
        }
    });
    Ok(
        json!({"source":"oura","authorize_url":authorize,"pending":true,"authorization_id":authorization_id}),
    )
}

fn token_request(http: &Client, form: &[(&str, &str)]) -> Result<Value, String> {
    // Never retry an OAuth token POST: refresh tokens are single-use and a lost
    // response may already have invalidated the old token.
    let response =
        http.post(OURA_TOKEN).form(form).send().map_err(|_| {
            "Oura token exchange was interrupted; reconnect if refresh no longer works"
        })?;
    if !response.status().is_success() {
        return Err(format!(
            "Oura token exchange failed (HTTP {}); reconnect if authorization expired",
            response.status().as_u16()
        ));
    }
    serde_json::from_slice(&read_limited(response, TOKEN_LIMIT)?)
        .map_err(|_| "Oura token response is invalid".into())
}
fn token_credential(
    client_id: &str,
    client_secret: &str,
    redirect_uri: &str,
    tokens: &Value,
) -> Result<Credential, String> {
    let access_token = field(tokens, "access_token")?;
    let refresh_token = field(tokens, "refresh_token")?;
    if tokens
        .get("token_type")
        .and_then(Value::as_str)
        .is_none_or(|kind| !kind.eq_ignore_ascii_case("bearer"))
    {
        return Err("Oura returned an unsupported token type".into());
    }
    let seconds = tokens
        .get("expires_in")
        .and_then(Value::as_u64)
        .filter(|v| *v > 0)
        .ok_or("Oura token expiry is invalid")?;
    let expires_at = now()?
        .checked_add(seconds)
        .ok_or("Oura token expiry is invalid")?;
    Ok(Credential::Oura {
        client_id: client_id.into(),
        client_secret: client_secret.into(),
        redirect_uri: redirect_uri.into(),
        access_token,
        refresh_token,
        expires_at,
    })
}

fn same_state(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}
enum Callback {
    Code(String),
    Denied,
}
fn callback(request: &str, redirect: &Url, expected_state: &str) -> Result<Callback, String> {
    if request.len() > CALLBACK_LIMIT {
        return Err("Callback request is too large".into());
    }
    let first = request.lines().next().ok_or("Missing callback request")?;
    let parts: Vec<_> = first.split_ascii_whitespace().collect();
    if parts.len() != 3
        || parts[0] != "GET"
        || !matches!(parts[2], "HTTP/1.0" | "HTTP/1.1")
        || !parts[1].starts_with('/')
        || parts[1].starts_with("//")
    {
        return Err("Invalid callback request".into());
    }
    let target =
        Url::parse(&format!("http://127.0.0.1{}", parts[1])).map_err(|_| "Invalid callback URL")?;
    if target.path() != redirect.path() || target.fragment().is_some() {
        return Err("Unexpected callback path".into());
    }
    let mut params = HashMap::new();
    for (k, v) in target.query_pairs() {
        if params.insert(k.into_owned(), v.into_owned()).is_some() {
            return Err("Duplicate callback parameter".into());
        }
    }
    if !params
        .get("state")
        .is_some_and(|s| same_state(s, expected_state))
    {
        return Err("Invalid callback state".into());
    }
    if params.contains_key("error") {
        return Ok(Callback::Denied);
    }
    let code = params
        .remove("code")
        .filter(|s| !s.is_empty() && s.len() <= 4096 && !s.chars().any(char::is_control))
        .ok_or("Missing callback code")?;
    Ok(Callback::Code(code))
}
fn callback_request(stream: &mut TcpStream, deadline: Instant) -> Result<String, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| "Cannot configure callback")?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| "Cannot configure callback")?;
    let mut bytes = Vec::new();
    let mut chunk = [0; 1024];
    loop {
        if Instant::now() >= deadline {
            return Err("Callback request timed out".into());
        }
        let n = stream
            .read(&mut chunk)
            .map_err(|_| "Incomplete callback request")?;
        if n == 0 {
            return Err("Incomplete callback request".into());
        }
        bytes.extend_from_slice(&chunk[..n]);
        if bytes.len() > CALLBACK_LIMIT {
            return Err("Callback request is too large".into());
        }
        if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
            return String::from_utf8(bytes).map_err(|_| "Invalid callback encoding".into());
        }
    }
}
fn callback_reply(stream: &mut TcpStream, ok: bool) {
    let (status, body) = if ok {
        (
            "200 OK",
            "Authorization received. Return to note.md to check connection status.",
        )
    } else {
        (
            "400 Bad Request",
            "Authorization callback was not accepted. Return to note.md.",
        )
    };
    let _=write!(stream,"HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\n\r\n{body}",body.len());
}
fn receive_authorization(
    listener: TcpListener,
    redirect: &Url,
    state: &str,
    account: &str,
    authorization_path: &Path,
    epoch: &str,
) -> Result<String, String> {
    let deadline = Instant::now() + CALLBACK_TIMEOUT;
    while Instant::now() < deadline {
        epoch_matches(authorization_path, epoch)?;
        if !pending()
            .lock()
            .map_err(|_| "Authentication state is unavailable")?
            .get(account)
            .is_some_and(|p| p.pending && p.state == state)
        {
            return Err("Oura authorization was cancelled".into());
        }
        match listener.accept() {
            Ok((mut stream, peer)) => {
                if !peer.ip().is_loopback() {
                    continue;
                }
                let result = callback_request(
                    &mut stream,
                    deadline.min(Instant::now() + Duration::from_secs(5)),
                )
                .and_then(|r| callback(&r, redirect, state));
                callback_reply(&mut stream, matches!(result, Ok(Callback::Code(_))));
                match result {
                    Ok(Callback::Code(code)) => return Ok(code),
                    Ok(Callback::Denied) => return Err("Oura authorization was declined".into()),
                    Err(_) => {}
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(100))
            }
            Err(_) => return Err("Oura callback listener failed".into()),
        }
    }
    Err("Oura authorization timed out after five minutes".into())
}

#[cfg(test)]
fn status_with(
    store: &dyn SecretStore,
    accounts: &[(&str, String)],
    states: &HashMap<String, Pending>,
) -> Value {
    let mut result = serde_json::Map::new();
    for (source, account) in accounts {
        let state = states.get(account);
        let mut entry = json!({"connected":false,"pending":state.is_some_and(|s|s.pending)});
        match store.get(account) {
            Ok(value) => {
                entry["connected"] = json!(value.is_some());
                if let Some(Credential::Garmin { region, .. }) = value {
                    entry["region"] = json!(region);
                }
            }
            Err(error) => entry["error"] = json!(error),
        }
        if let Some(error) = state.and_then(|p| p.error.as_ref()) {
            entry["error"] = json!(error);
        }
        result.insert((*source).into(), entry);
    }
    Value::Object(result)
}
fn account_credential(
    store: &dyn SecretStore,
    slot: &str,
    source: &str,
    subject: &str,
) -> Result<Credential, String> {
    let credential = store
        .get(slot)?
        .ok_or("Provider account is not connected")?;
    match &credential {
        Credential::Garmin { region, .. }
            if source == "garmin" && *region == GarminRegion::from_subject(subject) => {}
        Credential::Oura { .. } if source == "oura" => {}
        _ => {
            return Err("Provider credential disagrees with this account's source or region".into())
        }
    }
    Ok(credential)
}
fn catalog_status(
    store: &dyn SecretStore,
    hash: &str,
    source: &str,
    catalog: &AccountCatalog,
) -> Result<Value, String> {
    let mut accounts = vec![];
    let legacy_account_id = catalog
        .accounts
        .iter()
        .find(|(_, entry)| entry.legacy)
        .map(|(id, _)| id);
    let mut result = json!({"legacy_account_id":legacy_account_id,"connected":false,"pending":catalog.pending,"generation":null,"identity_verified":false,"active_account_id":catalog.active_account_id,"authorization_id":catalog.authorization_id,"completed_account_id":catalog.completed_account_id});
    if let Some(error) = &catalog.error {
        result["error"] = json!(error);
    }
    for (id, entry) in &catalog.accounts {
        let state = read_state(&account_state_path(hash, source, id, entry)?)?;
        let slot = credential_slot(hash, source, id, entry);
        let credentials = account_credential(store, &slot, source, &entry.subject);
        let authorized = state
            .as_ref()
            .is_some_and(|s| s.authorized && s.subject.as_deref() == Some(entry.subject.as_str()));
        let connected = authorized && credentials.is_ok();
        let mut account = json!({"id":id,"label":entry.label,"connected":connected,"generation":state.as_ref().map(|s| &s.epoch),"active":catalog.active_account_id.as_deref() == Some(id)});
        if source == "garmin" {
            account["region"] = json!(GarminRegion::from_subject(&entry.subject));
        }
        if authorized {
            if let Err(error) = credentials {
                account["error"] = json!(error);
            }
        }
        if catalog.active_account_id.as_deref() == Some(id) {
            result["connected"] = json!(connected);
            result["generation"] = account["generation"].clone();
            result["identity_verified"] = json!(true);
            if source == "garmin" {
                result["region"] = account["region"].clone();
            }
            if account.get("error").is_some() {
                result["error"] = account["error"].clone();
            }
        }
        accounts.push(account);
    }
    if source == "garmin" && result.get("region").is_none() {
        result["region"] = json!(GarminRegion::Global);
    }
    result["accounts"] = json!(accounts);
    Ok(result)
}
fn vault_catalog_status(
    store: &dyn SecretStore,
    vault: &Path,
    hash: &str,
    source: &str,
    catalog: &AccountCatalog,
) -> Result<Value, String> {
    let mut status = catalog_status(store, hash, source, catalog)?;
    status["legacy_account_id"] = json!(verified_legacy_account_id(vault, source, catalog)?);
    Ok(status)
}
pub fn status(vault: &Path) -> Result<Value, String> {
    let mut result = json!({});
    for source in ["garmin", "oura"] {
        let (_, _, hash) = identity(vault, source)?;
        let _lock = auth_lock(&hash, source)?;
        let catalog = account_catalog(vault, &hash, source)?;
        result[source] = vault_catalog_status(&Keychain, vault, &hash, source, &catalog)?;
    }
    Ok(result)
}
pub fn select_account(vault: &Path, source: &str, id: &str) -> Result<Value, String> {
    let (_, _, hash) = identity(vault, source)?;
    let _lock = auth_lock(&hash, source)?;
    let mut catalog = account_catalog(vault, &hash, source)?;
    select_saved_account(&Keychain, &hash, source, &mut catalog, id)?;
    catalog_status(&Keychain, &hash, source, &catalog)
}
fn select_saved_account(
    store: &dyn SecretStore,
    hash: &str,
    source: &str,
    catalog: &mut AccountCatalog,
    id: &str,
) -> Result<(), String> {
    let entry = catalog.accounts.get(id).ok_or("Unknown provider account")?;
    let state = active_state(&account_state_path(hash, source, id, entry)?)?;
    if state.subject.as_deref() != Some(entry.subject.as_str()) {
        return Err("Provider account binding disagrees with saved account".into());
    }
    account_credential(
        store,
        &credential_slot(hash, source, id, entry),
        source,
        &entry.subject,
    )?;
    if catalog.active_account_id.as_deref() != Some(id) {
        catalog.active_account_id = Some(id.into());
        catalog.active_epoch = random_string(32);
        write_state(&catalog_path(hash, source)?, catalog)?;
    }
    Ok(())
}
/// Cancel only the named pending attempt. Selecting or disconnecting accounts
/// is deliberately separate: cancellation must not revoke an existing session.
pub fn cancel_authorization(
    vault: &Path,
    source: &str,
    authorization_id: &str,
) -> Result<Value, String> {
    let (_, _, hash) = identity(vault, source)?;
    let _lock = auth_lock(&hash, source)?;
    let mut catalog = account_catalog(vault, &hash, source)?;
    let cancelled = cancel_pending_authorization(&hash, source, &mut catalog, authorization_id)?;
    let mut status = catalog_status(&Keychain, &hash, source, &catalog)?;
    status["cancelled"] = json!(cancelled);
    Ok(status)
}
fn cancel_pending_authorization(
    hash: &str,
    source: &str,
    catalog: &mut AccountCatalog,
    authorization_id: &str,
) -> Result<bool, String> {
    let cancelled = catalog.pending
        && catalog.completed_account_id.is_none()
        && catalog.authorization_id.as_deref() == Some(authorization_id);
    if cancelled {
        write_state(
            &pending_path(hash, source)?,
            &AuthorizationState {
                epoch: random_string(32),
                subject: None,
                authorized: false,
            },
        )?;
        catalog.pending = false;
        catalog.authorization_deadline = None;
        catalog.error = Some("Provider authorization was cancelled".into());
        write_state(&catalog_path(hash, source)?, catalog)?;
        pending()
            .lock()
            .map_err(|_| "Authentication state is unavailable")?
            .remove(&format!("{hash}-{source}"));
    }
    Ok(cancelled)
}
pub fn disconnect(vault: &Path, source: &str) -> Result<Value, String> {
    disconnect_account(vault, source, None)
}
pub fn disconnect_account(vault: &Path, source: &str, id: Option<&str>) -> Result<Value, String> {
    let (_, _, hash) = identity(vault, source)?;
    let _lock = auth_lock(&hash, source)?;
    let mut catalog = account_catalog(vault, &hash, source)?;
    disconnect_saved_account(&Keychain, &hash, source, &mut catalog, id)?;
    catalog_status(&Keychain, &hash, source, &catalog)
}
fn disconnect_saved_account(
    store: &dyn SecretStore,
    hash: &str,
    source: &str,
    catalog: &mut AccountCatalog,
    requested: Option<&str>,
) -> Result<(), String> {
    let id = requested
        .map(str::to_owned)
        .or_else(|| catalog.active_account_id.clone());
    let mut slot = None;
    if let Some(id) = &id {
        let entry = catalog.accounts.get(id).ok_or("Unknown provider account")?;
        write_state(
            &account_state_path(hash, source, id, entry)?,
            &AuthorizationState {
                epoch: random_string(32),
                subject: Some(entry.subject.clone()),
                authorized: false,
            },
        )?;
        slot = Some(credential_slot(hash, source, id, entry));
        if catalog.active_account_id.as_ref() == Some(id) {
            catalog.active_account_id = None;
            catalog.active_epoch = random_string(32);
        }
    }
    // Cancels an in-flight add/reconnect even if the provider has no active account.
    write_state(
        &pending_path(hash, source)?,
        &AuthorizationState {
            epoch: random_string(32),
            subject: None,
            authorized: false,
        },
    )?;
    catalog.pending = false;
    catalog.authorization_id = None;
    catalog.authorization_deadline = None;
    catalog.completed_account_id = None;
    catalog.error = None;
    write_state(&catalog_path(hash, source)?, catalog)?;
    pending()
        .lock()
        .map_err(|_| "Authentication state is unavailable")?
        .remove(&format!("{hash}-{source}"));
    if let Some(slot) = slot {
        store.delete(&slot)?;
    }
    Ok(())
}

pub struct ApiClient {
    source: String,
    region: GarminRegion,
    account: String,
    account_id: String,
    legacy_account_id: Option<String>,
    authorization_path: PathBuf,
    active_epoch: Option<String>,
    hash: String,
    token: String,
    epoch: String,
    http: Client,
}
pub fn client(vault: &Path, source: &str) -> Result<ApiClient, String> {
    client_for_account(vault, source, None)
}
pub fn client_for_account(
    vault: &Path,
    source: &str,
    requested: Option<&str>,
) -> Result<ApiClient, String> {
    let (_, _, hash) = identity(vault, source)?;
    let http = http_client()?;
    let _lock = auth_lock(&hash, source)?;
    let catalog = account_catalog(vault, &hash, source)?;
    let id = requested
        .or(catalog.active_account_id.as_deref())
        .ok_or("Choose an active provider account before syncing")?;
    let entry = catalog.accounts.get(id).ok_or("Unknown provider account")?;
    let authorization_path = account_state_path(&hash, source, id, entry)?;
    let state = active_state(&authorization_path)?;
    if state.subject.as_deref() != Some(entry.subject.as_str()) {
        return Err("Provider account binding disagrees with saved account".into());
    }
    let account = credential_slot(&hash, source, id, entry);
    let credential = account_credential(&Keychain, &account, source, &entry.subject)?;
    let region = match credential {
        Credential::Garmin { region, .. } => region,
        Credential::Oura { .. } => GarminRegion::Global,
    };
    let legacy_account_id = verified_legacy_account_id(vault, source, &catalog)?;
    let token = load_token(&Keychain, &account, &http, None, region)?;
    Ok(ApiClient {
        source: source.into(),
        region,
        account,
        account_id: id.into(),
        legacy_account_id,
        authorization_path,
        active_epoch: requested.is_none().then(|| catalog.active_epoch.clone()),
        hash,
        token,
        epoch: state.epoch,
        http,
    })
}

fn load_token(
    store: &dyn SecretStore,
    account: &str,
    http: &Client,
    rejected: Option<&str>,
    expected_region: GarminRegion,
) -> Result<String, String> {
    let credential = store.get(account)?.ok_or("Provider is not connected")?;
    match credential {
        Credential::Garmin { api_key, region } => {
            if region != expected_region {
                return Err("Garmin region changed; reconnect before syncing".into());
            }
            garmin_token(http, &api_key, region)
        }
        Credential::Oura {
            client_id,
            client_secret,
            redirect_uri,
            access_token,
            refresh_token,
            expires_at,
        } => {
            if expires_at > now()?.saturating_add(60)
                && rejected.is_none_or(|old| old != access_token)
            {
                return Ok(access_token);
            }
            let tokens = token_request(
                http,
                &[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", &refresh_token),
                    ("client_id", &client_id),
                    ("client_secret", &client_secret),
                ],
            )?;
            save_rotated(
                store,
                account,
                &client_id,
                &client_secret,
                &redirect_uri,
                &tokens,
            )
        }
    }
}
fn save_rotated(
    store: &dyn SecretStore,
    account: &str,
    client_id: &str,
    client_secret: &str,
    redirect_uri: &str,
    tokens: &Value,
) -> Result<String, String> {
    let next = token_credential(client_id, client_secret, redirect_uri, tokens)?;
    store.set(account, &next)?;
    match next {
        Credential::Oura { access_token, .. } => Ok(access_token),
        _ => unreachable!(),
    }
}

fn data_url(source: &str, region: GarminRegion, path: &str) -> Result<Url, String> {
    source_name(source)?;
    // Accept API paths only, never URLs or encoded traversal / query fragments.
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains(['%', '\\', '?', '#'])
        || path.split('/').any(|p| p == ".." || p == ".")
        || path.chars().any(char::is_control)
    {
        return Err("Invalid provider API path".into());
    }
    let base = if source == "oura" {
        "https://api.ouraring.com"
    } else {
        region.base_url()
    };
    Url::parse(&format!("{base}{path}")).map_err(|_| "Invalid provider API path".into())
}
fn retry_delay(status: u16, retry_after: Option<&str>, attempt: usize) -> Option<Duration> {
    if attempt >= 3 {
        return None;
    }
    if status == 429 {
        let seconds = retry_after
            .and_then(|s| {
                s.parse::<u64>().ok().or_else(|| {
                    chrono::DateTime::parse_from_rfc2822(s).ok().map(|date| {
                        date.timestamp()
                            .saturating_sub(now().unwrap_or(0) as i64)
                            .max(0) as u64
                    })
                })
            })
            .unwrap_or(1 << attempt);
        // A longer server cooldown ends this request; do not retry early merely
        // to keep the synchronous wait below our sixty-second budget.
        (seconds <= 60).then(|| Duration::from_secs(seconds))
    } else if (500..=599).contains(&status) {
        Some(Duration::from_secs(1 << attempt))
    } else {
        None
    }
}
impl ApiClient {
    pub fn account_id(&self) -> &str {
        &self.account_id
    }
    pub fn legacy_account_id(&self) -> Option<&str> {
        self.legacy_account_id.as_deref()
    }
    pub fn garmin_region(&self) -> GarminRegion {
        self.region
    }
    pub fn generation(&self) -> &str {
        &self.epoch
    }
    /// Call again immediately before committing a completed provider window.
    pub fn ensure_current(&self) -> Result<(), String> {
        let catalog = read_catalog(&catalog_path(&self.hash, &self.source)?)?
            .ok_or("Provider accounts are unavailable")?;
        if !catalog.accounts.contains_key(&self.account_id)
            || self.active_epoch.as_ref().is_some_and(|epoch| {
                epoch != &catalog.active_epoch
                    || catalog.active_account_id.as_deref() != Some(self.account_id.as_str())
            })
        {
            return Err("Active provider account changed; retry the operation".into());
        }
        let state = epoch_matches(&self.authorization_path, &self.epoch)?;
        if !state.authorized {
            return Err("Complete provider authorization before syncing".into());
        }
        Ok(())
    }
    /// Hold this guard through store activation and cursor persistence so that
    /// disconnect cannot revoke authorization between validation and commit.
    pub fn commit_guard(&self) -> Result<File, String> {
        let guard = auth_lock(&self.hash, &self.source)?;
        self.ensure_current()?;
        Ok(guard)
    }
    fn request(
        &mut self,
        path: &str,
        query: &[(&str, String)],
        limit: u64,
    ) -> Result<(u16, Vec<u8>), String> {
        let url = data_url(&self.source, self.region, path)?;
        let mut refreshed = false;
        let mut retry = 0;
        loop {
            self.ensure_current()?;
            let response = self
                .http
                .get(url.clone())
                .query(query)
                .bearer_auth(&self.token)
                .header(
                    "Accept",
                    if limit == ZIP_LIMIT {
                        "application/zip, application/x-zip-compressed, application/octet-stream"
                    } else {
                        "application/json"
                    },
                )
                .send()
                .map_err(|_| "Provider request failed or timed out")?;
            let status = response.status().as_u16();
            if status == 401 && !refreshed {
                drop(response);
                let _lock = auth_lock(&self.hash, &self.source)?;
                self.ensure_current()?;
                self.token = load_token(
                    &Keychain,
                    &self.account,
                    &self.http,
                    Some(&self.token),
                    self.region,
                )?;
                refreshed = true;
                continue;
            }
            if let Some(delay) = retry_delay(
                status,
                response
                    .headers()
                    .get("Retry-After")
                    .and_then(|h| h.to_str().ok()),
                retry,
            ) {
                drop(response);
                thread::sleep(delay);
                retry += 1;
                continue;
            }
            // Error bodies may echo credentials or identifying details. Adapters
            // need only the status and must never receive/log these bodies.
            if !(200..=299).contains(&status) || status == 204 {
                self.ensure_current()?;
                return Ok((status, vec![]));
            }
            let bytes = read_limited(response, limit)?;
            self.ensure_current()?;
            return Ok((status, bytes));
        }
    }
}
impl Transport for ApiClient {
    fn get_json(&mut self, path: &str, query: &[(&str, String)]) -> Result<HttpResponse, String> {
        let (status, bytes) = self.request(path, query, JSON_LIMIT)?;
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).map_err(|_| "Provider returned invalid JSON")?
        };
        Ok(HttpResponse { status, body })
    }
    fn get_bytes(
        &mut self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<(u16, Vec<u8>), String> {
        self.request(path, query, ZIP_LIMIT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Memory {
        values: Mutex<HashMap<String, Credential>>,
        fail: bool,
    }
    impl SecretStore for Memory {
        fn get(&self, a: &str) -> Result<Option<Credential>, String> {
            Ok(self.values.lock().unwrap().get(a).cloned())
        }
        fn set(&self, a: &str, c: &Credential) -> Result<(), String> {
            if self.fail {
                return Err("store failed".into());
            }
            self.values.lock().unwrap().insert(a.into(), c.clone());
            Ok(())
        }
        fn delete(&self, a: &str) -> Result<(), String> {
            self.values.lock().unwrap().remove(a);
            Ok(())
        }
    }
    #[test]
    fn pkce_and_callback_validate_exact_state_path_and_parameters() {
        let url = authorize_url(
            "client",
            "http://127.0.0.1:8765/callback",
            "state",
            "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        );
        let parsed = Url::parse(&url).unwrap();
        let args: HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(
            args["code_challenge"],
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert_eq!(args["code_challenge_method"], "S256");
        assert!(!url.contains("client_secret"));
        let redirect = redirect("http://127.0.0.1:8765/callback").unwrap();
        assert!(
            matches!(callback("GET /callback?code=abc&state=state HTTP/1.1\r\n\r\n",&redirect,"state"),Ok(Callback::Code(code))if code=="abc")
        );
        for line in [
            "GET /other?code=abc&state=state HTTP/1.1",
            "GET /callback?code=abc&state=bad HTTP/1.1",
            "GET /callback?code=abc&state=state&state=state HTTP/1.1",
            "POST /callback?code=abc&state=state HTTP/1.1",
        ] {
            assert!(callback(line, &redirect, "state").is_err());
        }
        assert!(matches!(
            callback(
                "GET /callback?error=access_denied&state=state HTTP/1.1",
                &redirect,
                "state"
            ),
            Ok(Callback::Denied)
        ));
    }
    #[test]
    fn rejects_external_redirects_and_credential_exfiltration_paths() {
        for value in [
            "https://example.com/callback",
            "http://0.0.0.0:8765/callback",
            "http://[::1]:8765/callback",
            "http://user@localhost:8765/callback",
            "http://localhost:0/callback",
            "http://localhost:8765/callback?x=1",
        ] {
            assert!(redirect(value).is_err());
        }
        assert!(redirect("http://localhost:8765/callback").is_ok());
        for path in [
            "https://evil.test/a",
            "//evil.test/a",
            "/../a",
            "/%2e%2e/a",
            "/a?token=x",
            "/a\\b",
        ] {
            assert!(data_url("oura", GarminRegion::Global, path).is_err());
        }
        assert_eq!(
            data_url("oura", GarminRegion::Global, "/v2/usercollection/sleep")
                .unwrap()
                .host_str(),
            Some("api.ouraring.com")
        );
        assert!(data_url("other", GarminRegion::Global, "/x").is_err());
    }
    #[test]
    fn saves_rotated_tokens_before_returning_access() {
        let store = Memory::default();
        let tokens = json!({"token_type":"bearer","access_token":"new-access","refresh_token":"new-refresh","expires_in":3600});
        assert_eq!(
            save_rotated(
                &store,
                "account",
                "client",
                "secret",
                "http://localhost:8765/callback",
                &tokens
            )
            .unwrap(),
            "new-access"
        );
        assert!(
            matches!(store.get("account").unwrap(),Some(Credential::Oura{refresh_token,..})if refresh_token=="new-refresh")
        );
        assert!(save_rotated(
            &Memory {
                fail: true,
                ..Default::default()
            },
            "account",
            "client",
            "secret",
            "http://localhost:8765/callback",
            &tokens
        )
        .is_err());
        for bad in [
            json!({}),
            json!({"access_token":"x","refresh_token":"y","token_type":"bearer","expires_in":0}),
            json!({"access_token":"x","token_type":"bearer","expires_in":100}),
        ] {
            assert!(token_credential("client", "secret", "redirect", &bad).is_err());
        }
    }
    #[test]
    fn status_never_includes_secrets() {
        let store = Memory::default();
        store
            .set(
                "vault-garmin",
                &Credential::Garmin {
                    api_key: "SUPER-SECRET".into(),
                    region: GarminRegion::Global,
                },
            )
            .unwrap();
        let status = status_with(
            &store,
            &[
                ("garmin", "vault-garmin".into()),
                ("oura", "vault-oura".into()),
            ],
            &HashMap::new(),
        );
        assert_eq!(status["garmin"]["connected"], true);
        assert_eq!(status["oura"]["connected"], false);
        assert!(!status.to_string().contains("SUPER-SECRET"));
        assert!(!status.to_string().contains("api_key"));
    }
    #[test]
    fn stale_client_uses_already_rotated_tokens_without_another_refresh() {
        let store = Memory::default();
        store
            .set(
                "account",
                &Credential::Oura {
                    client_id: "client".into(),
                    client_secret: "secret".into(),
                    redirect_uri: "http://127.0.0.1:8765/callback".into(),
                    access_token: "new-access".into(),
                    refresh_token: "new-refresh".into(),
                    expires_at: now().unwrap() + 3600,
                },
            )
            .unwrap();
        assert_eq!(
            load_token(
                &store,
                "account",
                &http_client().unwrap(),
                Some("old-access"),
                GarminRegion::Global,
            )
            .unwrap(),
            "new-access"
        );
        let redirect = redirect("http://127.0.0.1:8765/callback").unwrap();
        assert!(callback(&"x".repeat(CALLBACK_LIMIT + 1), &redirect, "state").is_err());
    }
    #[test]
    fn retry_is_bounded_and_honors_server_seconds() {
        assert_eq!(
            retry_delay(429, Some("12"), 0),
            Some(Duration::from_secs(12))
        );
        assert_eq!(retry_delay(429, Some("300"), 0), None);
        assert_eq!(retry_delay(503, None, 2), Some(Duration::from_secs(4)));
        assert_eq!(retry_delay(429, Some("12"), 3), None);
        assert_eq!(retry_delay(403, None, 0), None);
    }
    #[test]
    fn input_validation_does_not_echo_values() {
        assert!(field(&json!({"api_key":"secret\nvalue"}), "api_key")
            .unwrap_err()
            .contains("api_key"));
        assert!(!field(&json!({"api_key":"secret\nvalue"}), "api_key")
            .unwrap_err()
            .contains("secret"));
        assert_ne!(random_string(32), random_string(32));
        assert_eq!(random_string(64).len(), 86);
    }
    #[test]
    fn callback_from_old_process_cannot_restore_disconnected_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp
            .path()
            .canonicalize()
            .unwrap()
            .join("oura-authorization.json");
        let store = Memory::default();
        let old_epoch = random_string(32);
        write_state(
            &path,
            &AuthorizationState {
                epoch: old_epoch.clone(),
                subject: Some("oura:person-a".into()),
                authorized: false,
            },
        )
        .unwrap();
        // Another process has no access to our PENDING map. Its persisted epoch
        // change still cancels this callback even if local pending remains true.
        let disconnected = AuthorizationState {
            epoch: random_string(32),
            subject: Some("oura:person-a".into()),
            authorized: false,
        };
        write_state(&path, &disconnected).unwrap();
        let credential = Credential::Oura {
            client_id: "client".into(),
            client_secret: "secret".into(),
            redirect_uri: "http://127.0.0.1/callback".into(),
            access_token: "access".into(),
            refresh_token: "refresh".into(),
            expires_at: now().unwrap() + 3600,
        };
        assert!(save_authorized(
            &store,
            "account",
            &path,
            &old_epoch,
            "oura:person-a",
            &credential
        )
        .is_err());
        assert!(store.get("account").unwrap().is_none());
        assert_eq!(
            read_state(&path).unwrap().unwrap().epoch,
            disconnected.epoch
        );
        assert_eq!(
            read_state(&path).unwrap().unwrap().subject.as_deref(),
            Some("oura:person-a")
        );
    }
    #[test]
    fn pending_authorization_and_failed_keychain_write_cannot_use_old_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp
            .path()
            .canonicalize()
            .unwrap()
            .join("authorization.json");
        let store = Memory::default();
        let credential = Credential::Garmin {
            api_key: "old-key".into(),
            region: GarminRegion::Global,
        };
        store.set("account", &credential).unwrap();
        let state = AuthorizationState {
            epoch: random_string(32),
            subject: Some("garmin:123".into()),
            authorized: false,
        };
        write_state(&path, &state).unwrap();
        // Starting reconnect changes the generation before credentials change.
        // The retained old credential must not backfill under that generation.
        assert!(store.get("account").unwrap().is_some());
        assert!(active_state(&path).is_err());
        save_authorized(
            &store,
            "account",
            &path,
            &state.epoch,
            "garmin:123",
            &credential,
        )
        .unwrap();
        assert!(active_state(&path).is_ok());

        struct RejectWrite;
        impl SecretStore for RejectWrite {
            fn get(&self, _: &str) -> Result<Option<Credential>, String> {
                Ok(None)
            }
            fn set(&self, _: &str, _: &Credential) -> Result<(), String> {
                Err("Keychain unavailable".into())
            }
            fn delete(&self, _: &str) -> Result<(), String> {
                Ok(())
            }
        }
        assert!(save_authorized(
            &RejectWrite,
            "account",
            &path,
            &state.epoch,
            "garmin:123",
            &credential
        )
        .is_err());
        assert!(active_state(&path).is_err());
        // Disconnect has the same guard even if Keychain deletion fails.
        assert!(store.get("account").unwrap().is_some());
    }
    #[test]
    fn key_rotation_allows_same_user_and_rejects_different_user() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp
            .path()
            .canonicalize()
            .unwrap()
            .join("garmin-authorization.json");
        let store = Memory::default();
        let epoch = random_string(32);
        write_state(
            &path,
            &AuthorizationState {
                epoch: epoch.clone(),
                subject: Some("garmin:123".into()),
                authorized: false,
            },
        )
        .unwrap();
        save_authorized(
            &store,
            "account",
            &path,
            &epoch,
            "garmin:123",
            &Credential::Garmin {
                api_key: "rotated-key".into(),
                region: GarminRegion::Global,
            },
        )
        .unwrap();
        assert!(save_authorized(
            &store,
            "account",
            &path,
            &epoch,
            "garmin:456",
            &Credential::Garmin {
                api_key: "different-person-key".into(),
                region: GarminRegion::Global,
            }
        )
        .is_err());
        assert!(
            matches!(store.get("account").unwrap(),Some(Credential::Garmin{api_key,..}) if api_key=="rotated-key")
        );
        let metadata = fs::read_to_string(&path).unwrap();
        assert!(!metadata.contains("key"));
        assert_eq!(
            read_state(&path).unwrap().unwrap().subject.as_deref(),
            Some("garmin:123")
        );
    }
    #[test]
    fn identity_uses_documented_user_fields_never_key_or_display_name() {
        for (collection, body) in [
            ("daily_summary_legacy", json!({"userProfileId":123})),
            ("daily_summaries", json!({"data":[{"userProfilePk":123}]})),
            ("activities", json!({"ownerId":123,"activityId":777})),
            ("heart_rate", json!({"userProfilePK":123})),
        ] {
            assert_eq!(
                response_subject("garmin", collection, &body).as_deref(),
                Some("garmin:123")
            );
        }
        assert_eq!(
            response_subject("oura", "personal_info", &json!({"id":"person-a"})).as_deref(),
            Some("oura:person-a")
        );
        assert!(response_subject(
            "garmin",
            "profile",
            &json!({"displayName":"person","sub":"key-id"})
        )
        .is_none());
        assert!(response_subject("garmin", "activities", &json!({"activityId":123})).is_none());
        assert!(response_subject("garmin", "activities", &json!({"ownerId":-1})).is_none());
    }
    #[test]
    fn restores_binding_from_verified_archive_without_touching_keychain() {
        use crate::providers::{CollectionResult, FetchReport, ProviderRecord};
        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path().join("vault");
        fs::create_dir(&vault).unwrap();
        let local = temp.path().join("state");
        fs::create_dir(&local).unwrap();
        let store = crate::store::Store::new(&vault, &local).unwrap();
        let file = temp.path().join("rows.jsonl");
        let row = ProviderRecord {
            source: "garmin".into(),
            collection: "activities".into(),
            day: "2026-10-24".into(),
            id: Some("777".into()),
            data: json!({"activityId":777,"ownerId":123}),
        };
        fs::write(&file, format!("{}\n", serde_json::to_string(&row).unwrap())).unwrap();
        let report = FetchReport {
            source: "garmin".into(),
            since: "2026-10-24".into(),
            until: "2026-10-24".into(),
            collections: vec![CollectionResult {
                collection: "activities".into(),
                status: "complete".into(),
                records: 1,
                error: None,
            }],
        };
        store
            .apply_provider(&file, &report, false, &mut |_| {})
            .unwrap();
        // Archives produced before regional support have no region field.
        let manifest_path = vault.join("health/manifest.json");
        let mut legacy: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        legacy["sources"]["garmin"]
            .as_object_mut()
            .unwrap()
            .remove("garmin_region");
        fs::write(&manifest_path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert_eq!(
            store.manifest().unwrap().unwrap().sources["garmin"].garmin_region,
            None
        );
        assert_eq!(
            archived_subject(&vault, "garmin", true).unwrap().as_deref(),
            Some("garmin:123")
        );
        assert!(store
            .apply_provider_with_region(&file, &report, false, GarminRegion::China, &mut |_| {})
            .is_err());
        let mut no_id = row;
        no_id.data = json!({"activityId":777});
        fs::write(
            &file,
            format!("{}\n", serde_json::to_string(&no_id).unwrap()),
        )
        .unwrap();
        store
            .apply_provider(&file, &report, false, &mut |_| {})
            .unwrap();
        assert!(archived_subject(&vault, "garmin", true).is_err());
        assert!(archived_subject(&vault, "garmin", false).unwrap().is_none());
    }

    #[test]
    fn garmin_regions_are_strict_and_legacy_credentials_default_to_global() {
        let old: Credential =
            serde_json::from_value(json!({"source":"garmin","api_key":"old-key"})).unwrap();
        assert!(matches!(
            old,
            Credential::Garmin {
                region: GarminRegion::Global,
                ..
            }
        ));
        assert_eq!(
            GarminRegion::from_params(&json!({})).unwrap(),
            GarminRegion::Global
        );
        for region in [GarminRegion::Global, GarminRegion::China] {
            let params = json!({"region":region});
            assert_eq!(GarminRegion::from_params(&params).unwrap(), region);
            let credential = Credential::Garmin {
                api_key: "test-key".into(),
                region,
            };
            let decoded: Credential =
                serde_json::from_slice(&serde_json::to_vec(&credential).unwrap()).unwrap();
            assert!(
                matches!(decoded, Credential::Garmin { region: actual, .. } if actual == region)
            );
        }
        for invalid in [
            Value::Null,
            json!("cn"),
            json!("China"),
            json!("https://evil.test"),
            json!(7),
            json!({}),
        ] {
            let error = GarminRegion::from_params(&json!({"region":invalid})).unwrap_err();
            assert_eq!(error, "Garmin region must be global or china");
            assert!(serde_json::from_value::<Credential>(
                json!({"source":"garmin","api_key":"x","region":invalid})
            )
            .is_err());
        }
    }

    #[test]
    fn garmin_token_identity_and_data_urls_stay_in_selected_region() {
        let http = http_client().unwrap();
        for (region, host) in [
            (GarminRegion::Global, "personal.connectapi.garmin.com"),
            (GarminRegion::China, "personal.connectapi.garmin.cn"),
        ] {
            let token = garmin_token_request(&http, "test-key", region)
                .unwrap()
                .build()
                .unwrap();
            assert_eq!(token.method(), reqwest::Method::POST);
            assert_eq!(token.url().scheme(), "https");
            assert_eq!(token.url().host_str(), Some(host));
            assert_eq!(token.url().path(), GARMIN_TOKEN_PATH);
            assert_eq!(token.headers()["Authorization"], "ApiKey test-key");
            for path in [
                "/usersummary-service/usersummary/daily",
                "/activitylist-service/activities/search/activities",
                "/wellness-service/wellness/dailySleepData",
                "/download-service/files/activity/123",
            ] {
                let url = data_url("garmin", region, path).unwrap();
                assert_eq!(url.scheme(), "https");
                assert_eq!(url.host_str(), Some(host));
                assert_eq!(url.path(), path);
            }
            for path in [
                "//evil.test/",
                "https://evil.test",
                "/%2f%2fevil.test",
                "/../x",
                "/a?token=x",
            ] {
                assert!(data_url("garmin", region, path).is_err());
            }
        }
    }

    #[test]
    fn garmin_refresh_rejects_a_changed_region_before_exchanging_credentials() {
        let store = Memory::default();
        for (stored, expected) in [
            (GarminRegion::China, GarminRegion::Global),
            (GarminRegion::Global, GarminRegion::China),
        ] {
            store
                .set(
                    "account",
                    &Credential::Garmin {
                        api_key: "test-key".into(),
                        region: stored,
                    },
                )
                .unwrap();
            for rejected in [None, Some("rejected-token")] {
                let error = load_token(
                    &store,
                    "account",
                    &http_client().unwrap(),
                    rejected,
                    expected,
                )
                .unwrap_err();
                assert_eq!(error, "Garmin region changed; reconnect before syncing");
            }
        }
    }

    #[test]
    fn same_numeric_garmin_id_cannot_cross_regions_or_mismatch_credential() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp
            .path()
            .canonicalize()
            .unwrap()
            .join("authorization.json");
        let epoch = random_string(32);
        let store = Memory::default();
        let global = Credential::Garmin {
            api_key: "global-key".into(),
            region: GarminRegion::Global,
        };
        let china = Credential::Garmin {
            api_key: "china-key".into(),
            region: GarminRegion::China,
        };
        write_state(
            &path,
            &AuthorizationState {
                epoch: epoch.clone(),
                subject: Some("garmin:123".into()),
                authorized: false,
            },
        )
        .unwrap();
        save_authorized(&store, "account", &path, &epoch, "garmin:123", &global).unwrap();
        let china_subject = GarminRegion::China.scope_subject("garmin:123".into());
        assert_eq!(china_subject, "garmin:china:123");
        assert!(save_authorized(&store, "account", &path, &epoch, &china_subject, &china).is_err());
        assert!(save_authorized(&store, "account", &path, &epoch, "garmin:123", &china).is_err());
        assert!(matches!(
            store.get("account").unwrap(),
            Some(Credential::Garmin {
                region: GarminRegion::Global,
                ..
            })
        ));
        let status = status_with(&store, &[("garmin", "account".into())], &HashMap::new());
        assert_eq!(status["garmin"]["region"], "global");
        store.set("account", &china).unwrap();
        let status = status_with(&store, &[("garmin", "account".into())], &HashMap::new());
        assert_eq!(status["garmin"]["region"], "china");
        assert!(!status.to_string().contains("china-key"));
    }

    #[test]
    fn china_archive_restores_region_and_refuses_global_writes() {
        use crate::providers::{CollectionResult, FetchReport, ProviderRecord};
        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path().join("vault");
        fs::create_dir(&vault).unwrap();
        let local = temp.path().join("state");
        fs::create_dir(&local).unwrap();
        let store = crate::store::Store::new(&vault, &local).unwrap();
        let staged = temp.path().join("rows.jsonl");
        let row = ProviderRecord {
            source: "garmin".into(),
            collection: "activities".into(),
            day: "2026-10-24".into(),
            id: Some("777".into()),
            data: json!({"activityId":777,"ownerId":123}),
        };
        fs::write(
            &staged,
            format!("{}\n", serde_json::to_string(&row).unwrap()),
        )
        .unwrap();
        let report = FetchReport {
            source: "garmin".into(),
            since: "2026-10-24".into(),
            until: "2026-10-24".into(),
            collections: vec![CollectionResult {
                collection: "activities".into(),
                status: "complete".into(),
                records: 1,
                error: None,
            }],
        };
        store
            .apply_provider_with_region(&staged, &report, false, GarminRegion::China, &mut |_| {})
            .unwrap();
        assert_eq!(
            store.manifest().unwrap().unwrap().sources["garmin"].garmin_region,
            Some(GarminRegion::China)
        );
        // No local authorization or Keychain data exists: recovery reads only the portable archive.
        assert_eq!(
            archived_subject(&vault, "garmin", true).unwrap().as_deref(),
            Some("garmin:china:123")
        );
        let before = serde_json::to_vec(&store.manifest().unwrap()).unwrap();
        assert!(store
            .apply_provider(&staged, &report, false, &mut |_| {})
            .is_err());
        assert_eq!(
            before,
            serde_json::to_vec(&store.manifest().unwrap()).unwrap()
        );
    }

    /// Manual only: feed the key through stdin, never command arguments or files.
    /// This test performs read-only identity validation and never writes Keychain or a vault.
    #[test]
    #[ignore = "requires an explicitly supplied Garmin key on stdin and live network"]
    fn live_garmin_region_authentication_smoke() {
        let region = std::env::var("NOTEMD_GARMIN_TEST_REGION")
            .expect("Set NOTEMD_GARMIN_TEST_REGION to global or china");
        let region =
            GarminRegion::from_params(&json!({"region":region})).expect("Invalid test region");
        let mut key = String::new();
        std::io::stdin()
            .read_line(&mut key)
            .expect("Cannot read key from stdin");
        let key = key.trim();
        assert!(!key.is_empty(), "Supply a key on stdin");
        let http = http_client().expect("Cannot build HTTP client");
        let token = garmin_token(&http, key, region).expect("Garmin token exchange failed");
        let subject = verified_subject(&http, &token, "garmin", region)
            .expect("Garmin identity validation failed");
        assert_eq!(
            GarminRegion::from_subject(&subject),
            region,
            "Identity region mismatch"
        );
    }

    struct AccountsFixture {
        _temp: tempfile::TempDir,
        vault: PathBuf,
        hash: String,
        secrets: Memory,
    }
    impl AccountsFixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().canonicalize().unwrap();
            let vault = root.join("vault");
            fs::create_dir(&vault).unwrap();
            // Absolute test-only hash confines every state file to this tempdir.
            let hash = root.join("state").to_string_lossy().into_owned();
            Self {
                _temp: temp,
                vault,
                hash,
                secrets: Memory::default(),
            }
        }
        fn catalog(&self, source: &str) -> AccountCatalog {
            let _lock = auth_lock(&self.hash, source).unwrap();
            account_catalog(&self.vault, &self.hash, source).unwrap()
        }
        fn add(&self, source: &str, subject: &str, key: &str) -> String {
            let credential = if source == "garmin" {
                Credential::Garmin {
                    api_key: key.into(),
                    region: GarminRegion::from_subject(subject),
                }
            } else {
                Credential::Oura {
                    client_id: "client".into(),
                    client_secret: "secret".into(),
                    redirect_uri: "http://localhost:8765/callback".into(),
                    access_token: key.into(),
                    refresh_token: "refresh".into(),
                    expires_at: now().unwrap() + 3600,
                }
            };
            let epoch = begin_connection(&self.vault, &self.hash, source).unwrap();
            let _lock = auth_lock(&self.hash, source).unwrap();
            complete_connection(
                &self.secrets,
                &self.vault,
                &self.hash,
                source,
                &epoch,
                VerifiedConnection {
                    subject,
                    credential: &credential,
                    label: None,
                },
            )
            .unwrap()
        }
        fn client(&self, source: &str, id: &str, active: bool) -> ApiClient {
            let catalog = self.catalog(source);
            let entry = &catalog.accounts[id];
            let authorization_path = account_state_path(&self.hash, source, id, entry).unwrap();
            let state = active_state(&authorization_path).unwrap();
            ApiClient {
                source: source.into(),
                region: GarminRegion::from_subject(&entry.subject),
                account: credential_slot(&self.hash, source, id, entry),
                account_id: id.into(),
                legacy_account_id: catalog
                    .accounts
                    .iter()
                    .find(|(_, e)| e.legacy)
                    .map(|(id, _)| id.clone()),
                authorization_path,
                active_epoch: active.then(|| catalog.active_epoch.clone()),
                hash: self.hash.clone(),
                token: "test-token".into(),
                epoch: state.epoch,
                http: http_client().unwrap(),
            }
        }
    }

    #[test]
    fn multiple_saved_accounts_keep_one_active_and_never_expose_subjects_or_keys() {
        let fixture = AccountsFixture::new();
        let a = fixture.add("garmin", "garmin:111222333", "SECRET-A");
        let b = fixture.add("garmin", "garmin:china:111222333", "SECRET-B");
        assert_ne!(a, b);
        let mut catalog = fixture.catalog("garmin");
        assert_eq!(catalog.accounts.len(), 2);
        assert_eq!(catalog.active_account_id.as_deref(), Some(a.as_str()));
        let result = catalog_status(&fixture.secrets, &fixture.hash, "garmin", &catalog).unwrap();
        assert_eq!(result["accounts"].as_array().unwrap().len(), 2);
        assert_eq!(result["completed_account_id"], b);
        for secret in [
            "SECRET-A",
            "SECRET-B",
            "garmin:111222333",
            "garmin:china:111222333",
            "api_key",
            "subject",
        ] {
            assert!(!result.to_string().contains(secret));
        }
        select_saved_account(&fixture.secrets, &fixture.hash, "garmin", &mut catalog, &b).unwrap();
        assert_eq!(catalog.active_account_id.as_deref(), Some(b.as_str()));
        assert_eq!(
            catalog_status(&fixture.secrets, &fixture.hash, "garmin", &catalog).unwrap()["region"],
            "china"
        );
        assert!(select_saved_account(
            &fixture.secrets,
            &fixture.hash,
            "garmin",
            &mut catalog,
            "../outside"
        )
        .is_err());
        assert_eq!(fixture.secrets.values.lock().unwrap().len(), 2);
    }

    #[test]
    fn switching_active_invalidates_incremental_but_not_explicit_history_client() {
        let fixture = AccountsFixture::new();
        let a = fixture.add("garmin", "garmin:123", "KEY-A");
        let b = fixture.add("garmin", "garmin:456", "KEY-B");
        let incremental = fixture.client("garmin", &a, true);
        let history = fixture.client("garmin", &a, false);
        let mut catalog = fixture.catalog("garmin");
        select_saved_account(&fixture.secrets, &fixture.hash, "garmin", &mut catalog, &b).unwrap();
        assert!(incremental.ensure_current().is_err());
        assert!(history.ensure_current().is_ok());
        assert!(history.commit_guard().is_ok());
        disconnect_saved_account(
            &fixture.secrets,
            &fixture.hash,
            "garmin",
            &mut catalog,
            Some(&b),
        )
        .unwrap();
        assert!(history.ensure_current().is_ok());
        assert!(catalog.active_account_id.is_none());
        assert_eq!(catalog.accounts.len(), 2);
        disconnect_saved_account(
            &fixture.secrets,
            &fixture.hash,
            "garmin",
            &mut catalog,
            Some(&a),
        )
        .unwrap();
        assert!(history.ensure_current().is_err());
        assert!(fixture.secrets.values.lock().unwrap().is_empty());
        assert!(
            select_saved_account(&fixture.secrets, &fixture.hash, "garmin", &mut catalog, &a)
                .is_err()
        );
    }

    #[test]
    fn legacy_account_migration_preserves_slots_epoch_and_disconnected_state() {
        for authorized in [true, false] {
            let fixture = AccountsFixture::new();
            let _lock = auth_lock(&fixture.hash, "garmin").unwrap();
            let epoch = random_string(32);
            write_state(
                &state_path(&fixture.hash, "garmin").unwrap(),
                &AuthorizationState {
                    epoch: epoch.clone(),
                    subject: Some("garmin:123".into()),
                    authorized,
                },
            )
            .unwrap();
            let old_slot = format!("{}-garmin", fixture.hash);
            fixture
                .secrets
                .set(
                    &old_slot,
                    &Credential::Garmin {
                        api_key: "LEGACY-SECRET".into(),
                        region: GarminRegion::Global,
                    },
                )
                .unwrap();
            let catalog = account_catalog(&fixture.vault, &fixture.hash, "garmin").unwrap();
            let id = account_id_for_subject("garmin:123");
            assert_eq!(catalog.active_account_id.as_deref(), Some(id.as_str()));
            assert!(catalog.accounts[&id].legacy);
            assert_eq!(
                credential_slot(&fixture.hash, "garmin", &id, &catalog.accounts[&id]),
                old_slot
            );
            let state = read_state(&state_path(&fixture.hash, "garmin").unwrap())
                .unwrap()
                .unwrap();
            assert_eq!(state.epoch, epoch);
            assert_eq!(state.authorized, authorized);
            assert_eq!(
                catalog_status(&fixture.secrets, &fixture.hash, "garmin", &catalog).unwrap()
                    ["connected"],
                authorized
            );
            assert_eq!(
                catalog_status(&fixture.secrets, &fixture.hash, "garmin", &catalog).unwrap()
                    ["legacy_account_id"],
                id
            );
            let repeated = account_catalog(&fixture.vault, &fixture.hash, "garmin").unwrap();
            assert_eq!(repeated.accounts.len(), 1);
            assert_eq!(fixture.secrets.values.lock().unwrap().len(), 1);
            assert!(
                !fs::read_to_string(catalog_path(&fixture.hash, "garmin").unwrap())
                    .unwrap()
                    .contains("LEGACY-SECRET")
            );
        }
    }

    #[test]
    fn reconnecting_one_account_rotates_only_its_generation_and_keeps_other_credentials() {
        let fixture = AccountsFixture::new();
        let a = fixture.add("oura", "oura:account-a", "TOKEN-A");
        let b = fixture.add("oura", "oura:account-b", "TOKEN-B");
        let old_a = fixture.client("oura", &a, false);
        let old_b = fixture.client("oura", &b, false);
        assert_eq!(fixture.add("oura", "oura:account-a", "ROTATED-A"), a);
        assert!(old_a.ensure_current().is_err());
        assert!(old_b.ensure_current().is_ok());
        let catalog = fixture.catalog("oura");
        assert_eq!(catalog.accounts.len(), 2);
        assert_eq!(catalog.active_account_id.as_deref(), Some(a.as_str()));
        let slot = credential_slot(&fixture.hash, "oura", &b, &catalog.accounts[&b]);
        assert!(
            matches!(fixture.secrets.get(&slot).unwrap(),Some(Credential::Oura{access_token,..}) if access_token == "TOKEN-B")
        );
    }

    #[test]
    fn late_authorization_cannot_add_account_after_replacement_or_disconnect() {
        let fixture = AccountsFixture::new();
        let a = fixture.add("oura", "oura:account-a", "TOKEN-A");
        let running = fixture.client("oura", &a, true);
        let old = begin_connection(&fixture.vault, &fixture.hash, "oura").unwrap();
        assert!(running.ensure_current().is_ok());
        let new = begin_connection(&fixture.vault, &fixture.hash, "oura").unwrap();
        let credential = Credential::Oura {
            client_id: "client".into(),
            client_secret: "secret".into(),
            redirect_uri: "http://localhost:8765/callback".into(),
            access_token: "NEW-TOKEN".into(),
            refresh_token: "refresh".into(),
            expires_at: now().unwrap() + 3600,
        };
        let verified = || VerifiedConnection {
            subject: "oura:account-b",
            credential: &credential,
            label: Some("Old account"),
        };
        assert!(complete_connection(
            &fixture.secrets,
            &fixture.vault,
            &fixture.hash,
            "oura",
            &old,
            verified()
        )
        .is_err());
        let mut catalog = fixture.catalog("oura");
        let status = catalog_status(&fixture.secrets, &fixture.hash, "oura", &catalog).unwrap();
        assert_eq!(status["connected"], true);
        assert_eq!(status["pending"], true);
        assert_eq!(status["authorization_id"], new);
        assert!(status["completed_account_id"].is_null());
        disconnect_saved_account(
            &fixture.secrets,
            &fixture.hash,
            "oura",
            &mut catalog,
            Some(&a),
        )
        .unwrap();
        assert!(complete_connection(
            &fixture.secrets,
            &fixture.vault,
            &fixture.hash,
            "oura",
            &new,
            verified()
        )
        .is_err());
        assert_eq!(fixture.catalog("oura").accounts.len(), 1);
        assert!(fixture.secrets.values.lock().unwrap().is_empty());
    }

    #[test]
    fn failed_new_account_storage_preserves_existing_active_account() {
        let fixture = AccountsFixture::new();
        let a = fixture.add("garmin", "garmin:123", "TOKEN-A");
        let client = fixture.client("garmin", &a, true);
        let epoch = begin_connection(&fixture.vault, &fixture.hash, "garmin").unwrap();
        let credential = Credential::Garmin {
            api_key: "FAILED-SECRET".into(),
            region: GarminRegion::Global,
        };
        let rejecting = Memory {
            fail: true,
            ..Default::default()
        };
        assert!(complete_connection(
            &rejecting,
            &fixture.vault,
            &fixture.hash,
            "garmin",
            &epoch,
            VerifiedConnection {
                subject: "garmin:456",
                credential: &credential,
                label: None
            }
        )
        .is_err());
        connection_failed(
            &fixture.hash,
            "garmin",
            &epoch,
            "Cannot save health credentials to macOS Keychain",
        );
        assert!(client.ensure_current().is_ok());
        let catalog = fixture.catalog("garmin");
        assert_eq!(catalog.accounts.len(), 1);
        assert_eq!(catalog.active_account_id.as_deref(), Some(a.as_str()));
        assert_eq!(
            catalog_status(&fixture.secrets, &fixture.hash, "garmin", &catalog).unwrap()["pending"],
            false
        );
        assert!(connection_label(&json!({"label":"bad\nlabel"})).is_err());
        assert!(connection_label(&json!({"label":"x".repeat(129)})).is_err());
    }

    #[test]
    fn abandoned_authorization_expires_without_revoking_active_account() {
        let fixture = AccountsFixture::new();
        let id = fixture.add("garmin", "garmin:123", "KEY-A");
        let client = fixture.client("garmin", &id, true);
        let epoch = begin_connection(&fixture.vault, &fixture.hash, "garmin").unwrap();
        let mut catalog = fixture.catalog("garmin");
        catalog.authorization_deadline = Some(now().unwrap().saturating_sub(1));
        write_state(&catalog_path(&fixture.hash, "garmin").unwrap(), &catalog).unwrap();
        let expired = fixture.catalog("garmin");
        assert!(!expired.pending);
        assert!(expired.error.is_some());
        assert!(client.ensure_current().is_ok());
        let credential = Credential::Garmin {
            api_key: "LATE-KEY".into(),
            region: GarminRegion::Global,
        };
        assert!(complete_connection(
            &fixture.secrets,
            &fixture.vault,
            &fixture.hash,
            "garmin",
            &epoch,
            VerifiedConnection {
                subject: "garmin:456",
                credential: &credential,
                label: None
            }
        )
        .is_err());
        assert_eq!(fixture.secrets.values.lock().unwrap().len(), 1);
    }

    #[test]
    fn restored_legacy_archive_ownership_is_verified_even_after_catalog_creation() {
        use crate::providers::{CollectionResult, FetchReport, ProviderRecord};
        let fixture = AccountsFixture::new();
        let mut catalog = fixture.catalog("garmin");
        assert!(catalog.accounts.is_empty());
        assert!(vault_catalog_status(
            &fixture.secrets,
            &fixture.vault,
            &fixture.hash,
            "garmin",
            &catalog
        )
        .unwrap()["legacy_account_id"]
            .is_null());
        let store = crate::store::Store::new(&fixture.vault, Path::new(&fixture.hash)).unwrap();
        let staged = fixture.vault.parent().unwrap().join("legacy.jsonl");
        let row = ProviderRecord {
            source: "garmin".into(),
            collection: "activities".into(),
            day: "2026-10-24".into(),
            id: Some("999".into()),
            data: json!({"ownerId":123,"activityId":999}),
        };
        fs::write(
            &staged,
            format!("{}\n", serde_json::to_string(&row).unwrap()),
        )
        .unwrap();
        let report = FetchReport {
            source: "garmin".into(),
            since: "2026-10-24".into(),
            until: "2026-10-24".into(),
            collections: vec![CollectionResult {
                collection: "activities".into(),
                status: "complete".into(),
                records: 1,
                error: None,
            }],
        };
        store
            .apply_provider(&staged, &report, false, &mut |_| {})
            .unwrap();
        assert_eq!(
            verified_legacy_account_id(&fixture.vault, "garmin", &catalog).unwrap(),
            Some(account_id_for_subject("garmin:123"))
        );
        let status = vault_catalog_status(
            &fixture.secrets,
            &fixture.vault,
            &fixture.hash,
            "garmin",
            &catalog,
        )
        .unwrap();
        assert_eq!(
            status["legacy_account_id"],
            account_id_for_subject("garmin:123")
        );
        assert!(!status.to_string().contains("garmin:123"));
        let conflicting = account_id_for_subject("garmin:456");
        catalog.accounts.insert(
            conflicting,
            SavedAccount {
                subject: "garmin:456".into(),
                label: "Old account".into(),
                legacy: true,
            },
        );
        assert!(verified_legacy_account_id(&fixture.vault, "garmin", &catalog).is_err());
    }

    #[test]
    fn cancelling_named_authorization_preserves_accounts_and_ignores_stale_or_completed_ids() {
        let fixture = AccountsFixture::new();
        let a = fixture.add("oura", "oura:account-a", "TOKEN-A");
        let active = fixture.client("oura", &a, true);
        let original = fixture.catalog("oura");
        let first = begin_connection(&fixture.vault, &fixture.hash, "oura").unwrap();
        let second = begin_connection(&fixture.vault, &fixture.hash, "oura").unwrap();
        let mut catalog = fixture.catalog("oura");
        assert!(
            !cancel_pending_authorization(&fixture.hash, "oura", &mut catalog, &first).unwrap()
        );
        assert!(catalog.pending);
        assert_eq!(catalog.authorization_id.as_deref(), Some(second.as_str()));
        assert!(epoch_matches(&pending_path(&fixture.hash, "oura").unwrap(), &second).is_ok());
        assert!(
            cancel_pending_authorization(&fixture.hash, "oura", &mut catalog, &second).unwrap()
        );
        assert!(!catalog.pending);
        assert_eq!(
            catalog.error.as_deref(),
            Some("Provider authorization was cancelled")
        );
        assert!(epoch_matches(&pending_path(&fixture.hash, "oura").unwrap(), &second).is_err());
        assert_eq!(catalog.active_account_id, original.active_account_id);
        assert_eq!(catalog.active_epoch, original.active_epoch);
        assert_eq!(catalog.accounts.len(), 1);
        assert_eq!(fixture.secrets.values.lock().unwrap().len(), 1);
        assert!(active.ensure_current().is_ok());
        let b = fixture.add("oura", "oura:account-b", "TOKEN-B");
        let mut complete = fixture.catalog("oura");
        let completed_id = complete.authorization_id.clone().unwrap();
        let before = serde_json::to_vec(&complete).unwrap();
        assert!(
            !cancel_pending_authorization(&fixture.hash, "oura", &mut complete, &completed_id)
                .unwrap()
        );
        assert_eq!(serde_json::to_vec(&complete).unwrap(), before);
        assert_eq!(complete.completed_account_id.as_deref(), Some(b.as_str()));
        assert_eq!(fixture.secrets.values.lock().unwrap().len(), 2);
        assert!(active.ensure_current().is_ok());
    }
}
