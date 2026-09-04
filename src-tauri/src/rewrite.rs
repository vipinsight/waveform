//! OpenRouter rewriting, and the API key it needs.
//!
//! The key is a bearer credential: it is held in the keychain, never written in
//! the clear, and never returned to a window. Callers pass text and get text
//! back, so the credential travels no further than it must.

use crate::settings::SettingsStore;
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::Mutex;

const ENDPOINT: &str = "https://openrouter.ai/api/v1/chat/completions";
const SERVICE: &str = "com.webtiara.waveform";
const ACCOUNT: &str = "openrouter-api-key";
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub has_api_key: bool,
    /// True when the key could not reach the keychain and lives only in memory.
    pub memory_only: bool,
}

pub struct Rewriter {
    settings: Arc<Mutex<SettingsStore>>,
    key: Mutex<Option<String>>,
    memory_only: Mutex<bool>,
}

impl Rewriter {
    pub fn new(settings: Arc<Mutex<SettingsStore>>) -> Arc<Self> {
        Arc::new(Self {
            settings,
            key: Mutex::new(keychain::read()),
            memory_only: Mutex::new(false),
        })
    }

    pub async fn status(&self) -> AiStatus {
        AiStatus {
            has_api_key: self.key.lock().await.is_some(),
            memory_only: *self.memory_only.lock().await,
        }
    }

    pub async fn is_configured(&self) -> bool {
        self.key.lock().await.is_some()
    }

    pub async fn set_key(&self, key: &str) -> AiStatus {
        let trimmed = key.trim();
        if trimmed.is_empty() {
            return self.clear_key().await;
        }

        *self.key.lock().await = Some(trimmed.to_string());
        *self.memory_only.lock().await = !keychain::write(trimmed);
        self.status().await
    }

    pub async fn clear_key(&self) -> AiStatus {
        *self.key.lock().await = None;
        *self.memory_only.lock().await = false;
        keychain::delete();
        self.status().await
    }

    /// Cleans up a dictated phrase. `None` means the feature is switched off.
    pub async fn clean_up_dictation(&self, text: &str) -> Result<Option<String>, String> {
        let settings = self.settings.lock().await.value();
        if !settings.transform_on_dictate || !self.is_configured().await {
            return Ok(None);
        }
        self.run(&settings.transform_prompt, text).await.map(Some)
    }

    pub async fn polish(&self, text: &str) -> Result<String, String> {
        let prompt = self.settings.lock().await.value().polish_prompt;
        self.run(&prompt, text).await
    }

    async fn run(&self, system_prompt: &str, text: &str) -> Result<String, String> {
        if text.trim().is_empty() {
            return Ok(String::new());
        }
        let key = self
            .key
            .lock()
            .await
            .clone()
            .ok_or("Add an OpenRouter API key in Settings first.")?;
        let model = self.settings.lock().await.value().open_router_model;

        let response = reqwest::Client::new()
            .post(ENDPOINT)
            .bearer_auth(&key)
            .header("HTTP-Referer", "https://github.com/vipiny35/local-speech")
            .header("X-Title", "Waveform")
            .json(&serde_json::json!({
                "model": model,
                "messages": [
                    { "role": "system", "content": system_prompt },
                    { "role": "user", "content": text },
                ],
                // Rewrites should be faithful, not creative.
                "temperature": 0.2,
            }))
            .timeout(TIMEOUT)
            .send()
            .await
            .map_err(|error| format!("OpenRouter request failed: {error}"))?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(describe_failure(status.as_u16(), &body));
        }

        let rewritten = extract_message(&body)?;
        // An empty rewrite would silently wipe the text; keep the original.
        Ok(if rewritten.is_empty() {
            text.to_string()
        } else {
            rewritten
        })
    }
}

fn extract_message(body: &str) -> Result<String, String> {
    let parsed: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| "OpenRouter returned a response that was not JSON.".to_string())?;

    let content = parsed
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str());

    match content {
        Some(text) if !text.trim().is_empty() => Ok(unwrap_text(text.trim())),
        _ => Err(parsed
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(|message| message.as_str())
            .unwrap_or("OpenRouter returned no text.")
            .to_string()),
    }
}

/// Models wrap rewrites in fences or quotes despite being told not to; pasting
/// the wrapper would be worse than pasting the original.
fn unwrap_text(text: &str) -> String {
    let mut inner = text;
    if inner.starts_with("```") && inner.ends_with("```") {
        if let Some(body) = inner
            .strip_prefix("```")
            .and_then(|rest| rest.split_once('\n'))
            .map(|(_, body)| body)
            .and_then(|body| body.strip_suffix("```"))
        {
            inner = body.trim();
        }
    }
    if inner.len() >= 2 && inner.starts_with('"') && inner.ends_with('"') {
        let stripped = &inner[1..inner.len() - 1];
        // Only unwrap when the quotes enclose the whole string, not when they
        // belong to the sentence.
        if !stripped.contains('"') {
            inner = stripped;
        }
    }
    inner.trim().to_string()
}

fn describe_failure(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(|message| message.as_str())
                .map(str::to_string)
        });

    match status {
        401 => "OpenRouter rejected the API key.".into(),
        402 => detail.unwrap_or_else(|| "OpenRouter account has no credit left.".into()),
        404 => detail.unwrap_or_else(|| "That OpenRouter model was not found.".into()),
        429 => "OpenRouter rate limit reached. Try again shortly.".into(),
        _ => detail.unwrap_or_else(|| format!("OpenRouter request failed ({status}).")),
    }
}

/// Keychain access through the `security` tool.
///
/// Shelling out avoids adding a native keychain dependency for three calls, and
/// keeps the secret out of any file this app writes.
mod keychain {
    use super::{ACCOUNT, SERVICE};
    use std::process::{Command, Stdio};

    pub fn read() -> Option<String> {
        let output = Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"])
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let key = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if key.is_empty() {
            None
        } else {
            Some(key)
        }
    }

    pub fn write(key: &str) -> bool {
        Command::new("/usr/bin/security")
            .args([
                "add-generic-password",
                "-s",
                SERVICE,
                "-a",
                ACCOUNT,
                "-w",
                key,
                // Replace any existing entry rather than failing on duplicate.
                "-U",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    pub fn delete() {
        let _ = Command::new("/usr/bin/security")
            .args(["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_a_wrapping_fence() {
        assert_eq!(unwrap_text("```\nJust the text.\n```"), "Just the text.");
    }

    #[test]
    fn strips_surrounding_quotes() {
        assert_eq!(unwrap_text("\"Just the text.\""), "Just the text.");
    }

    #[test]
    fn keeps_quotes_that_belong_to_the_sentence() {
        let input = "He said \"hello\" to me.";
        assert_eq!(unwrap_text(input), input);
    }

    #[test]
    fn reads_the_completion() {
        let body = r#"{"choices":[{"message":{"content":"Cleaned up."}}]}"#;
        assert_eq!(extract_message(body).unwrap(), "Cleaned up.");
    }

    #[test]
    fn treats_an_empty_completion_as_a_failure() {
        let body = r#"{"choices":[{"message":{"content":"   "}}]}"#;
        assert!(extract_message(body).is_err());
    }

    #[test]
    fn surfaces_an_error_payload() {
        let body = r#"{"error":{"message":"context length exceeded"}}"#;
        assert_eq!(
            extract_message(body).unwrap_err(),
            "context length exceeded"
        );
    }

    #[test]
    fn reports_a_non_json_body() {
        assert!(extract_message("<html>gateway error</html>")
            .unwrap_err()
            .contains("not JSON"));
    }

    #[test]
    fn explains_http_failures() {
        assert!(describe_failure(401, "{}").contains("rejected the API key"));
        assert!(describe_failure(429, "{}").contains("rate limit"));
        assert_eq!(
            describe_failure(404, r#"{"error":{"message":"No endpoints for foo/bar"}}"#),
            "No endpoints for foo/bar"
        );
    }
}
