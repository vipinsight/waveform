//! The user's dictionary: names and terms the speech engine should get right.
//!
//! A term has the spelling it should be typed with and, when known, the
//! words the engine tends to hear instead. The dictionary works on a phrase
//! twice: before decoding, the terms most likely to come up are put in the
//! engine's prompt (see `rank` and `prompt_sentence`); after decoding, a
//! mis-hearing that still got through is replaced (see `correct`). The
//! second pass is the only one every engine gets -- Parakeet has no prompt.
//!
//! Terms come from the user typing them, or from a correction they made to a
//! transcript (see `suggest`): the dictionary offers to learn, and never
//! learns silently, because an edit is as often a rewording as a fix.

use crate::store::Database;
use rphonetic::{DoubleMetaphone, Encoder};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// How many terms a phrase's prompt carries at most. Whisper reads 224 prompt
/// tokens and the carried context wants most of them; a dozen names is what
/// one sentence can hold without the decoder starting to hear them everywhere.
pub const PROMPT_TERMS: usize = 12;

/// How long a learned term stays boosted in ranking, so the user sees the
/// correction take over the next few days of dictating.
const LEARNED_BOOST_MS: u64 = 7 * 24 * 60 * 60 * 1_000;

/// Half-life of a use when ranking: a term used a month ago counts half as
/// much as one used today.
const USE_HALF_LIFE_MS: f64 = 30.0 * 24.0 * 60.0 * 60.0 * 1_000.0;

/// A pair offered this many times and declined is not offered again.
const DECLINE_LIMIT: i64 = 2;

/// Longest run of words either side of a correction can be and still count
/// as one term rather than a rewording.
const MAX_TERM_WORDS: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Manual,
    Learned,
}

impl Source {
    fn as_str(self) -> &'static str {
        match self {
            Source::Manual => "manual",
            Source::Learned => "learned",
        }
    }

    fn parse(value: &str) -> Source {
        if value == "learned" {
            Source::Learned
        } else {
            Source::Manual
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Term {
    pub id: i64,
    /// How it should be typed.
    pub text: String,
    /// What the engine tends to hear instead.
    pub heard_as: Vec<String>,
    pub source: Source,
    /// Phrases it was prompted into or corrected in.
    pub uses: u64,
    /// Milliseconds since the epoch, or none if never used.
    pub last_used_at: Option<u64>,
    pub created_at: u64,
}

/// A mis-hearing the dictionary replaced in a phrase, for the log.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Correction {
    pub term_id: i64,
    pub from: String,
    pub to: String,
}

/// A term a transcript edit suggests learning.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    /// What the engine wrote.
    pub heard_as: String,
    /// What the user changed it to.
    pub text: String,
}

pub struct DictionaryStore {
    db: Database,
}

impl DictionaryStore {
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    /// Every term, alphabetically, so the list reads the same each time.
    pub fn terms(&self) -> Result<Vec<Term>, String> {
        self.db.with(read_all).map_err(describe)
    }

    /// Adds a term, or folds a new mis-hearing into one that already exists.
    ///
    /// Spelling is matched without case, so "tauri" and "Tauri" are one term;
    /// the spelling kept is the one that was there first unless the new one
    /// is a learned correction, which is the user telling us how it is typed.
    pub fn add(
        &mut self,
        text: &str,
        heard_as: &[String],
        source: Source,
    ) -> Result<Vec<Term>, String> {
        let text = clean(text);
        if text.is_empty() {
            return Err("A term needs some letters.".into());
        }
        let heard_as: Vec<String> = heard_as
            .iter()
            .map(|variant| clean(variant))
            .filter(|variant| !variant.is_empty() && !same_word(variant, &text))
            .collect();
        let now = now_ms();

        self.db
            .with(|connection| {
                let transaction = connection.transaction()?;
                let existing: Option<(i64, String)> = transaction
                    .query_row(
                        "SELECT id, heard_as FROM dictionary WHERE text = ?1 COLLATE NOCASE",
                        [&text],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                match existing {
                    Some((id, stored)) => {
                        let mut variants: Vec<String> = serde_json::from_str(&stored).unwrap_or_default();
                        for variant in heard_as {
                            if !variants.iter().any(|known| same_word(known, &variant)) {
                                variants.push(variant);
                            }
                        }
                        let variants = serde_json::to_string(&variants).unwrap_or_else(|_| "[]".into());
                        if source == Source::Learned {
                            transaction.execute(
                                "UPDATE dictionary SET heard_as = ?2, text = ?3 WHERE id = ?1",
                                params![id, variants, text],
                            )?;
                        } else {
                            transaction.execute(
                                "UPDATE dictionary SET heard_as = ?2 WHERE id = ?1",
                                params![id, variants],
                            )?;
                        }
                    }
                    None => {
                        let variants = serde_json::to_string(&heard_as).unwrap_or_else(|_| "[]".into());
                        transaction.execute(
                            "INSERT INTO dictionary (text, heard_as, source, uses, last_used_at, created_at)
                             VALUES (?1, ?2, ?3, 0, NULL, ?4)",
                            params![text, variants, source.as_str(), now as i64],
                        )?;
                    }
                }
                transaction.commit()
            })
            .map_err(describe)?;
        self.terms()
    }

    /// Changes a term's spelling and mis-hearings in place.
    pub fn update(&mut self, id: i64, text: &str, heard_as: &[String]) -> Result<Vec<Term>, String> {
        let text = clean(text);
        if text.is_empty() {
            return Err("A term needs some letters.".into());
        }
        let heard_as: Vec<String> = heard_as
            .iter()
            .map(|variant| clean(variant))
            .filter(|variant| !variant.is_empty() && !same_word(variant, &text))
            .collect();
        let variants = serde_json::to_string(&heard_as).unwrap_or_else(|_| "[]".into());
        let changed = self
            .db
            .with(|connection| {
                connection.execute(
                    "UPDATE dictionary SET text = ?2, heard_as = ?3 WHERE id = ?1",
                    params![id, text, variants],
                )
            })
            .map_err(|error| match error {
                rusqlite::Error::SqliteFailure(code, _)
                    if code.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    "Another term already has that spelling.".to_string()
                }
                other => describe(other),
            })?;
        if changed == 0 {
            return Err("That term is gone.".into());
        }
        self.terms()
    }

    pub fn remove(&mut self, id: i64) -> Result<Vec<Term>, String> {
        self.db
            .with(|connection| connection.execute("DELETE FROM dictionary WHERE id = ?1", [id]))
            .map_err(describe)?;
        self.terms()
    }

    /// Counts a phrase against the terms that appeared in it.
    pub fn record_uses(&mut self, ids: &[i64]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        let now = now_ms() as i64;
        self.db
            .with(|connection| {
                let transaction = connection.transaction()?;
                for id in ids {
                    transaction.execute(
                        "UPDATE dictionary SET uses = uses + 1, last_used_at = ?2 WHERE id = ?1",
                        params![id, now],
                    )?;
                }
                transaction.commit()
            })
            .map_err(describe)
    }

    /// Remembers that the user did not want this pair learned.
    pub fn decline(&mut self, suggestion: &Suggestion) -> Result<(), String> {
        self.db
            .with(|connection| {
                connection.execute(
                    "INSERT INTO dictionary_declined (heard_as, text, count) VALUES (?1, ?2, 1)
                     ON CONFLICT(heard_as, text) DO UPDATE SET count = count + 1",
                    params![suggestion.heard_as.to_lowercase(), suggestion.text.to_lowercase()],
                )?;
                Ok(())
            })
            .map_err(describe)
    }

    /// The suggestions an edit yields, minus those already known or declined.
    pub fn suggestions_for(&self, before: &str, after: &str) -> Result<Vec<Suggestion>, String> {
        let terms = self.terms()?;
        let candidates = suggest(before, after);
        let mut kept = Vec::new();
        for candidate in candidates {
            if terms.iter().any(|term| same_word(&term.text, &candidate.text)) {
                continue;
            }
            let declined: i64 = self
                .db
                .with(|connection| {
                    connection
                        .query_row(
                            "SELECT count FROM dictionary_declined WHERE heard_as = ?1 AND text = ?2",
                            params![candidate.heard_as.to_lowercase(), candidate.text.to_lowercase()],
                            |row| row.get(0),
                        )
                        .optional()
                        .map(|count| count.unwrap_or(0))
                })
                .map_err(describe)?;
            if declined >= DECLINE_LIMIT {
                continue;
            }
            kept.push(candidate);
        }
        Ok(kept)
    }
}

fn read_all(connection: &mut Connection) -> rusqlite::Result<Vec<Term>> {
    let mut select = connection.prepare_cached(
        "SELECT id, text, heard_as, source, uses, last_used_at, created_at
           FROM dictionary
          ORDER BY text COLLATE NOCASE",
    )?;
    let rows = select.query_map([], |row| {
        let heard_as: String = row.get(2)?;
        let source: String = row.get(3)?;
        Ok(Term {
            id: row.get(0)?,
            text: row.get(1)?,
            heard_as: serde_json::from_str(&heard_as).unwrap_or_default(),
            source: Source::parse(&source),
            uses: row.get::<_, i64>(4)?.max(0) as u64,
            last_used_at: row.get::<_, Option<i64>>(5)?.map(|ms| ms.max(0) as u64),
            created_at: row.get::<_, i64>(6)?.max(0) as u64,
        })
    })?;
    rows.collect()
}

fn describe(error: rusqlite::Error) -> String {
    format!("The dictionary could not be saved: {error}")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

/// Trims and collapses whitespace; what a term looks like in the table.
fn clean(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Whether two spellings are the same word, ignoring case and stray punctuation.
fn same_word(first: &str, second: &str) -> bool {
    bare(first) == bare(second)
}

/// Lower-case, with punctuation at either end removed. What a word is for
/// matching purposes; "Tauri," and "tauri" are the same.
fn bare(word: &str) -> String {
    word.trim_matches(|c: char| !c.is_alphanumeric())
        .to_lowercase()
}

// ---------------------------------------------------------------------------
// Ranking: which terms a phrase's prompt should carry.
// ---------------------------------------------------------------------------

/// The terms most worth priming the engine with for the next phrase.
///
/// `context` is what the session has transcribed so far. A term named in it
/// is likely to recur; a term whose mis-hearing is in it is being missed
/// right now and needs priming most. Beyond that, recent use beats old use,
/// and a term learned this week gets a lift so the correction is seen to
/// take. Ties go alphabetically, so the prompt is stable between phrases.
pub fn rank<'a>(terms: &'a [Term], context: &str, now: u64, limit: usize) -> Vec<&'a Term> {
    let context = context.to_lowercase();
    let mut scored: Vec<(f64, &Term)> = terms
        .iter()
        .map(|term| (score(term, &context, now), term))
        .collect();
    scored.sort_by(|(a_score, a), (b_score, b)| {
        b_score
            .partial_cmp(a_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.text.to_lowercase().cmp(&b.text.to_lowercase()))
    });
    scored.into_iter().take(limit).map(|(_, term)| term).collect()
}

fn score(term: &Term, context: &str, now: u64) -> f64 {
    let mut score = 0.0;
    // Uses, decayed: a use today is worth 1, a use a month ago 0.5.
    if let Some(last) = term.last_used_at {
        let age = now.saturating_sub(last) as f64;
        score += term.uses as f64 * 0.5f64.powf(age / USE_HALF_LIFE_MS);
    }
    if contains_word(context, &term.text) {
        score += 3.0;
    }
    if term.heard_as.iter().any(|variant| contains_word(context, variant)) {
        score += 4.0;
    }
    if term.source == Source::Learned && now.saturating_sub(term.created_at) < LEARNED_BOOST_MS {
        score += 2.0;
    }
    score
}

/// Whether `needle` appears in `haystack` as whole words. Both lower-cased by
/// the caller, or here for the needle.
fn contains_word(haystack: &str, needle: &str) -> bool {
    find_word(haystack, &needle.to_lowercase(), 0).is_some()
}

/// Whether a phrase mentions a term, as whole words. `lowered_text` must
/// already be lower-cased; the term is folded here.
pub fn mentions(lowered_text: &str, term: &str) -> bool {
    contains_word(lowered_text, term)
}

/// Byte range of the next whole-word occurrence of `needle` in `haystack`
/// at or after `from`. Both must already be in the same case.
///
/// A word ends where the letters do, except that punctuation with letters on
/// both sides belongs to the word: "whisper" is not a word of "whisper.cpp",
/// nor "don" of "don't".
fn find_word(haystack: &str, needle: &str, from: usize) -> Option<(usize, usize)> {
    if needle.is_empty() {
        return None;
    }
    let mut start = from;
    while let Some(offset) = haystack.get(start..)?.find(needle) {
        let begin = start + offset;
        let end = begin + needle.len();
        if is_word_edge(haystack, begin, true) && is_word_edge(haystack, end, false) {
            return Some((begin, end));
        }
        start = begin + needle.chars().next().map_or(1, char::len_utf8);
    }
    None
}

/// Whether a word may begin (`leading`) or end at byte `at` of `text`.
fn is_word_edge(text: &str, at: usize, leading: bool) -> bool {
    let (outside, further) = if leading {
        let mut back = text[..at].chars().rev();
        (back.next(), back.next())
    } else {
        let mut ahead = text[at..].chars();
        (ahead.next(), ahead.next())
    };
    match outside {
        None => true,
        Some(c) if c.is_alphanumeric() => false,
        Some(c) if joins_words(c) => !further.is_some_and(|f| f.is_alphanumeric()),
        Some(_) => true,
    }
}

/// Punctuation that sits inside a word when it has letters on both sides.
fn joins_words(c: char) -> bool {
    matches!(c, '.' | '\'' | '-' | '_' | '’')
}

/// The sentence the engine is primed with.
///
/// Whisper was trained on transcripts, not lists; a sentence that uses the
/// terms primes it better than the bare words with commas between them.
pub fn prompt_sentence(terms: &[&Term]) -> String {
    let names: Vec<&str> = terms.iter().map(|term| term.text.as_str()).collect();
    match names.len() {
        0 => String::new(),
        1 => format!("In this recording we talk about {}.", names[0]),
        _ => {
            let (last, rest) = names.split_last().expect("at least two names");
            format!("In this recording we talk about {} and {}.", rest.join(", "), last)
        }
    }
}

// ---------------------------------------------------------------------------
// Correction: fixing what still came back wrong.
// ---------------------------------------------------------------------------

/// Replaces mis-hearings in `text` with the terms they stand for.
///
/// Two passes. First, every recorded mis-hearing is matched as whole words,
/// case aside, and replaced; a phrase the user has already corrected once is
/// never typed wrong again. Second, single words that sound like a term --
/// same Double Metaphone code and an edit distance within a quarter of the
/// word -- are replaced too, but only for terms that have earned it: ones
/// with a recorded mis-hearing or enough uses that they are plainly part of
/// how this person talks. A term typed once cannot start rewriting ordinary
/// words.
pub fn correct(text: &str, terms: &[Term]) -> (String, Vec<Correction>) {
    let mut result = text.to_string();
    let mut corrections = Vec::new();

    // Longest mis-hearings first so "whisper cpp" wins over "whisper".
    let mut exact: Vec<(&Term, &String)> = terms
        .iter()
        .flat_map(|term| term.heard_as.iter().map(move |variant| (term, variant)))
        .collect();
    exact.sort_by_key(|(_, variant)| std::cmp::Reverse(variant.len()));
    for (term, variant) in exact {
        let needle = variant.to_lowercase();
        let mut from = 0;
        loop {
            let lowered = result.to_lowercase();
            if lowered.len() != result.len() {
                // Case folding changed byte lengths (rare scripts); fall back to
                // leaving this phrase alone rather than slicing it wrong.
                break;
            }
            let Some((begin, end)) = find_word(&lowered, &needle, from) else {
                break;
            };
            let from_text = result[begin..end].to_string();
            // Already right, or the spelling of another term in its own
            // right ("Marc" is not a mis-hearing of "Mark" if both are names
            // here). A case-only difference from this term is still fixed.
            let is_other_term = terms
                .iter()
                .any(|other| other.id != term.id && same_word(&other.text, &from_text));
            if from_text == term.text || is_other_term {
                from = end;
                continue;
            }
            result.replace_range(begin..end, &term.text);
            corrections.push(Correction {
                term_id: term.id,
                from: from_text,
                to: term.text.clone(),
            });
            from = begin + term.text.len();
        }
    }

    let phonetic: Vec<&Term> = terms
        .iter()
        .filter(|term| !term.heard_as.is_empty() || term.uses >= 3)
        .filter(|term| !term.text.contains(' '))
        .collect();
    if phonetic.is_empty() {
        return (result, corrections);
    }
    let metaphone = DoubleMetaphone::default();
    let known: Vec<String> = terms.iter().map(|term| bare(&term.text)).collect();

    let mut rebuilt = String::with_capacity(result.len());
    let mut last = 0;
    for (begin, end) in word_spans(&result) {
        rebuilt.push_str(&result[last..begin]);
        let word = &result[begin..end];
        let plain = bare(word);
        let replacement = if plain.is_empty() || known.contains(&plain) {
            None
        } else {
            phonetic.iter().find(|term| sounds_like(&metaphone, &plain, &bare(&term.text)))
        };
        match replacement {
            Some(term) => {
                rebuilt.push_str(&term.text);
                corrections.push(Correction {
                    term_id: term.id,
                    from: word.to_string(),
                    to: term.text.clone(),
                });
            }
            None => rebuilt.push_str(word),
        }
        last = end;
    }
    rebuilt.push_str(&result[last..]);
    (rebuilt, corrections)
}

/// Byte ranges of the words in `text`, without their surrounding punctuation,
/// so the punctuation is kept where it was. Punctuation with letters on both
/// sides stays inside the word, as in `find_word`.
fn word_spans(text: &str) -> Vec<(usize, usize)> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut spans = Vec::new();
    let mut start: Option<usize> = None;
    for (position, &(index, c)) in chars.iter().enumerate() {
        let in_word = c.is_alphanumeric()
            || (joins_words(c)
                && position > 0
                && chars[position - 1].1.is_alphanumeric()
                && chars.get(position + 1).is_some_and(|(_, next)| next.is_alphanumeric()));
        match (in_word, start) {
            (true, None) => start = Some(index),
            (false, Some(begin)) => {
                spans.push((begin, index));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(begin) = start {
        spans.push((begin, text.len()));
    }
    spans
}

fn sounds_like(metaphone: &DoubleMetaphone, word: &str, term: &str) -> bool {
    if word == term || word.chars().count() < 3 {
        return false;
    }
    let budget = (term.chars().count() / 4).max(1);
    if levenshtein(word, term) > budget {
        return false;
    }
    let word_code = metaphone.encode(word);
    if word_code.is_empty() {
        return false;
    }
    word_code == metaphone.encode(term) || metaphone.is_double_metaphone_equal(word, term, true)
}

fn levenshtein(first: &str, second: &str) -> usize {
    let a: Vec<char> = first.chars().collect();
    let b: Vec<char> = second.chars().collect();
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    let mut current = vec![0; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        current[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            current[j + 1] = (previous[j + 1] + 1)
                .min(current[j] + 1)
                .min(previous[j] + cost);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[b.len()]
}

// ---------------------------------------------------------------------------
// Suggestions: what a transcript edit says about the dictionary.
// ---------------------------------------------------------------------------

/// Words too common to be anybody's name or jargon.
const STOP_WORDS: &[&str] = &[
    "a", "an", "the", "and", "or", "but", "so", "of", "to", "in", "on", "at", "for", "with",
    "by", "from", "as", "is", "are", "was", "were", "be", "been", "it", "its", "this", "that",
    "these", "those", "i", "you", "he", "she", "we", "they", "me", "him", "her", "us", "them",
    "my", "your", "his", "our", "their", "not", "no", "yes", "do", "does", "did", "have", "has",
    "had", "will", "would", "can", "could", "should", "if", "then", "than", "there", "here",
    "what", "which", "who", "when", "where", "how", "um", "uh", "like", "just", "okay", "ok",
];

/// The term-shaped substitutions between a transcript and its edited form.
///
/// Words are aligned with a longest-common-subsequence diff; each run where
/// one to three words were replaced by one to three words is a candidate,
/// unless the change is only case or punctuation, or either side is nothing
/// but stop words and numbers. Insertions and deletions on their own are
/// rewording, not a term.
pub fn suggest(before: &str, after: &str) -> Vec<Suggestion> {
    let old: Vec<&str> = before.split_whitespace().collect();
    let new: Vec<&str> = after.split_whitespace().collect();
    let old_keys: Vec<String> = old.iter().map(|word| bare(word)).collect();
    let new_keys: Vec<String> = new.iter().map(|word| bare(word)).collect();

    // LCS table over the normalised words.
    let mut table = vec![vec![0usize; new.len() + 1]; old.len() + 1];
    for i in (0..old.len()).rev() {
        for j in (0..new.len()).rev() {
            table[i][j] = if old_keys[i] == new_keys[j] {
                table[i + 1][j + 1] + 1
            } else {
                table[i + 1][j].max(table[i][j + 1])
            };
        }
    }

    let mut suggestions = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < old.len() || j < new.len() {
        if i < old.len() && j < new.len() && old_keys[i] == new_keys[j] {
            i += 1;
            j += 1;
            continue;
        }
        // A run of differences: take everything up to the next common word.
        let (start_i, start_j) = (i, j);
        while i < old.len() || j < new.len() {
            if i < old.len() && j < new.len() && old_keys[i] == new_keys[j] {
                break;
            }
            if j >= new.len() || (i < old.len() && table[i + 1][j] >= table[i][j + 1]) {
                i += 1;
            } else {
                j += 1;
            }
        }
        let removed = &old[start_i..i];
        let added = &new[start_j..j];
        if let Some(suggestion) = as_term(removed, added) {
            suggestions.push(suggestion);
        }
    }
    suggestions
}

fn as_term(removed: &[&str], added: &[&str]) -> Option<Suggestion> {
    if removed.is_empty() || added.is_empty() {
        return None;
    }
    if removed.len() > MAX_TERM_WORDS || added.len() > MAX_TERM_WORDS {
        return None;
    }
    let heard_as = strip_edges(&removed.join(" "));
    let text = strip_edges(&added.join(" "));
    if heard_as.is_empty() || text.is_empty() || same_word(&heard_as, &text) {
        return None;
    }
    if all_filler(added) || all_filler(removed) {
        return None;
    }
    Some(Suggestion { heard_as, text })
}

/// Whether every word is a stop word or a number: nothing to learn there.
fn all_filler(words: &[&str]) -> bool {
    words.iter().all(|word| {
        let key = bare(word);
        key.is_empty() || STOP_WORDS.contains(&key.as_str()) || key.chars().all(|c| c.is_ascii_digit())
    })
}

/// Punctuation off the ends of a phrase, keeping what is inside it.
fn strip_edges(phrase: &str) -> String {
    phrase
        .trim_matches(|c: char| !c.is_alphanumeric())
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::temp_dir;

    fn term(id: i64, text: &str, heard_as: &[&str]) -> Term {
        Term {
            id,
            text: text.to_string(),
            heard_as: heard_as.iter().map(|s| s.to_string()).collect(),
            source: Source::Manual,
            uses: 0,
            last_used_at: None,
            created_at: 0,
        }
    }

    fn store() -> DictionaryStore {
        DictionaryStore::new(Database::open(&temp_dir("dictionary")).database)
    }

    // -- store --------------------------------------------------------------

    #[test]
    fn adds_lists_and_removes_terms() {
        let mut dictionary = store();
        dictionary.add("Tauri", &[], Source::Manual).unwrap();
        let terms = dictionary.add("Parakeet", &["parrot keet".into()], Source::Manual).unwrap();
        assert_eq!(terms.len(), 2);
        assert_eq!(terms[0].text, "Parakeet");
        assert_eq!(terms[0].heard_as, vec!["parrot keet"]);
        assert_eq!(terms[1].text, "Tauri");

        let left = dictionary.remove(terms[1].id).unwrap();
        assert_eq!(left.len(), 1);
    }

    #[test]
    fn adding_the_same_spelling_merges_mis_hearings() {
        let mut dictionary = store();
        dictionary.add("Tauri", &["Towery".into()], Source::Manual).unwrap();
        let terms = dictionary.add("tauri", &["Tory".into(), "towery".into()], Source::Manual).unwrap();
        assert_eq!(terms.len(), 1);
        assert_eq!(terms[0].text, "Tauri");
        assert_eq!(terms[0].heard_as, vec!["Towery", "Tory"]);
    }

    #[test]
    fn a_learned_correction_fixes_the_spelling() {
        let mut dictionary = store();
        dictionary.add("vipin", &[], Source::Manual).unwrap();
        let terms = dictionary.add("Vipin", &["Vippin".into()], Source::Learned).unwrap();
        assert_eq!(terms[0].text, "Vipin");
    }

    #[test]
    fn a_blank_term_is_refused() {
        let mut dictionary = store();
        assert!(dictionary.add("  ", &[], Source::Manual).is_err());
    }

    #[test]
    fn a_mis_hearing_equal_to_the_term_is_dropped() {
        let mut dictionary = store();
        let terms = dictionary.add("Tauri", &["tauri,".into()], Source::Manual).unwrap();
        assert!(terms[0].heard_as.is_empty());
    }

    #[test]
    fn updating_to_another_terms_spelling_is_refused() {
        let mut dictionary = store();
        dictionary.add("Tauri", &[], Source::Manual).unwrap();
        let terms = dictionary.add("Parakeet", &[], Source::Manual).unwrap();
        let parakeet = terms.iter().find(|t| t.text == "Parakeet").unwrap().id;
        assert_eq!(
            dictionary.update(parakeet, "tauri", &[]).unwrap_err(),
            "Another term already has that spelling."
        );
    }

    #[test]
    fn uses_are_counted() {
        let mut dictionary = store();
        let id = dictionary.add("Tauri", &[], Source::Manual).unwrap()[0].id;
        dictionary.record_uses(&[id, id]).unwrap();
        let terms = dictionary.terms().unwrap();
        assert_eq!(terms[0].uses, 2);
        assert!(terms[0].last_used_at.is_some());
    }

    #[test]
    fn declined_twice_is_not_offered_again() {
        let mut dictionary = store();
        let before = "we use towery for the shell";
        let after = "we use Tauri for the shell";
        assert_eq!(dictionary.suggestions_for(before, after).unwrap().len(), 1);
        let suggestion = Suggestion { heard_as: "towery".into(), text: "Tauri".into() };
        dictionary.decline(&suggestion).unwrap();
        assert_eq!(dictionary.suggestions_for(before, after).unwrap().len(), 1);
        dictionary.decline(&suggestion).unwrap();
        assert!(dictionary.suggestions_for(before, after).unwrap().is_empty());
    }

    #[test]
    fn a_known_term_is_not_suggested_again() {
        let mut dictionary = store();
        dictionary.add("Tauri", &[], Source::Manual).unwrap();
        let suggestions = dictionary
            .suggestions_for("we use towery here", "we use Tauri here")
            .unwrap();
        assert!(suggestions.is_empty());
    }

    // -- ranking ------------------------------------------------------------

    #[test]
    fn terms_in_the_context_rank_first_and_mis_heard_ones_above_them() {
        let terms = vec![
            term(1, "Alpha", &[]),
            term(2, "Parakeet", &["parrot keet"]),
            term(3, "Tauri", &[]),
            term(4, "Zulu", &[]),
        ];
        let ranked = rank(&terms, "We built it on Tauri and the parrot keet model.", 0, 3);
        let names: Vec<&str> = ranked.iter().map(|t| t.text.as_str()).collect();
        assert_eq!(names, vec!["Parakeet", "Tauri", "Alpha"]);
    }

    #[test]
    fn recent_use_beats_old_use() {
        let day = 24 * 60 * 60 * 1_000u64;
        let now = 100 * day;
        let mut old = term(1, "Old", &[]);
        old.uses = 3;
        old.last_used_at = Some(now - 90 * day);
        let mut fresh = term(2, "Fresh", &[]);
        fresh.uses = 2;
        fresh.last_used_at = Some(now - day);
        let terms = [old, fresh];
        let ranked = rank(&terms, "", now, 2);
        assert_eq!(ranked[0].text, "Fresh");
    }

    #[test]
    fn a_term_learned_this_week_gets_a_lift() {
        let now = 10 * LEARNED_BOOST_MS;
        let mut learned = term(1, "Newish", &[]);
        learned.source = Source::Learned;
        learned.created_at = now - LEARNED_BOOST_MS / 2;
        let mut stale = term(2, "Ancient", &[]);
        stale.source = Source::Learned;
        stale.created_at = 0;
        let terms = [stale, learned];
        let ranked = rank(&terms, "", now, 2);
        assert_eq!(ranked[0].text, "Newish");
    }

    #[test]
    fn ties_are_alphabetical_and_the_limit_holds() {
        let terms = vec![term(1, "Charlie", &[]), term(2, "alpha", &[]), term(3, "Bravo", &[])];
        let ranked = rank(&terms, "", 0, 2);
        let names: Vec<&str> = ranked.iter().map(|t| t.text.as_str()).collect();
        assert_eq!(names, vec!["alpha", "Bravo"]);
    }

    #[test]
    fn the_prompt_is_one_sentence() {
        let a = term(1, "Tauri", &[]);
        let b = term(2, "Parakeet", &[]);
        let c = term(3, "whisper.cpp", &[]);
        assert_eq!(prompt_sentence(&[]), "");
        assert_eq!(prompt_sentence(&[&a]), "In this recording we talk about Tauri.");
        assert_eq!(
            prompt_sentence(&[&a, &b, &c]),
            "In this recording we talk about Tauri, Parakeet and whisper.cpp."
        );
    }

    // -- correction ---------------------------------------------------------

    #[test]
    fn a_recorded_mis_hearing_is_replaced_whole_word_any_case() {
        let terms = vec![term(1, "Tauri", &["towery", "tory"])];
        let (text, fixes) = correct("Towery is the shell. Not a Tory story.", &terms);
        assert_eq!(text, "Tauri is the shell. Not a Tauri story.");
        assert_eq!(fixes.len(), 2);
        assert_eq!(fixes[0].from, "Towery");
    }

    #[test]
    fn longer_mis_hearings_win_over_shorter_ones() {
        let terms = vec![
            term(1, "whisper.cpp", &["whisper cpp"]),
            term(2, "Whisper", &["whisper"]),
        ];
        let (text, _) = correct("we run whisper cpp here", &terms);
        assert_eq!(text, "we run whisper.cpp here");
    }

    #[test]
    fn a_word_that_sounds_like_an_earned_term_is_replaced() {
        let mut parakeet = term(1, "Parakeet", &["parrot keet"]);
        parakeet.uses = 5;
        let (text, fixes) = correct("Switch to parakeat for speed.", &[parakeet]);
        assert_eq!(text, "Switch to Parakeet for speed.");
        assert_eq!(fixes[0].from, "parakeat");
    }

    #[test]
    fn a_term_typed_once_does_not_rewrite_ordinary_words() {
        // No mis-hearings, no uses: the phonetic pass must leave this alone.
        let terms = vec![term(1, "Wright", &[])];
        let (text, fixes) = correct("write it down, right now", &terms);
        assert_eq!(text, "write it down, right now");
        assert!(fixes.is_empty());
    }

    #[test]
    fn far_off_words_are_left_alone_even_when_they_sound_close() {
        let mut term_ = term(1, "Tauri", &["towery"]);
        term_.uses = 10;
        let (text, _) = correct("The tour was long.", &[term_]);
        assert_eq!(text, "The tour was long.");
    }

    #[test]
    fn a_word_that_is_already_a_term_is_not_touched() {
        let mut a = term(1, "Mark", &["marc"]);
        a.uses = 9;
        let b = term(2, "Marc", &[]);
        let (text, fixes) = correct("Marc and Mark met.", &[a, b]);
        assert_eq!(text, "Marc and Mark met.");
        assert!(fixes.is_empty());
    }

    #[test]
    fn a_word_inside_a_dotted_or_hyphenated_term_is_not_a_match() {
        let terms = vec![term(1, "Whisper", &["whisper"]), term(2, "Mail", &["mail"])];
        let (text, fixes) = correct("whisper.cpp and e-mail, whisper", &terms);
        assert_eq!(text, "whisper.cpp and e-mail, Whisper");
        assert_eq!(fixes.len(), 1);
    }

    #[test]
    fn punctuation_around_a_corrected_word_stays() {
        let terms = vec![term(1, "Tauri", &["towery"])];
        let (text, _) = correct("(towery), \"towery\"!", &terms);
        assert_eq!(text, "(Tauri), \"Tauri\"!");
    }

    // -- suggestions --------------------------------------------------------

    #[test]
    fn a_replaced_word_is_suggested() {
        let suggestions = suggest("we use towery for the shell", "we use Tauri for the shell");
        assert_eq!(
            suggestions,
            vec![Suggestion { heard_as: "towery".into(), text: "Tauri".into() }]
        );
    }

    #[test]
    fn a_replaced_phrase_is_suggested_whole() {
        let suggestions = suggest("run the parrot keet model", "run the Parakeet model");
        assert_eq!(
            suggestions,
            vec![Suggestion { heard_as: "parrot keet".into(), text: "Parakeet".into() }]
        );
    }

    #[test]
    fn case_and_punctuation_fixes_are_not_terms() {
        assert!(suggest("hello tauri", "Hello Tauri.").is_empty());
        assert!(suggest("okay so, we ship", "Okay so we ship").is_empty());
    }

    #[test]
    fn rewording_is_not_a_term() {
        // Deleted filler and inserted words on their own.
        assert!(suggest("so um we ship it", "we ship it").is_empty());
        assert!(suggest("we ship it", "we ship it on Thursday evening").is_empty());
        // A whole clause replaced.
        assert!(suggest(
            "we should probably think about doing it later",
            "let us leave it for another sprint entirely"
        )
        .is_empty());
    }

    #[test]
    fn stop_words_and_numbers_are_not_terms() {
        assert!(suggest("send it to him", "send it to her").is_empty());
        assert!(suggest("version 2", "version 3").is_empty());
    }

    #[test]
    fn several_corrections_in_one_edit_are_all_suggested() {
        let suggestions = suggest(
            "towery talks to the parrot keet engine",
            "Tauri talks to the Parakeet engine",
        );
        assert_eq!(suggestions.len(), 2);
        assert_eq!(suggestions[0].text, "Tauri");
        assert_eq!(suggestions[1].text, "Parakeet");
    }

    #[test]
    fn levenshtein_counts_edits() {
        assert_eq!(levenshtein("kitten", "sitting"), 3);
        assert_eq!(levenshtein("", "abc"), 3);
        assert_eq!(levenshtein("same", "same"), 0);
    }
}
