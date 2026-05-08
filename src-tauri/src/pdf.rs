//! PDF export via WKWebView's createPDF API.
//!
//! Frontend hands us a fully-rendered, self-contained HTML document plus a
//! base URL (file:// of the source file's directory, used so relative-path
//! images can resolve). We spin up an offscreen WKWebView on the main
//! thread, load the HTML, wait for navigation completion, call createPDF,
//! and write the result to the user-chosen path.

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn export_pdf(
    app: tauri::AppHandle,
    html: String,
    output_path: String,
    base_url: String,
) -> Result<String, String> {
    // Stub: Task 6 implements the real WKWebView path.
    let _ = (app, html, base_url);
    Err(format!(
        "export_pdf is not yet implemented (would have written to {})",
        output_path
    ))
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn export_pdf(
    _app: tauri::AppHandle,
    _html: String,
    _output_path: String,
    _base_url: String,
) -> Result<String, String> {
    Err("PDF export is only supported on macOS".into())
}
