//! Talks to the native macOS hotkey helper.
//!
//! Electron cannot express Fn as an accelerator and neither can Tauri, because
//! the limitation is the OS: only a CGEventTap sees modifier keys pressed while
//! another app is frontmost. The helper is a small Swift process that owns that
//! tap and also performs the synthetic keystrokes, speaking newline-delimited
//! JSON over stdin and stdout. It carried over from the Electron build
//! unchanged.

use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::time::{timeout, Duration};

const SELECTION_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum HelperEvent {
    Ready,
    Key {
        phase: String,
        #[serde(rename = "keyCode")]
        key_code: i64,
    },
    Tap {
        active: bool,
        #[serde(default)]
        reason: Option<String>,
    },
    Permissions {
        accessibility: bool,
        #[serde(rename = "inputMonitoring")]
        input_monitoring: bool,
    },
    Paste {
        ok: bool,
        #[serde(default)]
        reason: Option<String>,
    },
    Selection {
        ok: bool,
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        reason: Option<String>,
    },
}

/// Maps a binding id to the macOS virtual key code the helper watches.
pub fn key_code_for(hotkey_id: &str) -> Option<i64> {
    Some(match hotkey_id {
        "fn" => 63,
        "right-command" => 54,
        "left-command" => 55,
        "right-option" => 61,
        "left-option" => 58,
        "right-control" => 62,
        "right-shift" => 60,
        _ => return None,
    })
}

pub struct HotkeyHelper {
    stdin: Mutex<Option<ChildStdin>>,
    /// Only one selection read may be outstanding: the helper drives the system
    /// pasteboard, so overlapping reads would race over one resource.
    pending_selection: Mutex<Option<oneshot::Sender<Result<String, String>>>>,
    running: Mutex<bool>,
}

impl HotkeyHelper {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            stdin: Mutex::new(None),
            pending_selection: Mutex::new(None),
            running: Mutex::new(false),
        })
    }

    pub async fn is_running(&self) -> bool {
        *self.running.lock().await
    }

    /// Spawns the helper and streams its events to `on_event`.
    pub async fn start<F>(self: &Arc<Self>, binary: PathBuf, on_event: F) -> Result<(), String>
    where
        F: Fn(HelperEvent) + Send + Sync + 'static,
    {
        let mut child = Command::new(&binary)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Could not start the hotkey helper: {error}"))?;

        let stdout = child.stdout.take().ok_or("Hotkey helper has no stdout.")?;
        *self.stdin.lock().await = child.stdin.take();
        *self.running.lock().await = true;

        let this = self.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                // Unknown or malformed lines are ignored rather than fatal, so a
                // future helper version cannot take the app down.
                let Ok(event) = serde_json::from_str::<HelperEvent>(trimmed) else {
                    continue;
                };
                if let HelperEvent::Selection { ok, text, reason } = &event {
                    this.settle_selection(*ok, text.clone(), reason.clone()).await;
                }
                on_event(event);
            }

            *this.running.lock().await = false;
            *this.stdin.lock().await = None;
            this.settle_selection(false, None, Some("stopped".into())).await;
        });

        Ok(())
    }

    pub async fn watch(&self, key_code: i64) {
        self.send(serde_json::json!({ "type": "watch", "keyCode": key_code }))
            .await;
    }

    pub async fn unwatch(&self) {
        self.send(serde_json::json!({ "type": "unwatch" })).await;
    }

    pub async fn paste(&self, text: &str) {
        self.send(serde_json::json!({ "type": "paste", "text": text }))
            .await;
    }

    pub async fn refresh_permissions(&self) {
        self.send(serde_json::json!({ "type": "permissions" })).await;
    }

    pub async fn request_permission(&self, scope: &str) {
        self.send(serde_json::json!({ "type": "request", "scope": scope }))
            .await;
    }

    /// Asks the helper to copy and return the focused app's selection.
    pub async fn request_selection(&self) -> Result<String, String> {
        {
            let pending = self.pending_selection.lock().await;
            if pending.is_some() {
                return Err("Already reading the selection.".into());
            }
        }

        let (sender, receiver) = oneshot::channel();
        *self.pending_selection.lock().await = Some(sender);
        self.send(serde_json::json!({ "type": "read-selection" })).await;

        match timeout(SELECTION_TIMEOUT, receiver).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => Err("Hotkey helper stopped.".into()),
            Err(_) => {
                *self.pending_selection.lock().await = None;
                Err("Timed out reading the selection.".into())
            }
        }
    }

    async fn settle_selection(&self, ok: bool, text: Option<String>, reason: Option<String>) {
        let Some(sender) = self.pending_selection.lock().await.take() else {
            return;
        };
        let outcome = match (ok, text) {
            (true, Some(text)) if !text.is_empty() => Ok(text),
            _ => Err(describe_selection_failure(reason.as_deref())),
        };
        let _ = sender.send(outcome);
    }

    async fn send(&self, command: serde_json::Value) {
        let mut guard = self.stdin.lock().await;
        let Some(stdin) = guard.as_mut() else { return };
        let line = format!("{command}\n");
        // A dead pipe surfaces as the reader task ending; nothing to do here.
        let _ = stdin.write_all(line.as_bytes()).await;
        let _ = stdin.flush().await;
    }
}

fn describe_selection_failure(reason: Option<&str>) -> String {
    match reason {
        Some("accessibility") => {
            "Accessibility permission is needed to read the selection.".into()
        }
        Some("empty") => "Select some text first.".into(),
        Some("stopped") => "Hotkey helper stopped.".into(),
        _ => "Could not read the selection.".into(),
    }
}

/// Finds the helper binary: bundled beside the app, or built into dist/ in dev.
pub fn find_helper(resource_dir: Option<&Path>, project_root: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(configured) = std::env::var("WAVEFORM_HOTKEY_BIN") {
        candidates.push(PathBuf::from(configured));
    }
    if let Some(dir) = resource_dir {
        candidates.push(dir.join("waveform-hotkey"));
    }
    candidates.push(project_root.join("dist/native/waveform-hotkey"));

    candidates.into_iter().find(|path| {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_bindings_to_virtual_key_codes() {
        assert_eq!(key_code_for("fn"), Some(63));
        assert_eq!(key_code_for("right-option"), Some(61));
        assert_eq!(key_code_for("none"), None);
        assert_eq!(key_code_for("f13"), None);
    }

    #[test]
    fn parses_the_helper_protocol() {
        let key: HelperEvent =
            serde_json::from_str(r#"{"type":"key","phase":"down","keyCode":63}"#).unwrap();
        assert!(matches!(key, HelperEvent::Key { key_code: 63, .. }));

        let permissions: HelperEvent = serde_json::from_str(
            r#"{"type":"permissions","accessibility":true,"inputMonitoring":false}"#,
        )
        .unwrap();
        assert!(matches!(
            permissions,
            HelperEvent::Permissions {
                accessibility: true,
                input_monitoring: false
            }
        ));

        let selection: HelperEvent =
            serde_json::from_str(r#"{"type":"selection","ok":false,"reason":"empty"}"#).unwrap();
        assert!(matches!(selection, HelperEvent::Selection { ok: false, .. }));
    }

    // A future helper version, or stray logging, must not be fatal.
    #[test]
    fn ignores_unknown_messages() {
        assert!(serde_json::from_str::<HelperEvent>(r#"{"type":"future-thing"}"#).is_err());
        assert!(serde_json::from_str::<HelperEvent>("not json").is_err());
    }

    #[test]
    fn explains_selection_failures() {
        assert!(describe_selection_failure(Some("empty")).contains("Select some text"));
        assert!(describe_selection_failure(Some("accessibility")).contains("Accessibility"));
        assert!(describe_selection_failure(None).contains("Could not read"));
    }
}
