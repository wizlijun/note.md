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
    collections::HashMap,
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
const GARMIN_TOKEN: &str = "https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token";
const JSON_LIMIT: u64 = 64 * 1024 * 1024;
const ZIP_LIMIT: u64 = 256 * 1024 * 1024;
const TOKEN_LIMIT: u64 = 128 * 1024;
const CALLBACK_LIMIT: usize = 8192;
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "lowercase")]
enum Credential {
    Garmin {
        api_key: String,
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
    epoch: String,
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
fn write_state(path: &Path, state: &AuthorizationState) -> Result<(), String> {
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
    if !manifest.sources.contains_key(source) {
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
fn begin_authorization(vault: &Path, hash: &str, source: &str) -> Result<String, String> {
    let _lock = auth_lock(hash, source)?;
    let path = state_path(hash, source)?;
    let previous = read_state(&path)?;
    let subject = previous.and_then(|s| s.subject);
    let archived = archived_subject(vault, source, subject.is_none())?;
    if subject
        .as_ref()
        .zip(archived.as_ref())
        .is_some_and(|(a, b)| a != b)
    {
        return Err("Provider account binding disagrees with existing health data".into());
    }
    let epoch = random_string(32);
    write_state(
        &path,
        &AuthorizationState {
            epoch: epoch.clone(),
            subject: subject.or(archived),
            authorized: false,
        },
    )?;
    Ok(epoch)
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
    path: &str,
    query: &[(&str, String)],
) -> Result<Value, String> {
    let response = http
        .get(data_url(source, path)?)
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
fn verified_subject(http: &Client, token: &str, source: &str) -> Result<String, String> {
    if source == "oura" {
        let body = identity_json(http, token, source, "/v2/usercollection/personal_info", &[])?;
        return response_subject(source, "personal_info", &body).ok_or_else(|| {
            "Cannot verify Oura account ID; grant personal information access and reconnect".into()
        });
    }
    let body = identity_json(
        http,
        token,
        source,
        "/usersummary-service/usersummary/daily",
        &[(
            "calendarDate",
            chrono::Local::now().format("%Y-%m-%d").to_string(),
        )],
    )?;
    if let Some(subject) = response_subject(source, "daily_summary_legacy", &body) {
        return Ok(subject);
    }
    // A user may have no data today. An existing activity still identifies its
    // owner, independently of API-key rotation and mutable display names.
    let activities = identity_json(
        http,
        token,
        source,
        "/activitylist-service/activities/search/activities",
        &[("start", "0".into()), ("limit", "1".into())],
    )?;
    activities.as_array().and_then(|items| items.first()).and_then(|row| response_subject(source, "activities", row))
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
fn garmin_token(http: &Client, api_key: &str) -> Result<String, String> {
    let response = http
        .post(GARMIN_TOKEN)
        .header("Authorization", format!("ApiKey {api_key}"))
        .header("Accept", "*/*")
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
    let (_, account, hash) = identity(vault, source)?;
    if source == "garmin" {
        let api_key = field(params, "api_key")?;
        let epoch = begin_authorization(vault, &hash, source)?;
        let http = http_client()?;
        let token = garmin_token(&http, &api_key)?;
        let subject = verified_subject(&http, &token, source)?;
        let _lock = auth_lock(&hash, source)?;
        save_authorized(
            &Keychain,
            &account,
            &state_path(&hash, source)?,
            &epoch,
            &subject,
            &Credential::Garmin { api_key },
        )?;
        return Ok(json!({"source":"garmin","connected":true,"pending":false,"generation":epoch}));
    }
    let client_id = field(params, "client_id")?;
    let client_secret = field(params, "client_secret")?;
    let redirect_uri = match params.get("redirect_uri") {
        None | Some(Value::Null) => "http://127.0.0.1:8765/callback".into(),
        _ => field(params, "redirect_uri")?,
    };
    let url = redirect(&redirect_uri)?;
    let epoch = begin_authorization(vault, &hash, source)?;
    let authorization_path = state_path(&hash, source)?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, url.port_or_known_default().unwrap())).map_err(|_| "Cannot listen on the registered Oura loopback port; close another sign-in attempt or choose another registered port")?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "Cannot configure Oura callback listener")?;
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
                epoch: epoch.clone(),
                pending: true,
                error: None,
            },
        );
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
            let subject = verified_subject(&http, &field(&tokens, "access_token")?, "oura")?;
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
            save_authorized(
                &Keychain,
                &account,
                &authorization_path,
                &epoch,
                &subject,
                &credential,
            )
        });
        if let Ok(mut states) = pending().lock() {
            if let Some(current) = states.get_mut(&account).filter(|p| p.state == state) {
                current.pending = false;
                current.error = result.err();
            }
        }
    });
    Ok(json!({"source":"oura","authorize_url":authorize,"pending":true}))
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
            Ok(value) => entry["connected"] = json!(value.is_some()),
            Err(error) => entry["error"] = json!(error),
        }
        if let Some(error) = state.and_then(|p| p.error.as_ref()) {
            entry["error"] = json!(error);
        }
        result.insert((*source).into(), entry);
    }
    Value::Object(result)
}
pub fn status(vault: &Path) -> Result<Value, String> {
    let accounts = [
        ("garmin", identity(vault, "garmin")?.1),
        ("oura", identity(vault, "oura")?.1),
    ];
    let states = pending()
        .lock()
        .map_err(|_| "Authentication state is unavailable")?
        .clone();
    let mut result = status_with(&Keychain, &accounts, &states);
    for (source, account) in &accounts {
        let hash = identity(vault, source)?.2;
        let state = read_state(&state_path(&hash, source)?)?;
        result[*source]["generation"] = json!(state.as_ref().map(|s| s.epoch.as_str()));
        result[*source]["identity_verified"] =
            json!(state.as_ref().and_then(|s| s.subject.as_ref()).is_some());
        if !state
            .as_ref()
            .is_some_and(|s| s.authorized && s.subject.is_some())
        {
            result[*source]["connected"] = json!(false);
        }
        if states
            .get(account)
            .is_some_and(|p| state.as_ref().is_none_or(|s| s.epoch != p.epoch))
        {
            result[*source]["pending"] = json!(false);
            result[*source]["error"] = json!("Authorization was cancelled or replaced");
        }
    }
    Ok(result)
}
pub fn disconnect(vault: &Path, source: &str) -> Result<Value, String> {
    let (_, account, hash) = identity(vault, source)?;
    let _lock = auth_lock(&hash, source)?;
    let path = state_path(&hash, source)?;
    let subject = read_state(&path)?.and_then(|s| s.subject);
    let epoch = random_string(32);
    write_state(
        &path,
        &AuthorizationState {
            epoch: epoch.clone(),
            subject,
            authorized: false,
        },
    )?;
    pending()
        .lock()
        .map_err(|_| "Authentication state is unavailable")?
        .remove(&account);
    Keychain.delete(&account)?;
    Ok(json!({"source":source,"connected":false,"pending":false,"generation":epoch}))
}

pub struct ApiClient {
    source: String,
    account: String,
    hash: String,
    token: String,
    epoch: String,
    http: Client,
}
pub fn client(vault: &Path, source: &str) -> Result<ApiClient, String> {
    let (_, account, hash) = identity(vault, source)?;
    let http = http_client()?;
    let (token, epoch) = {
        let _lock = auth_lock(&hash, source)?;
        let state = active_state(&state_path(&hash, source)?)?;
        (load_token(&Keychain, &account, &http, None)?, state.epoch)
    };
    Ok(ApiClient {
        source: source.into(),
        account,
        hash,
        token,
        epoch,
        http,
    })
}
fn load_token(
    store: &dyn SecretStore,
    account: &str,
    http: &Client,
    rejected: Option<&str>,
) -> Result<String, String> {
    let credential = store.get(account)?.ok_or("Provider is not connected")?;
    match credential {
        Credential::Garmin { api_key } => garmin_token(http, &api_key),
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

fn data_url(source: &str, path: &str) -> Result<Url, String> {
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
        "https://personal.connectapi.garmin.com"
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
    pub fn generation(&self) -> &str {
        &self.epoch
    }
    /// Call again immediately before committing a completed provider window.
    pub fn ensure_current(&self) -> Result<(), String> {
        let state = epoch_matches(&state_path(&self.hash, &self.source)?, &self.epoch)?;
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
        let url = data_url(&self.source, path)?;
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
                epoch_matches(&state_path(&self.hash, &self.source)?, &self.epoch)?;
                self.token = load_token(&Keychain, &self.account, &self.http, Some(&self.token))?;
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
            assert!(data_url("oura", path).is_err());
        }
        assert_eq!(
            data_url("oura", "/v2/usercollection/sleep")
                .unwrap()
                .host_str(),
            Some("api.ouraring.com")
        );
        assert!(data_url("other", "/x").is_err());
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
                Some("old-access")
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
                api_key: "different-person-key".into()
            }
        )
        .is_err());
        assert!(
            matches!(store.get("account").unwrap(),Some(Credential::Garmin{api_key}) if api_key=="rotated-key")
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
        assert_eq!(
            archived_subject(&vault, "garmin", true).unwrap().as_deref(),
            Some("garmin:123")
        );
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
}
