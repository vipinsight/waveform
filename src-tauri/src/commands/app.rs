//! The window asking about the app it is running in.

use crate::bundle::app_display_name;
use crate::windows::present_main_window;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub async fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    present_main_window(&app);
    Ok(())
}

#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// The name on the Dock, the menu bar and the window. The checkout build is
/// "Waveform Dev" so it is not the copy in /Applications; a release is
/// "Waveform". Read from the bundle rather than compiled in, because the two
/// share this binary and disagree only in the Info.plist `pnpm app` writes.
#[tauri::command]
pub fn app_name() -> String {
    app_display_name()
}

/// Opens an address in the system browser. The settings window must not
/// navigate itself, so About's links hand the URL over instead.
#[tauri::command]
pub fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !is_web_url(&url) {
        return Err("Only web addresses can be opened.".into());
    }
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|error| error.to_string())
}

fn is_web_url(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_addresses_are_opened() {
        assert!(is_web_url("https://vipinyadav.com"));
        assert!(is_web_url("http://example.com"));
        assert!(!is_web_url("file:///etc/passwd"));
        assert!(!is_web_url("javascript:alert(1)"));
    }
}
