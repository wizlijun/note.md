//! Narrow Keychain/authentication proxy. Only short-lived access tokens reach
//! the signed Sumi backend; long-lived device secrets never enter a WebView.
use super::{
    credentials::{self, Credentials},
    err, Result,
};
use serde::{de::DeserializeOwned, Deserialize};
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};
use sumi_protocol::sync::{AccessToken, Identity, Invitation};
type PendingRead =
    Arc<tokio::sync::Mutex<Option<tokio::task::JoinHandle<Result<Option<Credentials>>>>>>;
static LOADS: LazyLock<Mutex<HashMap<String, PendingRead>>> = LazyLock::new(Default::default);
static CACHE: LazyLock<Mutex<HashMap<String, Credentials>>> = LazyLock::new(Default::default);
fn identity(c: &Credentials) -> Identity {
    Identity {
        server_url: c.server_url.clone(),
        space_id: c.space_id.clone(),
        device_id: c.device_id.clone(),
    }
}
fn origin(server: &str) -> Result<url::Url> {
    let parsed = url::Url::parse(server).map_err(|_| "无效的Sumi服务地址")?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return Err("Sumi服务必须使用不含路径或凭据的HTTPS地址".into());
    }
    Ok(parsed)
}
fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|_| "Sumi认证连接不可用".into())
}
async fn response<T: DeserializeOwned>(mut response: reqwest::Response) -> Result<T> {
    if !response.status().is_success() {
        return Err(format!(
            "Sumi认证失败（HTTP {}）",
            response.status().as_u16()
        ));
    }
    if response.content_length().is_some_and(|n| n > 64 * 1024) {
        return Err("Sumi认证响应过大".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Sumi认证连接中断")? {
        if bytes.len() + chunk.len() > 64 * 1024 {
            return Err("Sumi认证响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "无效的Sumi认证响应".into())
}
async fn load(profile: &str) -> Result<Option<Credentials>> {
    load_with(profile, credentials::load).await
}
async fn load_with<F>(profile: &str, read: F) -> Result<Option<Credentials>>
where
    F: FnOnce(&str) -> Result<Option<Credentials>> + Send + 'static,
{
    // A restarted backend must join the current Keychain read, not open another
    // prompt while the first system authorization is still pending.
    let gate = LOADS
        .lock()
        .map_err(err)?
        .entry(profile.into())
        .or_default()
        .clone();
    let mut reading = gate.lock().await;
    if let Some(c) = CACHE.lock().map_err(err)?.get(profile).cloned() {
        return Ok(Some(c));
    }
    if reading.is_none() {
        let key = profile.to_owned();
        *reading = Some(tokio::task::spawn_blocking(move || read(&key)));
    }
    let completed = reading.as_mut().expect("pending Keychain read").await;
    *reading = None;
    let result = completed.map_err(|_| "Sumi钥匙串读取任务失败")??;
    if let Some(c) = &result {
        origin(&c.server_url)?;
        CACHE.lock().map_err(err)?.insert(profile.into(), c.clone());
    }
    Ok(result)
}
pub async fn load_identity(profile: &str) -> Result<Option<Identity>> {
    Ok(load(profile).await?.as_ref().map(identity))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Redeemed {
    space_id: String,
    device_id: String,
    device_secret: String,
}
pub async fn pair(profile: &str, server: &str, invitation: Invitation) -> Result<Identity> {
    let base = origin(server)?;
    uuid::Uuid::parse_str(&invitation.space_id).map_err(|_| "无效的配对空间")?;
    let data: Redeemed = response(
        client()?
            .post(base.join("v1/pair/redeem").map_err(err)?)
            .json(&invitation)
            .send()
            .await
            .map_err(|_| "Sumi配对连接失败")?,
    )
    .await?;
    if data.space_id != invitation.space_id {
        return Err("Sumi配对空间不一致".into());
    }
    let credential = Credentials::new(
        base.to_string(),
        data.space_id,
        data.device_id,
        data.device_secret,
    )?;
    save_with(profile, credential, credentials::save).await
}
async fn save_with<F>(profile: &str, credential: Credentials, save: F) -> Result<Identity>
where
    F: FnOnce(&str, &Credentials) -> Result<()> + Send + 'static,
{
    let gate = LOADS
        .lock()
        .map_err(err)?
        .entry(profile.into())
        .or_default()
        .clone();
    let mut reading = gate.lock_owned().await;
    // A canceled load retains its handle. Finish it before replacing the item,
    // otherwise its old result could later overwrite the newly paired identity.
    if let Some(pending) = reading.as_mut() {
        let _ = pending.await;
        *reading = None;
    }
    let key = profile.to_owned();
    tokio::task::spawn_blocking(move || {
        // Keep the per-profile gate through both OS storage and cache update,
        // even if the requesting backend is stopped while storage is pending.
        let _reading = reading;
        save(&key, &credential)?;
        let result = identity(&credential);
        CACHE.lock().map_err(err)?.insert(key, credential);
        Ok(result)
    })
    .await
    .map_err(|_| "Sumi钥匙串保存任务失败")?
}
pub async fn token(profile: &str, requested: Identity) -> Result<AccessToken> {
    let credential = load(profile).await?.ok_or("请先配对Sumi同步空间")?;
    if identity(&credential) != requested {
        return Err("Sumi后台认证身份已经改变".into());
    }
    let base = origin(&credential.server_url)?;
    let token:AccessToken=response(client()?.post(base.join("v1/token").map_err(err)?)
        .json(&serde_json::json!({"spaceId":credential.space_id,"deviceId":credential.device_id,"deviceSecret":credential.secret()}))
        .send().await.map_err(|_| "Sumi认证连接失败")?).await?;
    if token.access_token.is_empty()
        || token.access_token.len() > 2048
        || token.expires_at <= chrono::Utc::now().timestamp().max(0) as u64
    {
        return Err("Sumi服务返回了无效的短期凭证".into());
    }
    Ok(token)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn auth_origin_disallows_redirect_credentials_and_non_origin_urls() {
        assert!(origin("https://sync.example.com").is_ok());
        for url in [
            "http://sync.example.com",
            "https://u:p@sync.example.com",
            "https://sync.example.com/a",
            "https://sync.example.com/?token=a",
            "https://sync.example.com/#a",
        ] {
            assert!(origin(url).is_err());
        }
    }
    fn fixture() -> (String, Credentials) {
        (
            format!("auth-isolated-{}", uuid::Uuid::new_v4()),
            Credentials::new(
                "https://sync.example.test/".into(),
                uuid::Uuid::new_v4().to_string(),
                uuid::Uuid::new_v4().to_string(),
                "s".repeat(88),
            )
            .unwrap(),
        )
    }
    fn clear(profile: &str) {
        CACHE.lock().unwrap().remove(profile);
        LOADS.lock().unwrap().remove(profile);
    }
    #[tokio::test]
    async fn canceled_load_rejoins_the_same_blocking_read_and_then_uses_cache() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let (profile, credential) = fixture();
        let expected = identity(&credential);
        let reads = Arc::new(AtomicUsize::new(0));
        let (started, observed) = tokio::sync::oneshot::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        let first = tokio::spawn({
            let profile = profile.clone();
            let reads = reads.clone();
            async move {
                load_with(&profile, move |_| {
                    reads.fetch_add(1, Ordering::SeqCst);
                    let _ = started.send(());
                    blocked.recv().unwrap();
                    Ok(Some(credential))
                })
                .await
            }
        });
        observed.await.unwrap();
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        let resumed = tokio::spawn({
            let profile = profile.clone();
            async move { load_with(&profile, |_| panic!("must reuse pending read")).await }
        });
        release.send(()).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(2), resumed)
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(identity(&result), expected);
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        let cached = load_with(&profile, |_| panic!("must use cached result"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(identity(&cached), expected);
        let gate = LOADS.lock().unwrap()[&profile].clone();
        assert!(gate.lock().await.is_none());
        clear(&profile);
    }
    #[tokio::test]
    async fn failed_read_is_cleared_and_a_retry_can_succeed() {
        let (profile, credential) = fixture();
        assert_eq!(
            load_with(&profile, |_| Err("isolated read failed".into()))
                .await
                .unwrap_err(),
            "isolated read failed"
        );
        let gate = LOADS.lock().unwrap()[&profile].clone();
        assert!(gate.lock().await.is_none());
        assert_eq!(
            identity(
                &load_with(&profile, move |_| Ok(Some(credential.clone())))
                    .await
                    .unwrap()
                    .unwrap()
            )
            .server_url,
            "https://sync.example.test/"
        );
        clear(&profile);
    }
    #[tokio::test]
    async fn missing_credential_is_not_permanently_cached() {
        let (profile, credential) = fixture();
        assert!(load_with(&profile, |_| Ok(None)).await.unwrap().is_none());
        assert!(load_with(&profile, move |_| Ok(Some(credential)))
            .await
            .unwrap()
            .is_some());
        clear(&profile);
    }
    #[tokio::test]
    async fn identity_mismatch_rejects_before_network_or_keychain() {
        let (profile, mut credential) = fixture();
        // This invalid origin would fail if execution reached the exchange path.
        // A cache hit also prevents any OS credential lookup in this test.
        credential.server_url = "must-not-reach-network".into();
        let mut requested = identity(&credential);
        requested.device_id = uuid::Uuid::new_v4().to_string();
        CACHE.lock().unwrap().insert(profile.clone(), credential);
        assert_eq!(
            token(&profile, requested).await.unwrap_err(),
            "Sumi后台认证身份已经改变"
        );
        clear(&profile);
    }
    #[tokio::test]
    async fn error_responses_do_not_echo_remote_body_or_parse_details() {
        let secret = "private-device-secret-do-not-display";
        for (status, body, expected) in [
            (401, secret.to_owned(), "Sumi认证失败（HTTP 401）"),
            (302, secret.to_owned(), "Sumi认证失败（HTTP 302）"),
            (
                200,
                format!("{{\"access_token\":\"{secret}\",\"expires_at\":\"{secret}\"}}"),
                "无效的Sumi认证响应",
            ),
            (200, secret.repeat(3000), "Sumi认证响应过大"),
        ] {
            let raw = tauri::http::Response::builder()
                .status(status)
                .body(body)
                .unwrap();
            let error = response::<AccessToken>(reqwest::Response::from(raw))
                .await
                .unwrap_err();
            assert_eq!(error, expected);
            assert!(!error.contains(secret));
        }
    }

    #[tokio::test]
    async fn canceled_pair_save_waits_for_old_read_and_updates_cache_atomically() {
        let (profile, old) = fixture();
        let (_, replacement) = fixture();
        let expected = identity(&replacement);
        let (read_started, read_observed) = tokio::sync::oneshot::channel();
        let (read_release, read_blocked) = std::sync::mpsc::channel();
        let first = tokio::spawn({
            let profile = profile.clone();
            async move {
                load_with(&profile, move |_| {
                    let _ = read_started.send(());
                    read_blocked.recv().unwrap();
                    Ok(Some(old))
                })
                .await
            }
        });
        read_observed.await.unwrap();
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        let (write_started, mut write_observed) = tokio::sync::oneshot::channel();
        let (write_release, write_blocked) = std::sync::mpsc::channel();
        let saving = tokio::spawn({
            let profile = profile.clone();
            async move {
                save_with(&profile, replacement, move |_, _| {
                    let _ = write_started.send(());
                    write_blocked.recv().unwrap();
                    Ok(())
                })
                .await
            }
        });
        // Saving cannot overtake the canceled but still running Keychain read.
        assert!(
            tokio::time::timeout(Duration::from_millis(30), &mut write_observed)
                .await
                .is_err()
        );
        read_release.send(()).unwrap();
        write_observed.await.unwrap();
        saving.abort();
        assert!(saving.await.unwrap_err().is_cancelled());
        let mut loaded = tokio::spawn({
            let profile = profile.clone();
            async move { load_with(&profile, |_| panic!("saved identity must be cached")).await }
        });
        assert!(tokio::time::timeout(Duration::from_millis(30), &mut loaded)
            .await
            .is_err());
        write_release.send(()).unwrap();
        let actual = tokio::time::timeout(Duration::from_secs(2), loaded)
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(identity(&actual), expected);
        clear(&profile);
    }
}
