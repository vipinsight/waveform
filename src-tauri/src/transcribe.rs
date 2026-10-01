//! One phrase through the engine, with the dictionary on both sides of it.
//!
//! Dictation and meetings share this step. The prompt carries what the
//! session has said so far and the dictionary's most likely terms; the reply
//! has its recorded mis-hearings put right and every term that came up is
//! counted, so the ranking learns from use.

use crate::dictionary::{self, DictionaryStore};
use crate::logs::Logs;
use crate::model_server::ModelServer;
use crate::settings::SettingsStore;
use crate::whisper_cpp;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex;

/// What the step needs; held by the app state and the meeting recorder.
#[derive(Clone)]
pub struct Engine {
    pub app: AppHandle,
    pub logs: Arc<Logs>,
    pub settings: Arc<Mutex<SettingsStore>>,
    pub dictionary: Arc<Mutex<DictionaryStore>>,
    pub models: Arc<ModelServer>,
}

impl Engine {
    /// Transcribes one WAV. `prior` is what the same session has produced
    /// so far, oldest first; `source` names the caller in the log.
    pub async fn transcribe(&self, wav_bytes: Vec<u8>, prior: &str, source: &str) -> Result<String, String> {
        let terms = self.dictionary.lock().await.terms().unwrap_or_default();
        let (model_id, language, prompt) = {
            let settings = self.settings.lock().await.value();
            // The terms most likely to come up, as one sentence, after the
            // carried context: whisper.cpp truncates a long prompt from the
            // front, so the context is what gives way, never the names.
            let ranked = dictionary::rank(&terms, prior, now_ms(), dictionary::PROMPT_TERMS);
            let vocabulary = dictionary::prompt_sentence(&ranked);
            let prompt = whisper_cpp::build_prompt(&vocabulary, prior);
            (settings.model_id, settings.speech_language, prompt)
        };

        // 44 bytes of header, then 16-bit mono. Reported in seconds because
        // that is the number worth comparing against what was actually said.
        let seconds = wav_bytes.len().saturating_sub(44) as f64 / 2.0 / 48_000.0;
        let started = std::time::Instant::now();
        let outcome = self.models.transcribe(wav_bytes, &language, &prompt).await;
        let took = started.elapsed().as_millis();

        // What the engine still got wrong, put right from the dictionary,
        // and a count against every term that came up.
        let outcome = outcome.map(|text| {
            let (fixed, corrections) = dictionary::correct(&text, &terms);
            for correction in &corrections {
                self.logs.info(
                    &self.app,
                    "dictionary",
                    format!("{:?} → {:?}", correction.from, correction.to),
                );
            }
            let mut used: Vec<i64> = corrections.iter().map(|c| c.term_id).collect();
            let lowered = fixed.to_lowercase();
            used.extend(
                terms
                    .iter()
                    .filter(|term| dictionary::mentions(&lowered, &term.text))
                    .map(|term| term.id),
            );
            used.sort_unstable();
            used.dedup();
            if !used.is_empty() {
                let dictionary = self.dictionary.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = dictionary.lock().await.record_uses(&used);
                });
            }
            fixed
        });

        match &outcome {
            Ok(text) if text.is_empty() => self.logs.info(
                &self.app,
                source,
                format!("{model_id}: {seconds:.1}s in {took}ms, no words found"),
            ),
            Ok(text) => self.logs.info(
                &self.app,
                source,
                format!("{model_id}: {seconds:.1}s in {took}ms — {text:?}"),
            ),
            Err(error) => self.logs.error(
                &self.app,
                source,
                format!("{model_id}: {seconds:.1}s failed after {took}ms — {error}"),
            ),
        }
        outcome
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}
