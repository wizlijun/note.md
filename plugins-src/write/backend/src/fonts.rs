//! On-demand, verified Sumi fonts in the application's private cache.
//! Merely listing fonts or asking for local files never starts a download.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    future::Future,
    io::{Cursor, Read, Write},
    path::PathBuf,
    pin::Pin,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};
use tokio::sync::watch;

type Result<T> = std::result::Result<T, String>;
const MAX_BYTES: u64 = 64 * 1024 * 1024;
use sumi_protocol::fonts::{expected_postscript, ALIASES};
pub use sumi_protocol::fonts::{FontFile, FontRequest, FontResponse, FontStatus};
#[derive(Clone, Deserialize)]
struct Asset {
    file: String,
    size: u64,
    sha256: String,
    postscript: Option<String>,
    url: Option<String>,
    archive_size: Option<u64>,
    archive_sha256: Option<String>,
}
impl Asset {
    fn transfer_size(&self) -> u64 {
        self.archive_size.unwrap_or(self.size)
    }
    fn transfer_hash(&self) -> &str {
        self.archive_sha256.as_deref().unwrap_or(&self.sha256)
    }
}
#[derive(Deserialize)]
struct Manifest {
    cascades: HashMap<String, Vec<String>>,
    assets: Vec<Asset>,
}
static MANIFEST: LazyLock<Manifest> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../resources/sumi/manifest.json"))
        .expect("trusted Sumi font manifest")
});
type Progress = Arc<dyn Fn(u64) + Send + Sync>;
type FetchFuture = Pin<Box<dyn Future<Output = Result<Vec<u8>>> + Send>>;
trait Downloader: Send + Sync {
    fn fetch(&self, asset: Asset, progress: Progress) -> FetchFuture;
}
struct HttpsDownloader;
impl Downloader for HttpsDownloader {
    fn fetch(&self, asset: Asset, progress: Progress) -> FetchFuture {
        Box::pin(async move {
            let url = reqwest::Url::parse(asset.url.as_deref().ok_or("Missing font URL")?)
                .map_err(|e| e.to_string())?;
            if url.scheme() != "https" {
                return Err("Font URL must use HTTPS".into());
            }
            let client = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(20))
                .read_timeout(Duration::from_secs(60))
                .no_gzip()
                .no_brotli()
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    if attempt.url().scheme() != "https" {
                        attempt.error("Font redirect must use HTTPS")
                    } else if attempt.previous().len() >= 5 {
                        attempt.error("Too many font redirects")
                    } else {
                        attempt.follow()
                    }
                }))
                .build()
                .map_err(|e| e.to_string())?;
            let mut response = client
                .get(url)
                .send()
                .await
                .map_err(|e| e.to_string())?
                .error_for_status()
                .map_err(|e| e.to_string())?;
            let limit = asset.transfer_size();
            if response.content_length().is_some_and(|n| n != limit) {
                return Err("Font download size differs".into());
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
                if bytes.len() as u64 + chunk.len() as u64 > limit {
                    return Err("Font download exceeds expected size".into());
                }
                bytes.extend_from_slice(&chunk);
                progress(bytes.len() as u64);
            }
            if bytes.len() as u64 != limit {
                return Err("Incomplete font download".into());
            }
            Ok(bytes)
        })
    }
}
struct State {
    status: FontStatus,
    task: Option<watch::Receiver<Option<Result<()>>>>,
}
struct Inner {
    verified: Arc<Mutex<HashMap<PathBuf, FileStamp>>>,
    cache: PathBuf,
    catalog: HashMap<String, Vec<Asset>>,
    downloader: Arc<dyn Downloader>,
    states: Mutex<HashMap<String, State>>,
}
#[derive(Clone)]
pub struct Manager {
    inner: Arc<Inner>,
}
impl Manager {
    /// Typed service dispatch; status and files never initiate network requests.
    pub async fn request(&self, request: FontRequest) -> Result<FontResponse> {
        match request {
            FontRequest::Statuses => Ok(FontResponse::Statuses {
                statuses: self.statuses().await?,
            }),
            FontRequest::Files { family } => Ok(FontResponse::Files {
                files: self.files(&family).await?,
            }),
            FontRequest::Download { family } => {
                self.download(&family).await?;
                Ok(FontResponse::Downloaded)
            }
        }
    }
    pub fn new(cache_dir: PathBuf) -> Self {
        let manifest = &*MANIFEST;
        assert_eq!(manifest.cascades.len(), ALIASES.len(), "catalog aliases");
        for alias in ALIASES {
            assert_eq!(
                manifest.cascades[alias],
                expected_postscript(alias).unwrap(),
                "catalog face identity"
            );
        }
        let catalog = ALIASES
            .into_iter()
            .map(|alias| {
                let assets = manifest.cascades[alias]
                    .iter()
                    .map(|face| {
                        manifest
                            .assets
                            .iter()
                            .find(|a| a.postscript.as_ref() == Some(face))
                            .expect("catalog face")
                            .clone()
                    })
                    .collect();
                (alias.to_owned(), assets)
            })
            .collect();
        Self::with_downloader(cache_dir, catalog, Arc::new(HttpsDownloader))
    }
    fn with_downloader(
        cache: PathBuf,
        catalog: HashMap<String, Vec<Asset>>,
        downloader: Arc<dyn Downloader>,
    ) -> Self {
        for assets in catalog.values() {
            for asset in assets {
                assert!(
                    asset.file
                        == std::path::Path::new(&asset.file)
                            .file_name()
                            .unwrap()
                            .to_string_lossy()
                        && !asset.file.starts_with('.')
                );
                assert!(
                    asset.size > 0
                        && asset.size <= MAX_BYTES
                        && asset.transfer_size() > 0
                        && asset.transfer_size() <= MAX_BYTES
                );
                assert!(asset.archive_size.is_some() == asset.archive_sha256.is_some());
            }
        }
        Self {
            inner: Arc::new(Inner {
                verified: Arc::new(Mutex::new(HashMap::new())),
                cache,
                catalog,
                downloader,
                states: Mutex::new(HashMap::new()),
            }),
        }
    }
    fn assets(&self, alias: &str) -> Result<Vec<Asset>> {
        self.inner
            .catalog
            .get(alias)
            .cloned()
            .ok_or_else(|| "Unknown Sumi font family".into())
    }
    fn status(&self, alias: &str, assets: &[Asset], phase: &str) -> FontStatus {
        FontStatus {
            family: alias.into(),
            status: phase.into(),
            downloaded_bytes: 0,
            total_bytes: assets.iter().map(Asset::transfer_size).sum(),
            error: None,
        }
    }
    pub async fn files(&self, alias: &str) -> Result<Option<Vec<FontFile>>> {
        let assets = self.assets(alias)?;
        let cache = self.inner.cache.clone();
        let verified = self.inner.verified.clone();
        tokio::task::spawn_blocking(move || cached_files(&cache, &assets, &verified))
            .await
            .map_err(|e| e.to_string())?
    }
    pub async fn statuses(&self) -> Result<Vec<FontStatus>> {
        let mut result = Vec::new();
        for alias in ALIASES {
            if let Some(assets) = self.inner.catalog.get(alias) {
                let existing = self
                    .inner
                    .states
                    .lock()
                    .map_err(|e| e.to_string())?
                    .get(alias)
                    .map(|s| s.status.clone());
                if let Some(status) = existing.as_ref().filter(|s| s.status == "downloading") {
                    result.push(status.clone());
                    continue;
                }
                let ready = self.files(alias).await?.is_some();
                let mut status = if ready {
                    self.status(alias, assets, "ready")
                } else {
                    existing
                        .filter(|s| s.status == "error")
                        .unwrap_or_else(|| self.status(alias, assets, "not_downloaded"))
                };
                if ready {
                    status.downloaded_bytes = status.total_bytes;
                }
                result.push(status);
            }
        }
        Ok(result)
    }
    /// Registers downloading state synchronously, then returns without waiting
    /// for network I/O. The shared worker outlives all request waiters.
    pub fn start_download(&self, alias: &str) -> Result<()> {
        self.subscribe_download(alias)?;
        Ok(())
    }
    fn subscribe_download(&self, alias: &str) -> Result<watch::Receiver<Option<Result<()>>>> {
        let assets = self.assets(alias)?;
        let receiver = {
            let mut states = self.inner.states.lock().map_err(|e| e.to_string())?;
            if let Some(receiver) = states.get(alias).and_then(|s| s.task.clone()) {
                receiver
            } else {
                let (sender, receiver) = watch::channel(None);
                states.insert(
                    alias.into(),
                    State {
                        status: self.status(alias, &assets, "downloading"),
                        task: Some(receiver.clone()),
                    },
                );
                let manager = self.clone();
                let alias = alias.to_owned();
                // Independent worker survives a cancelled caller; all callers observe one result.
                tokio::spawn(async move {
                    let worker = manager.clone();
                    let family = alias.clone();
                    let outcome =
                        tokio::spawn(async move { worker.install(&family, assets).await })
                            .await
                            .map_err(|e| e.to_string())
                            .and_then(|value| value);
                    if let Ok(mut states) = manager.inner.states.lock() {
                        if let Some(state) = states.get_mut(&alias) {
                            state.status.status =
                                if outcome.is_ok() { "ready" } else { "error" }.into();
                            state.status.error = outcome.as_ref().err().cloned();
                            if outcome.is_ok() {
                                state.status.downloaded_bytes = state.status.total_bytes;
                            }
                            state.task = None;
                        }
                    }
                    let _ = sender.send(Some(outcome));
                });
                receiver
            }
        };
        Ok(receiver)
    }
    pub async fn download(&self, alias: &str) -> Result<()> {
        let mut receiver = self.subscribe_download(alias)?;
        loop {
            if let Some(result) = receiver.borrow().clone() {
                return result;
            }
            receiver
                .changed()
                .await
                .map_err(|_| "Font download task ended unexpectedly".to_string())?;
        }
    }
    async fn install(&self, alias: &str, assets: Vec<Asset>) -> Result<()> {
        let mut completed = 0;
        for asset in assets {
            let cache = self.inner.cache.clone();
            let check = asset.clone();
            let verified = self.inner.verified.clone();
            let ready =
                tokio::task::spawn_blocking(move || cached_files(&cache, &[check], &verified))
                    .await
                    .map_err(|e| e.to_string())??
                    .is_some();
            if !ready {
                let manager = self.clone();
                let alias = alias.to_owned();
                let progress: Progress = Arc::new(move |bytes| {
                    if let Ok(mut states) = manager.inner.states.lock() {
                        if let Some(state) = states.get_mut(&alias) {
                            state.status.downloaded_bytes = completed + bytes;
                        }
                    }
                });
                let bytes = self.inner.downloader.fetch(asset.clone(), progress).await?;
                let cache = self.inner.cache.clone();
                let install = asset.clone();
                tokio::task::spawn_blocking(move || install_file(&cache, &install, bytes))
                    .await
                    .map_err(|e| e.to_string())??;
            }
            completed += asset.transfer_size();
            if let Some(state) = self
                .inner
                .states
                .lock()
                .map_err(|e| e.to_string())?
                .get_mut(alias)
            {
                state.status.downloaded_bytes = completed;
            }
        }
        Ok(())
    }
}
fn verify(bytes: &[u8], size: u64, hash: &str) -> Result<()> {
    if bytes.len() as u64 != size || format!("{:x}", Sha256::digest(bytes)) != hash {
        return Err("Font size or SHA-256 verification failed".into());
    }
    Ok(())
}
#[derive(Clone, PartialEq, Eq)]
struct FileStamp {
    len: u64,
    modified: Option<std::time::SystemTime>,
    created: Option<std::time::SystemTime>,
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    ctime: (i64, i64),
}
fn stamp(metadata: &std::fs::Metadata) -> FileStamp {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    FileStamp {
        len: metadata.len(),
        modified: metadata.modified().ok(),
        created: metadata.created().ok(),
        #[cfg(unix)]
        dev: metadata.dev(),
        #[cfg(unix)]
        inode: metadata.ino(),
        #[cfg(unix)]
        ctime: (metadata.ctime(), metadata.ctime_nsec()),
    }
}
#[cfg(test)]
fn local_files(cache: &std::path::Path, assets: &[Asset]) -> Result<Option<Vec<FontFile>>> {
    cached_files(cache, assets, &Mutex::new(HashMap::new()))
}
fn cached_files(
    cache: &std::path::Path,
    assets: &[Asset],
    verified: &Mutex<HashMap<PathBuf, FileStamp>>,
) -> Result<Option<Vec<FontFile>>> {
    let mut files = Vec::new();
    for asset in assets {
        let path = cache.join(&asset.sha256).join(&asset.file);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(value) => value,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.to_string()),
        };
        if !metadata.is_file() || metadata.len() != asset.size {
            return Ok(None);
        }
        let current = stamp(&metadata);
        let cached = verified
            .lock()
            .map_err(|e| e.to_string())?
            .get(&path)
            .cloned();
        if cached.as_ref() != Some(&current) {
            verified.lock().map_err(|e| e.to_string())?.remove(&path);
            let mut bytes = Vec::new();
            std::fs::File::open(&path)
                .map_err(|e| e.to_string())?
                .take(asset.size + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if verify(&bytes, asset.size, &asset.sha256).is_err() {
                return Ok(None);
            }
            if stamp(&std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?) != current {
                return Ok(None);
            }
            verified
                .lock()
                .map_err(|e| e.to_string())?
                .insert(path.clone(), current);
        }
        files.push(FontFile {
            path,
            postscript: asset.postscript.clone().ok_or("Missing font face")?,
        });
    }
    Ok(Some(files))
}
fn install_file(cache: &std::path::Path, asset: &Asset, bytes: Vec<u8>) -> Result<()> {
    verify(&bytes, asset.transfer_size(), asset.transfer_hash())?;
    let bytes = if asset.archive_size.is_some() {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
        // The pinned Zhuque release contains exactly this one root-level font.
        if archive.len() != 1 {
            return Err("Unexpected font archive structure".into());
        }
        let member = archive.by_index(0).map_err(|e| e.to_string())?;
        if member.name() != asset.file || member.enclosed_name().is_none() {
            return Err("Unexpected font archive member".into());
        }
        if member.is_dir() || member.size() != asset.size {
            return Err("Unexpected archived font size".into());
        }
        let mut output = Vec::new();
        member
            .take(asset.size + 1)
            .read_to_end(&mut output)
            .map_err(|e| e.to_string())?;
        output
    } else {
        bytes
    };
    verify(&bytes, asset.size, &asset.sha256)?;
    let directory = cache.join(&asset.sha256);
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let temporary = directory.join(format!(".partial-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        std::fs::rename(&temporary, directory.join(&asset.file)).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

/// Supported UI aliases only; no caller-provided paths or URLs are accepted.
pub fn known_font(alias: &str) -> bool {
    ALIASES.contains(&alias) && MANIFEST.cascades.contains_key(alias)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Fixture {
        bytes: Mutex<Vec<u8>>,
        calls: AtomicUsize,
        gate: Arc<tokio::sync::Semaphore>,
    }
    impl Downloader for Fixture {
        fn fetch(&self, _: Asset, progress: Progress) -> FetchFuture {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let bytes = self.bytes.lock().unwrap().clone();
            let gate = self.gate.clone();
            progress((bytes.len() / 2) as u64);
            Box::pin(async move {
                let _permit = gate.acquire().await.map_err(|e| e.to_string())?;
                progress(bytes.len() as u64);
                Ok(bytes)
            })
        }
    }
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("sumi-font-test-{}", uuid::Uuid::new_v4())))
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn asset(file: &str, bytes: &[u8]) -> Asset {
        Asset {
            file: file.into(),
            size: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
            postscript: Some(file.into()),
            url: Some("https://example.invalid/fixture".into()),
            archive_size: None,
            archive_sha256: None,
        }
    }
    fn manager(temp: &Temp, assets: Vec<Asset>, bytes: &[u8]) -> (Manager, Arc<Fixture>) {
        let downloader = Arc::new(Fixture {
            bytes: Mutex::new(bytes.to_vec()),
            calls: AtomicUsize::new(0),
            gate: Arc::new(tokio::sync::Semaphore::new(100)),
        });
        (
            Manager::with_downloader(
                temp.0.clone(),
                HashMap::from([("Sumi Plex".into(), assets)]),
                downloader.clone(),
            ),
            downloader,
        )
    }
    #[test]
    fn catalog_only_six_selected_presets_with_bounded_https_assets() {
        let temp = Temp::new();
        let manager = Manager::new(temp.0.clone());
        assert_eq!(manager.inner.catalog.len(), 6);
        assert!(known_font("Sumi CRT"));
        assert_eq!(
            manager
                .assets("Sumi CRT")
                .unwrap()
                .iter()
                .map(|a| a.postscript.as_deref().unwrap())
                .collect::<Vec<_>>(),
            vec!["Unifont"]
        );
        assert!(known_font("Sumi Zhaohua"));
        assert!(!known_font("../../bad"));
        for assets in manager.inner.catalog.values() {
            for asset in assets {
                assert!(asset.url.as_ref().unwrap().starts_with("https://"));
                assert_eq!(asset.sha256.len(), 64);
            }
        }
        assert_eq!(manager.assets("Sumi Plex").unwrap().len(), 2);
    }
    #[tokio::test]
    async fn missing_listing_never_downloads_unknown_family_rejected() {
        let temp = Temp::new();
        let (m, d) = manager(&temp, vec![asset("one.ttf", b"font")], b"font");
        assert_eq!(m.statuses().await.unwrap()[0].status, "not_downloaded");
        assert!(m.files("Sumi Plex").await.unwrap().is_none());
        assert!(m.download("https://arbitrary.invalid").await.is_err());
        assert!(m.files("../bad").await.is_err());
        assert_eq!(d.calls.load(Ordering::SeqCst), 0);
        assert!(!temp.0.exists());
    }
    #[tokio::test]
    async fn typed_service_dispatch_preserves_read_only_queries_and_download_result() {
        let temp = Temp::new();
        let (m, d) = manager(&temp, vec![asset("one.ttf", b"font")], b"font");
        let request: FontRequest = serde_json::from_value(serde_json::json!({
            "operation": "files", "family": "Sumi Plex"
        }))
        .unwrap();
        assert_eq!(
            m.request(request).await.unwrap(),
            FontResponse::Files { files: None }
        );
        let FontResponse::Statuses { statuses } = m.request(FontRequest::Statuses).await.unwrap()
        else {
            panic!("typed status response");
        };
        assert_eq!(statuses[0].status, "not_downloaded");
        assert_eq!(d.calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            m.request(FontRequest::Download {
                family: "Sumi Plex".into()
            })
            .await
            .unwrap(),
            FontResponse::Downloaded
        );
        let FontResponse::Files { files: Some(files) } = m
            .request(FontRequest::Files {
                family: "Sumi Plex".into(),
            })
            .await
            .unwrap()
        else {
            panic!("typed ready files response");
        };
        assert!(files[0].path.starts_with(&temp.0));
        let wire = serde_json::to_value(&files).unwrap();
        assert_eq!(
            serde_json::from_value::<Vec<FontFile>>(wire).unwrap(),
            files
        );
        assert_eq!(d.calls.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn nonblocking_start_sets_downloading_before_first_poll_and_deduplicates() {
        let temp = Temp::new();
        let (m, d) = manager(&temp, vec![asset("one.ttf", b"font")], b"font");
        d.gate.forget_permits(100);
        m.start_download("Sumi Plex").unwrap();
        assert_eq!(
            m.inner.states.lock().unwrap()["Sumi Plex"].status.status,
            "downloading"
        );
        m.start_download("Sumi Plex").unwrap();
        assert_eq!(m.statuses().await.unwrap()[0].status, "downloading");
        assert!(m.start_download("not-a-family").is_err());
        d.gate.add_permits(1);
        m.download("Sumi Plex").await.unwrap();
        assert_eq!(d.calls.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn concurrent_calls_share_download_progress_and_cache_hit() {
        let temp = Temp::new();
        let (m, d) = manager(&temp, vec![asset("one.ttf", b"font-data")], b"font-data");
        d.gate.forget_permits(100);
        let first = m.clone();
        let second = m.clone();
        let a = tokio::spawn(async move { first.download("Sumi Plex").await });
        let b = tokio::spawn(async move { second.download("Sumi Plex").await });
        tokio::time::timeout(Duration::from_secs(2), async {
            while d.calls.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        let status = m.statuses().await.unwrap().remove(0);
        assert_eq!(status.status, "downloading");
        assert!(status.downloaded_bytes > 0 && status.downloaded_bytes < status.total_bytes);
        d.gate.add_permits(1);
        a.await.unwrap().unwrap();
        b.await.unwrap().unwrap();
        assert_eq!(d.calls.load(Ordering::SeqCst), 1);
        m.download("Sumi Plex").await.unwrap();
        assert_eq!(d.calls.load(Ordering::SeqCst), 1);
        let files = m.files("Sumi Plex").await.unwrap().unwrap();
        assert_eq!(files[0].postscript, "one.ttf");
        assert_eq!(std::fs::read(&files[0].path).unwrap(), b"font-data");
        assert_eq!(m.statuses().await.unwrap()[0].status, "ready");
    }
    #[tokio::test]
    async fn bad_download_and_corrupt_cache_are_retryable_not_ready() {
        let temp = Temp::new();
        let (m, d) = manager(&temp, vec![asset("one.ttf", b"good")], b"evil");
        assert!(m.download("Sumi Plex").await.is_err());
        assert!(m.files("Sumi Plex").await.unwrap().is_none());
        assert_eq!(m.statuses().await.unwrap()[0].status, "error");
        *d.bytes.lock().unwrap() = b"good".to_vec();
        m.download("Sumi Plex").await.unwrap();
        let path = m.files("Sumi Plex").await.unwrap().unwrap()[0].path.clone();
        std::fs::write(&path, b"evil").unwrap();
        assert!(m.files("Sumi Plex").await.unwrap().is_none());
        m.download("Sumi Plex").await.unwrap();
        assert_eq!(std::fs::read(path).unwrap(), b"good");
        assert_eq!(d.calls.load(Ordering::SeqCst), 3);
    }
    #[tokio::test]
    async fn validated_metadata_cache_reuses_stamp_and_invalidates_replaced_file() {
        let temp = Temp::new();
        let (m, d) = manager(&temp, vec![asset("one.ttf", b"good")], b"good");
        m.download("Sumi Plex").await.unwrap();
        let path = m.files("Sumi Plex").await.unwrap().unwrap()[0].path.clone();
        let original = m.inner.verified.lock().unwrap()[&path].clone();
        assert_eq!(m.statuses().await.unwrap()[0].status, "ready");
        assert!(m.inner.verified.lock().unwrap()[&path] == original);
        let replacement = path.with_extension("replacement");
        std::fs::write(&replacement, b"evil").unwrap();
        std::fs::rename(replacement, &path).unwrap();
        assert!(m.files("Sumi Plex").await.unwrap().is_none());
        assert!(!m.inner.verified.lock().unwrap().contains_key(&path));
        m.download("Sumi Plex").await.unwrap();
        assert!(m.files("Sumi Plex").await.unwrap().is_some());
        assert_eq!(d.calls.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn plex_requires_both_files_and_keeps_valid_first_file() {
        let temp = Temp::new();
        let a = asset("first.ttf", b"font");
        let b = asset("second.ttf", b"font");
        install_file(&temp.0, &a, b"font".to_vec()).unwrap();
        let (m, d) = manager(&temp, vec![a, b], b"font");
        assert!(m.files("Sumi Plex").await.unwrap().is_none());
        m.download("Sumi Plex").await.unwrap();
        assert_eq!(d.calls.load(Ordering::SeqCst), 1);
        assert_eq!(m.files("Sumi Plex").await.unwrap().unwrap().len(), 2);
    }
    #[tokio::test]
    async fn cancelling_waiter_does_not_cancel_shared_download() {
        let temp = Temp::new();
        let (m, d) = manager(&temp, vec![asset("one.ttf", b"font")], b"font");
        d.gate.forget_permits(100);
        let first = m.clone();
        let a = tokio::spawn(async move { first.download("Sumi Plex").await });
        tokio::time::timeout(Duration::from_secs(2), async {
            while d.calls.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        a.abort();
        d.gate.add_permits(1);
        m.download("Sumi Plex").await.unwrap();
        assert_eq!(d.calls.load(Ordering::SeqCst), 1);
    }
    fn zipped(names: &[&str], bytes: &[u8]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for name in names {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }
    #[test]
    fn archive_verified_before_single_bounded_font_extraction() {
        let temp = Temp::new();
        let mut a = asset("one.ttf", b"font");
        let bytes = zipped(&["one.ttf"], b"font");
        a.archive_size = Some(bytes.len() as u64);
        a.archive_sha256 = Some(format!("{:x}", Sha256::digest(&bytes)));
        install_file(&temp.0, &a, bytes.clone()).unwrap();
        assert!(local_files(&temp.0, &[a.clone()]).unwrap().is_some());
        assert!(!temp.0.join("LICENSE").exists());
        let mut corrupt = bytes;
        corrupt[0] ^= 1;
        assert!(install_file(&temp.0, &a, corrupt).is_err());
        for names in [
            vec!["a/one.ttf", "b/one.ttf"],
            vec!["../one.ttf"],
            vec!["other.ttf"],
            vec!["release/one.ttf"],
            vec!["one.ttf", "LICENSE"],
        ] {
            let bytes = zipped(&names, b"font");
            a.archive_size = Some(bytes.len() as u64);
            a.archive_sha256 = Some(format!("{:x}", Sha256::digest(&bytes)));
            assert!(install_file(&temp.0, &a, bytes).is_err());
        }
    }
    #[test]
    fn partial_files_and_symlinks_are_not_ready() {
        let temp = Temp::new();
        let a = asset("one.ttf", b"font");
        let dir = temp.0.join(&a.sha256);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".partial"), b"font").unwrap();
        assert!(local_files(&temp.0, &[a.clone()]).unwrap().is_none());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join(".partial"), dir.join(&a.file)).unwrap();
            assert!(local_files(&temp.0, &[a]).unwrap().is_none());
        }
    }
    #[tokio::test]
    #[ignore = "explicit real HTTPS acceptance; isolated temporary cache only"]
    async fn real_https_plex_mono_download_and_verified_cache() {
        struct CountHttps(Arc<AtomicUsize>);
        impl Downloader for CountHttps {
            fn fetch(&self, asset: Asset, progress: Progress) -> FetchFuture {
                self.0.fetch_add(1, Ordering::SeqCst);
                HttpsDownloader.fetch(asset, progress)
            }
        }
        let temp = Temp::new();
        let asset = MANIFEST
            .assets
            .iter()
            .find(|a| a.postscript.as_deref() == Some("IBMPlexMono-Light"))
            .unwrap()
            .clone();
        let calls = Arc::new(AtomicUsize::new(0));
        let manager = Manager::with_downloader(
            temp.0.clone(),
            HashMap::from([("Sumi Plex".into(), vec![asset.clone()])]),
            Arc::new(CountHttps(calls.clone())),
        );
        assert_eq!(
            manager.statuses().await.unwrap()[0].status,
            "not_downloaded"
        );
        assert!(manager.files("Sumi Plex").await.unwrap().is_none());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        tokio::time::timeout(Duration::from_secs(180), manager.download("Sumi Plex"))
            .await
            .unwrap()
            .unwrap();
        let files = manager.files("Sumi Plex").await.unwrap().unwrap();
        assert_eq!(files[0].postscript, "IBMPlexMono-Light");
        assert!(files[0].path.starts_with(&temp.0));
        verify(
            &std::fs::read(&files[0].path).unwrap(),
            asset.size,
            &asset.sha256,
        )
        .unwrap();
        manager.download("Sumi Plex").await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(manager.statuses().await.unwrap()[0].status, "ready");
        println!("HTTPS font acceptance: {} bytes, pinned SHA {}, one request; repeated download and status/files use verified private cache",asset.size,asset.sha256);
    }
}
