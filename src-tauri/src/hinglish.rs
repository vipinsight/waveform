//! Hinglish: Hindi and English mixed in one sentence, typed in Roman script.
//!
//! It is how a lot of people talk and text ("kal meeting hai, deck ready
//! rakhna"), and no engine here offers it as a language. Each of them gets it
//! wrong in its own way when left alone:
//!
//! - Told the language is Hindi, Whisper and Qwen write everything, English
//!   words included, in Devanagari ("मीटिंग").
//! - Told it is English, they keep English words in Roman script, but Whisper
//!   is as likely to translate the Hindi into English as to transcribe it, and
//!   Qwen leaves the Hindi in Devanagari.
//! - Told it is English *and* primed with a sentence of Roman-script Hinglish,
//!   both write what was said, in Roman script. That is what this module does.
//!
//! Priming is a strong nudge, not a guarantee: a phrase that is mostly Hindi
//! can still come back with a word or two in Devanagari. `romanize` turns
//! those into the casual spelling a Hinglish speaker would type, so the text
//! that reaches the cursor or the meeting transcript is in one script.
//!
//! Parakeet knows no Hindi at all, so for it this changes nothing useful; the
//! interface says so where the language is chosen.

/// The value the settings store for Hinglish. Not an ISO 639-1 code, because
/// there is none; it never reaches an engine (see `engine_language`).
pub const CODE: &str = "hinglish";

/// Roman-script Hinglish for the decoder to continue from. It goes in front of
/// whatever the session has said so far, so once there is enough of that, the
/// session's own Hinglish is what does the priming and this is what gives way.
const PRIMER: &str = "Haan, main kal office aaunga. Meeting ke baad call karte hain, theek hai?";

/// The language an engine is told for a stored setting.
pub fn engine_language(setting: &str) -> &str {
    if setting == CODE {
        "en"
    } else {
        setting
    }
}

/// What the session has said so far, with the primer in front for Hinglish.
/// The fixed text a setting primes the engine with, which an engine given
/// silence may hand back; see `dictionary::without_prompt_echo`.
pub fn primer(setting: &str) -> &'static str {
    if setting == CODE {
        PRIMER
    } else {
        ""
    }
}

pub fn primed_context(setting: &str, prior: &str) -> String {
    if setting != CODE {
        return prior.to_string();
    }
    if prior.trim().is_empty() {
        PRIMER.to_string()
    } else {
        format!("{PRIMER} {prior}")
    }
}

/// Said to the rewriting model alongside the user's own prompt. Without it a
/// model asked to "fix grammar" tends to read Hinglish as broken English and
/// translate it; `rewrite::is_rewrite_of` would refuse that, but the phrase
/// would then go out with no cleanup at all.
const REWRITE_NOTE: &str = "The text may be Hinglish: Hindi and English mixed, written in Roman \
script. When it is, keep it Hinglish in Roman script. Do not translate any of it into English or Hindi, \
do not write it in Devanagari, and do not \"correct\" Hindi words into English ones.";

/// The rewrite prompt for a stored language setting.
pub fn rewrite_prompt(setting: &str, prompt: &str) -> String {
    if setting == CODE {
        format!("{}\n\n{REWRITE_NOTE}", prompt.trim_end())
    } else {
        prompt.to_string()
    }
}

/// Whether `text` has any Devanagari in it.
pub fn has_devanagari(text: &str) -> bool {
    text.chars().any(is_devanagari)
}

fn is_devanagari(c: char) -> bool {
    ('\u{0900}'..='\u{097F}').contains(&c)
}

/// One Devanagari letter, as the parts schwa deletion needs to tell apart.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Unit {
    /// A consonant, with the vowel written after it: `None` for the inherent
    /// "a", which may or may not be said, and `Some("")` after a virama, which
    /// says there is none.
    Consonant(&'static str, Option<&'static str>),
    /// A vowel written as its own letter.
    Vowel(&'static str),
    /// Anusvara or chandrabindu: a nasal, written "n" or "m".
    Nasal,
    /// Visarga.
    Breath,
}

/// Rewrites every Devanagari word in `text` in Roman script, the way Hinglish
/// is casually typed: "क्यों" is "kyon", "मैं" is "main", "करता" is "karta".
///
/// Everything else is left exactly as it was, so a phrase that came back
/// mostly in Roman script keeps its spelling and punctuation.
pub fn romanize(text: &str) -> String {
    if !has_devanagari(text) {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut word: Vec<char> = Vec::new();
    for c in text.chars() {
        if is_devanagari(c) && !matches!(c, '।' | '॥') && !is_digit(c) {
            word.push(c);
            continue;
        }
        if !word.is_empty() {
            out.push_str(&romanize_word(&word));
            word.clear();
        }
        match c {
            '।' | '॥' => out.push('.'),
            c if is_digit(c) => out.push(char::from(b'0' + (c as u32 - 0x0966) as u8)),
            c => out.push(c),
        }
    }
    if !word.is_empty() {
        out.push_str(&romanize_word(&word));
    }
    out
}

fn is_digit(c: char) -> bool {
    ('\u{0966}'..='\u{096F}').contains(&c)
}

fn romanize_word(chars: &[char]) -> String {
    let units = parse(chars);
    let said = delete_schwas(&units);
    let mut out = String::new();
    for (index, unit) in units.iter().enumerate() {
        // Whether this is the word's last sound, and whether a nasal closes it.
        let last = index + 1 == units.len();
        let nasal_last = index + 2 == units.len() && matches!(units[index + 1], Unit::Nasal);
        let ending = Ending::of(last, nasal_last);
        match *unit {
            Unit::Consonant(sound, vowel) => {
                // "chchh" is how no one types अच्छा.
                if sound == "ch" && vowel == Some("") {
                    if let Some(Unit::Consonant("chh", _)) = units.get(index + 1) {
                        out.push('c');
                        continue;
                    }
                }
                out.push_str(sound);
                match vowel {
                    None if said[index] => out.push('a'),
                    None => {}
                    Some(vowel) => out.push_str(final_form(vowel, ending)),
                }
            }
            // A word that is one vowel keeps it long: आ is "aa".
            Unit::Vowel(vowel) if index == 0 => out.push_str(vowel),
            Unit::Vowel(vowel) => out.push_str(final_form(vowel, ending)),
            Unit::Nasal => {
                // "m" before p, b and m: सम्भव, संभव are both "sambhav".
                let labial = matches!(
                    units.get(index + 1),
                    Some(Unit::Consonant(sound, _)) if sound.starts_with(['p', 'b', 'm'])
                );
                out.push(if labial { 'm' } else { 'n' });
            }
            Unit::Breath => out.push('h'),
        }
    }
    out
}

#[derive(Clone, Copy, PartialEq)]
enum Ending {
    Inside,
    /// The last sound of the word.
    Open,
    /// The last vowel, with only a nasal after it.
    Nasal,
}

impl Ending {
    fn of(last: bool, nasal_last: bool) -> Self {
        if last {
            Ending::Open
        } else if nasal_last {
            Ending::Nasal
        } else {
            Ending::Inside
        }
    }
}

/// How a vowel is typed where it falls. Long vowels are typed short at the end
/// of a word ("tha", "bhi", "tu"), and "ee" before a closing nasal too
/// ("nahin"); "e" before one is "ei", so में is "mein".
fn final_form(vowel: &'static str, ending: Ending) -> &'static str {
    match (vowel, ending) {
        ("aa", Ending::Open) => "a",
        ("ee", Ending::Open | Ending::Nasal) => "i",
        ("oo", Ending::Open) => "u",
        ("e", Ending::Nasal) => "ei",
        (vowel, _) => vowel,
    }
}

fn parse(chars: &[char]) -> Vec<Unit> {
    let mut units = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        let c = chars[index];
        let nukta = chars.get(index + 1) == Some(&'\u{093C}');
        if let Some(sound) = consonant(c, nukta) {
            index += if nukta { 2 } else { 1 };
            let vowel = match chars.get(index).copied() {
                Some('\u{094D}') => {
                    index += 1;
                    Some("")
                }
                Some(sign) => match vowel_sign(sign) {
                    Some(vowel) => {
                        index += 1;
                        Some(vowel)
                    }
                    None => None,
                },
                None => None,
            };
            units.push(Unit::Consonant(sound, vowel));
            continue;
        }
        index += 1;
        if let Some(vowel) = independent_vowel(c) {
            units.push(Unit::Vowel(vowel));
        } else if matches!(c, '\u{0901}' | '\u{0902}') {
            units.push(Unit::Nasal);
        } else if c == '\u{0903}' {
            units.push(Unit::Breath);
        } else if let Some(vowel) = vowel_sign(c) {
            // A vowel sign with no consonant before it: misrecognised, but
            // still a vowel worth keeping.
            units.push(Unit::Vowel(vowel));
        }
        // Anything else (a stray nukta, an accent mark) carries no sound.
    }
    units
}

/// Which inherent vowels are said. Hindi drops the "a" at the end of a word
/// and, reading right to left, in any vowel-consonant-a-consonant-vowel run:
/// कल is "kal", करता is "karta", समझना is "samajhna".
fn delete_schwas(units: &[Unit]) -> Vec<bool> {
    let mut said: Vec<bool> = units
        .iter()
        .map(|unit| matches!(unit, Unit::Consonant(_, None)))
        .collect();
    let has_vowel = |said: &[bool], index: usize| match units[index] {
        Unit::Consonant(_, None) => said[index],
        Unit::Consonant(_, Some(vowel)) => !vowel.is_empty(),
        Unit::Vowel(_) => true,
        Unit::Nasal | Unit::Breath => false,
    };
    // The last letter that can carry a vowel, past any nasal or visarga.
    let end = units
        .iter()
        .rposition(|unit| matches!(unit, Unit::Consonant(..) | Unit::Vowel(_)));
    let Some(end) = end else { return said };
    // A one-letter word keeps its vowel: न is "na".
    if end > 0 && matches!(units[end], Unit::Consonant(_, None)) {
        said[end] = false;
    }
    for index in (1..end).rev() {
        if !matches!(units[index], Unit::Consonant(_, None)) {
            continue;
        }
        let before = has_vowel(&said, index - 1);
        let next_is_consonant = matches!(units[index + 1], Unit::Consonant(..));
        let after = next_is_consonant && has_vowel(&said, index + 1);
        if before && after {
            said[index] = false;
        }
    }
    said
}

fn consonant(c: char, nukta: bool) -> Option<&'static str> {
    Some(match (c, nukta) {
        ('क', true) | ('\u{0958}', _) => "q",
        ('ख', true) | ('\u{0959}', _) => "kh",
        ('ग', true) | ('\u{095A}', _) => "g",
        ('ज', true) | ('\u{095B}', _) => "z",
        ('ड', true) | ('\u{095C}', _) => "d",
        ('ढ', true) | ('\u{095D}', _) => "dh",
        ('फ', true) | ('\u{095E}', _) => "f",
        ('य', true) | ('\u{095F}', _) => "y",
        ('क', _) => "k",
        ('ख', _) => "kh",
        ('ग', _) => "g",
        ('घ', _) => "gh",
        ('ङ', _) => "n",
        ('च', _) => "ch",
        ('छ', _) => "chh",
        ('ज', _) => "j",
        ('झ', _) => "jh",
        ('ञ', _) => "n",
        ('ट', _) => "t",
        ('ठ', _) => "th",
        ('ड', _) => "d",
        ('ढ', _) => "dh",
        ('ण', _) => "n",
        ('त', _) => "t",
        ('थ', _) => "th",
        ('द', _) => "d",
        ('ध', _) => "dh",
        ('न', _) => "n",
        ('प', _) => "p",
        ('फ', _) => "ph",
        ('ब', _) => "b",
        ('भ', _) => "bh",
        ('म', _) => "m",
        ('य', _) => "y",
        ('र', _) => "r",
        ('ल', _) => "l",
        ('व', _) => "v",
        ('श', _) => "sh",
        ('ष', _) => "sh",
        ('स', _) => "s",
        ('ह', _) => "h",
        _ => return None,
    })
}

fn independent_vowel(c: char) -> Option<&'static str> {
    Some(match c {
        'अ' => "a",
        'आ' => "aa",
        'इ' => "i",
        'ई' => "ee",
        'उ' => "u",
        'ऊ' => "oo",
        'ऋ' => "ri",
        'ए' => "e",
        'ऐ' => "ai",
        'ऑ' | 'ओ' => "o",
        'ऍ' => "e",
        'औ' => "au",
        _ => return None,
    })
}

fn vowel_sign(c: char) -> Option<&'static str> {
    Some(match c {
        'ा' => "aa",
        'ि' => "i",
        'ी' => "ee",
        'ु' => "u",
        'ू' => "oo",
        'ृ' => "ri",
        'े' => "e",
        'ै' => "ai",
        'ॉ' | 'ो' => "o",
        'ॅ' => "e",
        'ौ' => "au",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engines_are_told_english_for_hinglish_and_nothing_else_changes() {
        assert_eq!(engine_language("hinglish"), "en");
        assert_eq!(engine_language("hi"), "hi");
        assert_eq!(engine_language(""), "");
    }

    #[test]
    fn only_hinglish_is_primed() {
        assert_eq!(primed_context("en", "so far"), "so far");
        assert_eq!(primed_context("hinglish", ""), PRIMER);
        assert_eq!(primed_context("hinglish", "abhi tak"), format!("{PRIMER} abhi tak"));
    }

    #[test]
    fn only_hinglish_rewrites_carry_the_note() {
        assert_eq!(rewrite_prompt("en", "Fix it."), "Fix it.");
        assert!(rewrite_prompt("hinglish", "Fix it.").starts_with("Fix it.\n\nThe text may be Hinglish"));
    }

    #[test]
    fn roman_text_is_left_alone() {
        let text = "Kal meri client ke saath meeting hai, deck ready rakhna.";
        assert_eq!(romanize(text), text);
    }

    #[test]
    fn common_words_come_out_as_they_are_typed() {
        for (devanagari, roman) in [
            ("कल", "kal"),
            ("मैं", "main"),
            ("है", "hai"),
            ("नहीं", "nahin"),
            ("करता", "karta"),
            ("समझना", "samajhna"),
            ("रहा", "raha"),
            ("यार", "yaar"),
            ("क्यों", "kyon"),
            ("थोड़ा", "thoda"),
            ("अच्छा", "acchha"),
            ("में", "mein"),
            ("हाँ", "haan"),
            ("मीटिंग", "meeting"),
            ("हूँ", "hoon"),
            ("भी", "bhi"),
            ("ज़रूर", "zaroor"),
            ("न", "na"),
            ("आज", "aaj"),
        ] {
            assert_eq!(romanize(devanagari), roman, "{devanagari}");
        }
    }

    #[test]
    fn mixed_script_keeps_its_roman_words_and_punctuation() {
        assert_eq!(
            romanize("यार, ये bug production में क्यों आ रहा है?"),
            "yaar, ye bug production mein kyon aa raha hai?"
        );
    }

    #[test]
    fn danda_and_digits_become_ascii() {
        assert_eq!(romanize("ठीक है। २ बजे"), "theek hai. 2 baje");
    }
}
