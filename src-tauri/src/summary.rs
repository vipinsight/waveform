//! The meeting summary: one request to OpenRouter, in a fixed shape.
//!
//! The shape is the product. The prompt asks for it, this module checks the
//! reply has it, asks once more with the shape restated when it does not,
//! and parses it into sections so each can be copied on its own. Only the
//! transcript text leaves the Mac, and only when the user has already put
//! an OpenRouter key into AI Polish; the audio never does.

use crate::meetings::{Line, LOCAL_SPEAKER};
use serde::Serialize;
use std::collections::BTreeMap;

const ENDPOINT: &str = "https://openrouter.ai/api/v1/chat/completions";
const PROMPT: &str = include_str!("prompts/meeting-summary.txt");
/// A long meeting's summary is still a page; past this the model is padding.
const MAX_REPLY_TOKENS: u32 = 1_500;
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
/// Roughly 30,000 tokens of transcript. Longer meetings are summarised from
/// their most recent part, with a note, rather than refused.
const MAX_TRANSCRIPT_CHARS: usize = 120_000;

/// The summary, parsed. `topics` is in the model's order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// A few words naming the meeting, when the model gave them. Becomes the
    /// meeting's title unless the user has chosen one.
    pub title: Option<String>,
    pub overview: String,
    pub topics: Vec<Section>,
    pub next_steps: Vec<String>,
    pub decisions: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Section {
    pub heading: String,
    pub points: Vec<String>,
}

/// The transcript as the model (and the Copy button) sees it:
/// `[hh:mm:ss] Name: text`, one line per phrase, in time order.
pub fn transcript_text(lines: &[Line], speakers: &BTreeMap<String, String>, local_name: &str) -> String {
    lines
        .iter()
        .map(|line| {
            format!(
                "[{}] {}: {}",
                clock(line.start_ms),
                speaker_name(line.speaker.as_deref(), speakers, local_name),
                line.text
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The name shown for a raw label: the user's rename, the local user's own
/// name, or "Speaker N" for an unnamed remote voice.
pub fn speaker_name(label: Option<&str>, speakers: &BTreeMap<String, String>, local_name: &str) -> String {
    let Some(label) = label else {
        return "Speaker".to_string();
    };
    if let Some(name) = speakers.get(label) {
        return name.clone();
    }
    if label == LOCAL_SPEAKER {
        return local_name.to_string();
    }
    match label.strip_prefix("speaker_").and_then(|n| n.parse::<u32>().ok()) {
        Some(n) => format!("Speaker {}", n + 1),
        None => label.to_string(),
    }
}

/// `hh:mm:ss`, or `mm:ss` under an hour.
pub fn clock(ms: u64) -> String {
    let seconds = ms / 1_000;
    let (h, m, s) = (seconds / 3_600, (seconds % 3_600) / 60, seconds % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

/// Asks the model for the summary and checks its shape, once more if needed.
///
/// The text always comes back when the request succeeded; the parsed
/// summary only when it had the shape. A model that misses twice is shown
/// as it came back rather than asked a third time or thrown away.
pub async fn summarize(key: &str, model: &str, transcript: &str) -> Result<(String, Option<Summary>), String> {
    let transcript = clip_transcript(transcript);
    let first = ask(key, model, PROMPT, &transcript).await?;
    if let Ok(parsed) = parse(&first) {
        return Ok((first, Some(parsed)));
    }
    let restated = format!(
        "{PROMPT}\n\nYour previous reply did not follow the shape. Reply again, in exactly the shape above, starting with the Title line and then the one-sentence overview."
    );
    let second = ask(key, model, &restated, &transcript).await?;
    let parsed = parse(&second).ok();
    Ok((second, parsed))
}

/// Keeps the most recent part of an overlong transcript, saying so.
fn clip_transcript(transcript: &str) -> String {
    if transcript.chars().count() <= MAX_TRANSCRIPT_CHARS {
        return transcript.to_string();
    }
    let start = transcript.chars().count() - MAX_TRANSCRIPT_CHARS;
    let tail: String = transcript.chars().skip(start).collect();
    let from_line = tail.find('\n').map(|at| at + 1).unwrap_or(0);
    format!(
        "[The first part of this meeting is omitted; this is the final portion.]\n{}",
        &tail[from_line..]
    )
}

async fn ask(key: &str, model: &str, system: &str, transcript: &str) -> Result<String, String> {
    let response = reqwest::Client::new()
        .post(ENDPOINT)
        .bearer_auth(key)
        .header("HTTP-Referer", "https://github.com/vipinsight/waveform")
        .header("X-Title", "Waveform")
        .json(&serde_json::json!({
            "model": model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": transcript },
            ],
            "temperature": 0.2,
            "max_tokens": MAX_REPLY_TOKENS,
        }))
        .timeout(TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("OpenRouter request failed: {error}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(crate::rewrite::describe_failure(status.as_u16(), &body));
    }
    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| "OpenRouter sent back something that was not JSON.".to_string())?;
    value
        .pointer("/choices/0/message/content")
        .and_then(|content| content.as_str())
        .map(|content| content.trim().to_string())
        .filter(|content| !content.is_empty())
        .ok_or_else(|| "OpenRouter sent back an empty summary.".to_string())
}

/// Reads the fixed shape. Forgiving about blank lines and markdown bullets,
/// strict about the parts: an overview, at least one topic, and both closing
/// sections in order. The title line is optional: replies written before it
/// was asked for, and models that skip it, still parse.
pub fn parse(text: &str) -> Result<Summary, String> {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let mut index = 0;

    let title = lines.first().and_then(|line| title_line(line));
    if title.is_some() {
        index += 1;
    }

    let overview = lines
        .get(index)
        .filter(|line| !is_point(line))
        .map(|line| strip_markdown(line))
        .filter(|line| !line.is_empty())
        .ok_or("no overview sentence")?;
    index += 1;

    let mut topics: Vec<Section> = Vec::new();
    let mut next_steps = Vec::new();
    let mut decisions = Vec::new();
    let mut current: Option<Section> = None;
    let mut closing: Option<&str> = None;

    while index < lines.len() {
        let line = lines[index];
        index += 1;
        if is_point(line) {
            let point = strip_markdown(point_text(line));
            if point.is_empty() {
                continue;
            }
            match closing {
                Some("next") => next_steps.push(point),
                Some("decisions") => decisions.push(point),
                _ => match current.as_mut() {
                    Some(section) => section.points.push(point),
                    None => return Err("a point before any heading".into()),
                },
            }
            continue;
        }
        let heading = strip_markdown(line);
        let lowered = heading.to_lowercase();
        let lowered = lowered.trim_end_matches(':');
        if lowered == "next steps" {
            if let Some(section) = current.take() {
                topics.push(section);
            }
            closing = Some("next");
        } else if lowered == "decisions made" || lowered == "decisions" {
            if closing != Some("next") {
                return Err("Decisions Made before Next Steps".into());
            }
            closing = Some("decisions");
        } else if closing.is_some() {
            return Err(format!("unexpected heading after the closing sections: {heading:?}"));
        } else {
            if let Some(section) = current.take() {
                topics.push(section);
            }
            current = Some(Section {
                heading,
                points: Vec::new(),
            });
        }
    }
    if let Some(section) = current.take() {
        topics.push(section);
    }

    if topics.is_empty() || topics.iter().any(|t| t.points.is_empty()) {
        return Err("a topic without points".into());
    }
    if closing != Some("decisions") {
        return Err("missing Next Steps or Decisions Made".into());
    }
    if decisions.is_empty() {
        decisions.push("Nothing was decided.".to_string());
    }
    Ok(Summary {
        title,
        overview,
        topics,
        next_steps,
        decisions,
    })
}

/// `Title: …` as a short title, or nothing when the line is not one. The
/// title is kept to one line, without a closing period, and no longer than
/// a window title bar would show.
fn title_line(line: &str) -> Option<String> {
    let cleaned = strip_markdown(line);
    let rest = cleaned
        .get(..6)
        .filter(|head| head.eq_ignore_ascii_case("title:"))
        .map(|_| &cleaned[6..])?;
    let title: String = rest
        .replace("**", "")
        .trim()
        .trim_matches(|c: char| c == '"' || c == '“' || c == '”')
        .trim_end_matches('.')
        .trim()
        .chars()
        .take(80)
        .collect();
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

fn is_point(line: &str) -> bool {
    line.starts_with("- ") || line.starts_with("* ") || line.starts_with("• ") || line == "-"
}

fn point_text(line: &str) -> &str {
    line.trim_start_matches(['-', '*', '•']).trim()
}

/// Models add emphasis however they are told not to.
fn strip_markdown(text: &str) -> String {
    text.trim_matches(|c: char| c == '#' || c == ' ')
        .replace("**", "")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meetings::Track;

    const SAMPLE: &str = "Team reviewed the release plan and who owns what.\n\nRelease Timing\n- Ship Thursday if QA signs off\n- Friday is the fallback\n\nOwnership\n- Priya takes the changelog\n\nNext Steps\n- (Priya) Draft the changelog\n- (Vipin) Book the QA slot\n\nDecisions Made\n- Thursday is the target\n";

    #[test]
    fn parses_the_shape_into_sections() {
        let summary = parse(SAMPLE).unwrap();
        assert_eq!(summary.title, None);
        assert_eq!(summary.overview, "Team reviewed the release plan and who owns what.");
        assert_eq!(summary.topics.len(), 2);
        assert_eq!(summary.topics[0].heading, "Release Timing");
        assert_eq!(summary.topics[0].points, vec!["Ship Thursday if QA signs off", "Friday is the fallback"]);
        assert_eq!(summary.next_steps, vec!["(Priya) Draft the changelog", "(Vipin) Book the QA slot"]);
        assert_eq!(summary.decisions, vec!["Thursday is the target"]);
    }

    #[test]
    fn a_title_line_becomes_the_title_and_the_overview_follows() {
        let text = format!("Title: Release Plan Review.\n\n{SAMPLE}");
        let summary = parse(&text).unwrap();
        assert_eq!(summary.title.as_deref(), Some("Release Plan Review"));
        assert_eq!(summary.overview, "Team reviewed the release plan and who owns what.");
        assert_eq!(summary.topics.len(), 2);
        assert_eq!(summary.decisions, vec!["Thursday is the target"]);
    }

    #[test]
    fn the_title_line_is_read_however_the_model_dressed_it() {
        let text = format!("**Title:** “Q3 Hiring Plan”\n{SAMPLE}");
        assert_eq!(parse(&text).unwrap().title.as_deref(), Some("Q3 Hiring Plan"));
        let text = format!("TITLE: Launch timing\n{SAMPLE}");
        assert_eq!(parse(&text).unwrap().title.as_deref(), Some("Launch timing"));
        // An empty title line is no title, and the overview must still follow.
        let text = format!("Title:\n{SAMPLE}");
        assert!(parse(&text).is_err());
    }

    #[test]
    fn a_title_alone_is_not_a_summary() {
        assert!(parse("Title: Just a name").is_err());
    }

    #[test]
    fn tolerates_markdown_the_prompt_forbade() {
        let text = "**Overview sentence.**\n\n## Topic One\n* point a\n• point b\n\n**Next Steps:**\n- (A) do it\n\n### Decisions Made\n- yes";
        let summary = parse(text).unwrap();
        assert_eq!(summary.overview, "Overview sentence.");
        assert_eq!(summary.topics[0].heading, "Topic One");
        assert_eq!(summary.topics[0].points, vec!["point a", "point b"]);
        assert_eq!(summary.decisions, vec!["yes"]);
    }

    #[test]
    fn an_empty_decisions_section_says_so() {
        let text = "Overview.\n\nTopic\n- point\n\nNext Steps\n- (A) thing\n\nDecisions Made\n";
        assert_eq!(parse(text).unwrap().decisions, vec!["Nothing was decided."]);
    }

    #[test]
    fn rejects_replies_that_miss_the_shape() {
        assert!(parse("- a point first\nTopic\n- x\nNext Steps\n- y\nDecisions Made\n- z").is_err());
        assert!(parse("Overview.\n\nTopic\n- x\n\nDecisions Made\n- z").is_err());
        assert!(parse("Overview.\n\nNext Steps\n- y\n\nDecisions Made\n- z").is_err());
        assert!(parse("Overview.\n\nTopic\n\nNext Steps\n- y\n\nDecisions Made\n- z").is_err());
        assert!(parse("Overview.\n\nTopic\n- x\n\nNext Steps\n- y\n\nDecisions Made\n- z\n\nExtra\n- q").is_err());
    }

    #[test]
    fn the_transcript_is_timestamped_and_named() {
        let lines = vec![
            Line { idx: 0, start_ms: 0, end_ms: 2_000, track: Track::Mic, speaker: Some("me".into()), text: "Hello all.".into() },
            Line { idx: 1, start_ms: 65_000, end_ms: 70_000, track: Track::System, speaker: Some("speaker_00".into()), text: "Hi.".into() },
            Line { idx: 2, start_ms: 3_700_000, end_ms: 3_701_000, track: Track::System, speaker: Some("speaker_01".into()), text: "Bye.".into() },
            Line { idx: 3, start_ms: 3_702_000, end_ms: 3_703_000, track: Track::System, speaker: None, text: "?".into() },
        ];
        let mut speakers = BTreeMap::new();
        speakers.insert("speaker_00".to_string(), "Priya".to_string());
        let text = transcript_text(&lines, &speakers, "Vipin");
        assert_eq!(
            text,
            "[00:00] Vipin: Hello all.\n[01:05] Priya: Hi.\n[1:01:40] Speaker 2: Bye.\n[1:01:42] Speaker: ?"
        );
    }

    #[test]
    fn an_overlong_transcript_keeps_its_end_and_says_so() {
        let line = "[00:00] A: ".to_string() + &"x".repeat(100) + "\n";
        let transcript = line.repeat(2_000);
        let clipped = clip_transcript(&transcript);
        assert!(clipped.starts_with("[The first part of this meeting is omitted"));
        assert!(clipped.chars().count() <= MAX_TRANSCRIPT_CHARS + 100);
        assert!(clipped.ends_with(&line));
        // Cut on a line boundary: the first kept line is whole.
        assert!(clipped.lines().nth(1).unwrap().starts_with("[00:00] A: "));
    }
}
