//! Optional system-wide-for-this-user fonts for built-in Markdown themes.
use serde::Serialize;

#[derive(Serialize)]
pub struct ThemeFontStatus {
    installed: usize,
    total: usize,
}

#[tauri::command]
pub fn theme_font_status() -> Result<ThemeFontStatus, String> {
    #[cfg(target_os = "macos")]
    {
        let (installed, total) = notemd_fonts::installed_count("effie")?;
        Ok(ThemeFontStatus { installed, total })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(ThemeFontStatus {
            installed: 0,
            total: 0,
        })
    }
}

#[tauri::command]
pub async fn theme_font_download() -> Result<ThemeFontStatus, String> {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(|| notemd_fonts::install("effie", |_| {}))
            .await
            .map_err(|error| format!("font worker failed: {error}"))??;
        theme_font_status()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("system font installation is only available on macOS".into())
    }
}
