//! Host-side font bridge. Network, catalog and cache installation live in Sumi.
use super::service::{self, Connector};
use std::path::PathBuf;
pub use sumi_protocol::fonts::{known_font, FontFile, FontStatus};
use sumi_protocol::fonts::{expected_postscript, FontRequest, FontResponse};
type Result<T> = std::result::Result<T, String>;
#[derive(Clone)]
pub struct Manager { cache: PathBuf, connect: Connector }
impl Manager {
    pub fn new(cache: PathBuf, connect: Connector) -> Self { Self { cache, connect } }
    async fn request(&self, request: FontRequest) -> Result<FontResponse> {
        service::font_call(&self.connect, &self.cache, serde_json::to_value(request).map_err(super::err)?).await
    }
    pub async fn statuses(&self) -> Result<Vec<FontStatus>> {
        match self.request(FontRequest::Statuses).await? {
            FontResponse::Statuses { statuses } => Ok(statuses),
            _ => Err("无效的字体状态响应".into()),
        }
    }
    pub async fn files(&self, alias: &str) -> Result<Option<Vec<FontFile>>> {
        let expected = expected_postscript(alias).ok_or("未知字体组合")?;
        let FontResponse::Files { files } = self.request(FontRequest::Files { family: alias.into() }).await? else {
            return Err("无效的字体文件响应".into());
        };
        let Some(files) = files else { return Ok(None); };
        if files.len() != expected.len() { return Err("字体组合不完整".into()); }
        let cache = self.cache.canonicalize().map_err(super::err)?;
        for (file, expected) in files.iter().zip(expected) {
            let metadata = std::fs::symlink_metadata(&file.path).map_err(super::err)?;
            if file.postscript != *expected || !metadata.is_file() || metadata.file_type().is_symlink()
                || !file.path.canonicalize().map_err(super::err)?.starts_with(&cache) {
                return Err("字体文件不属于已授权的本地缓存".into());
            }
        }
        Ok(Some(files))
    }
    pub async fn download(&self, alias: &str) -> Result<()> {
        if !known_font(alias) { return Err("未知字体组合".into()); }
        self.request(FontRequest::Download { family: alias.into() }).await?;
        loop {
            let status = self.statuses().await?.into_iter().find(|s| s.family == alias).ok_or("缺少字体状态")?;
            match status.status.as_str() {
                "ready" => return Ok(()),
                "error" => return Err(status.error.unwrap_or_else(|| "字体下载失败，请重试".into())),
                // A backend restart preserves the user's explicit download intent.
                "not_downloaded" | "idle" => { self.request(FontRequest::Download { family: alias.into() }).await?; }
                _ => {}
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }
}
