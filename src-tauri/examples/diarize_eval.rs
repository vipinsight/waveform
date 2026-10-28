//! Scores the speaker tagger on recordings whose speakers are known.
//!
//!     cargo run --release --example diarize_eval -- ami [DIR] [options]
//!     cargo run --release --example diarize_eval -- wav FILE.wav REF.rttm [options]
//!     cargo run --release --example diarize_eval -- score REF.rttm HYP.rttm
//!     cargo run --release --example diarize_eval -- call [DIR] [options]
//!
//! `ami` scores every meeting `scripts/fetch-diarization-eval.sh` fetched
//! (default ~/.cache/waveform-eval/ami) and pools the totals.
//!
//! `call` builds a two-track call out of each series' second meeting: the
//! first two headsets are the Mac's microphone (the user and someone in the
//! room with them), the other two are the system track (the far end). The
//! user's voice is enrolled from the series' first meeting, as the app
//! enrols it from dictations. It scores how today's tagging (every mic line
//! `me`, the far end diarized alone) and the joined tagging do on it.
//!
//! Options:
//!     --audio mix|far      AMI only: headsets summed (default) or one table mic
//!     --only ES2004a,...   AMI only: a subset of meetings
//!     --threshold T        clustering threshold (default: the app's)
//!     --embedding PATH     another voice-print model
//!     --coreml             run the networks through CoreML instead of the CPU
//!     --minutes N          only the first N minutes of each recording: a
//!                          quick comparison, not a final number
//!     --save DIR           write each hypothesis as RTTM, to look at later
//!     --echo DB            call only: also leak the far end into the mic at
//!                          this level (e.g. -25), as laptop speakers would
//!
//! Uses the diarizer installed for the app (Models → Tell speakers apart).

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::collections::HashMap;
use waveform_lib::diarize::{self, Config, Source, Span};
use waveform_lib::diarize_eval::{self as eval, LineScore, Score, Segment, COLLAR_MS};

struct Options {
    config: Config,
    audio: String,
    only: Option<Vec<String>>,
    save: Option<PathBuf>,
    echo_db: Option<f32>,
    /// Score only the first this-many milliseconds of each recording.
    limit_ms: Option<u64>,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(error) = run(args) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run(args: Vec<String>) -> Result<(), String> {
    let (positional, options) = parse(args)?;
    let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    match positional.first().map(String::as_str) {
        Some("score") if positional.len() == 3 => {
            let reference = read_rttm(Path::new(&positional[1]))?;
            let hypothesis = read_rttm(Path::new(&positional[2]))?;
            header();
            row("", &eval::score(&reference, &hypothesis, COLLAR_MS), None, &reference, &hypothesis);
            Ok(())
        }
        Some("wav") if positional.len() == 3 => {
            let reference = read_rttm(Path::new(&positional[2]))?;
            header();
            let result = runtime.block_on(one(Path::new(&positional[1]), &reference, &options))?;
            row(&stem(&positional[1]), &result.0, Some(&result.1), &reference, &result.2);
            Ok(())
        }
        Some("call") => {
            let dir = positional.get(1).map(PathBuf::from).unwrap_or_else(default_ami_dir);
            runtime.block_on(calls(&dir, &options))
        }
        Some("ami") => {
            let dir = positional.get(1).map(PathBuf::from).unwrap_or_else(default_ami_dir);
            runtime.block_on(ami(&dir, &options))
        }
        _ => Err("usage: diarize_eval ami [DIR] | call [DIR] | wav FILE.wav REF.rttm | score REF.rttm HYP.rttm  [options]".into()),
    }
}

fn parse(args: Vec<String>) -> Result<(Vec<String>, Options), String> {
    let mut options = Options { config: Config::default(), audio: "mix".into(), only: None, save: None, echo_db: None, limit_ms: None };
    let mut positional = Vec::new();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or(format!("{arg} needs a value"));
        match arg.as_str() {
            "--threshold" => {
                options.config.cluster_threshold = value()?.parse().map_err(|_| "--threshold takes a number")?
            }
            "--embedding" => options.config.embedding = Some(PathBuf::from(value()?)),
            "--coreml" => options.config.provider = "coreml",
            "--minutes" => {
                let minutes: f64 = value()?.parse().map_err(|_| "--minutes takes a number")?;
                options.limit_ms = Some((minutes * 60_000.0) as u64);
            }
            "--audio" => options.audio = value()?,
            "--only" => options.only = Some(value()?.split(',').map(str::to_string).collect()),
            "--save" => options.save = Some(PathBuf::from(value()?)),
            "--echo" => options.echo_db = Some(value()?.parse().map_err(|_| "--echo takes decibels")?),
            _ if arg.starts_with("--") => return Err(format!("unknown option {arg}")),
            _ => positional.push(arg),
        }
    }
    Ok((positional, options))
}

fn default_ami_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".cache/waveform-eval/ami")
}

async fn ami(dir: &Path, options: &Options) -> Result<(), String> {
    let mut ids: Vec<String> = std::fs::read_dir(dir)
        .map_err(|e| format!("{}: {e} (run scripts/fetch-diarization-eval.sh)", dir.display()))?
        .filter_map(|entry| {
            let name = entry.ok()?.file_name().into_string().ok()?;
            name.strip_suffix(".rttm").map(str::to_string)
        })
        .filter(|id| options.only.as_ref().map_or(true, |only| only.contains(id)))
        .collect();
    ids.sort();
    println!(
        "AMI {} audio{}, threshold {}, embedding {}",
        options.audio,
        options.limit_ms.map_or(String::new(), |ms| format!(" (first {} min)", ms / 60_000)),
        options.config.cluster_threshold,
        options.config.embedding.as_ref().map_or("installed".into(), |p| stem(&p.display().to_string()))
    );
    header();
    let (mut total, mut lines) = (Score::default(), LineScore::default());
    let (mut count_right, mut count_off) = (0, 0usize);
    for id in &ids {
        let wav = dir.join(format!("{id}.{}.wav", options.audio));
        if !wav.is_file() {
            println!("{id:<10} (no {} audio)", options.audio);
            continue;
        }
        let mut reference = read_rttm(&dir.join(format!("{id}.rttm")))?;
        if let Some(limit) = options.limit_ms {
            reference = eval::crop(&reference, limit);
        }
        let (score, line_score, hypothesis) = one(&wav, &reference, options).await?;
        row(id, &score, Some(&line_score), &reference, &hypothesis);
        total.add(&score);
        lines.add(&line_score);
        let off = eval::speaker_count(&hypothesis).abs_diff(eval::speaker_count(&reference));
        count_off += off;
        count_right += usize::from(off == 0);
    }
    println!("{}", "-".repeat(78));
    println!(
        "{:<10} {:>6.1}% {:>6.1}% {:>6.1}% {:>6.1}%   right count {}/{}, off by {:.1} avg   {:>6.1}%",
        "pooled",
        total.der() * 100.0,
        pct(total.missed_ms, total.scored_ms),
        pct(total.false_alarm_ms, total.scored_ms),
        pct(total.confusion_ms, total.scored_ms),
        count_right,
        ids.len(),
        count_off as f64 / ids.len().max(1) as f64,
        lines.accuracy() * 100.0,
    );
    println!("{:<10} {} lines, {} hold two people", "", lines.total, lines.mixed);
    Ok(())
}

/// Diarizes one recording and scores it.
async fn one(wav: &Path, reference: &[Segment], options: &Options) -> Result<(Score, LineScore, Vec<Segment>), String> {
    let scratch = std::env::temp_dir().join(format!("diarize-eval-{}.wav", std::process::id()));
    let mut samples = eval::read_16k(wav)?;
    let cropped;
    let reference = match options.limit_ms {
        Some(limit) => {
            samples.truncate((limit * 16) as usize);
            cropped = eval::crop(reference, limit);
            &cropped[..]
        }
        None => reference,
    };
    eval::write_16k(&samples, &scratch)?;
    let turns = diarize::run_with(&scratch, &options.config, &AtomicBool::new(false)).await;
    let _ = std::fs::remove_file(&scratch);
    let turns = turns?;
    let hypothesis: Vec<Segment> = turns.iter().map(Segment::from).collect();
    if let Some(dir) = &options.save {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let name = stem(&wav.display().to_string());
        std::fs::write(dir.join(format!("{name}.rttm")), eval::to_rttm(&name, &hypothesis))
            .map_err(|e| e.to_string())?;
    }

    // Lines as the app would cut them, tagged the way the app tags them.
    let spans = eval::app_lines(&samples);
    let tags: std::collections::HashMap<i64, String> = diarize::assign(&spans, &turns).into_iter().collect();
    let pairs: Vec<(String, Option<String>)> = spans
        .iter()
        .filter_map(|span| {
            let truth = eval::majority(reference, span.start_ms, span.end_ms)?;
            Some((truth.to_string(), tags.get(&span.idx).cloned()))
        })
        .collect();
    let mut lines = eval::line_accuracy(&pairs);
    lines.mixed = spans.iter().filter(|span| eval::is_mixed(reference, span.start_ms, span.end_ms)).count();
    Ok((eval::score(reference, &hypothesis, COLLAR_MS), lines, hypothesis))
}

fn header() {
    println!(
        "{:<10} {:>7} {:>7} {:>7} {:>7}   {:<29} {:>7}",
        "", "DER", "miss", "f.alarm", "confuse", "speakers found / true", "lines"
    );
}

fn row(id: &str, score: &Score, lines: Option<&LineScore>, reference: &[Segment], hypothesis: &[Segment]) {
    println!(
        "{:<10} {:>6.1}% {:>6.1}% {:>6.1}% {:>6.1}%   {:<29} {:>7}",
        id,
        score.der() * 100.0,
        pct(score.missed_ms, score.scored_ms),
        pct(score.false_alarm_ms, score.scored_ms),
        pct(score.confusion_ms, score.scored_ms),
        format!("{} / {}", eval::speaker_count(hypothesis), eval::speaker_count(reference)),
        lines.map_or("-".into(), |l| format!("{:.1}%", l.accuracy() * 100.0)),
    );
    if let Some(l) = lines {
        println!("{:<10} {} lines, {} hold two people", "", l.total, l.mixed);
    }
}

fn pct(part: u64, whole: u64) -> f64 {
    if whole == 0 {
        0.0
    } else {
        part as f64 * 100.0 / whole as f64
    }
}

fn read_rttm(path: &Path) -> Result<Vec<Segment>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(eval::parse_rttm(&text))
}

fn stem(path: &str) -> String {
    Path::new(path).file_stem().map_or(path.into(), |s| s.to_string_lossy().into_owned())
}

/// Line-level results of one way of tagging a call.
#[derive(Default)]
struct CallScore {
    lines: LineScore,
    /// Lines the user said / of those, tagged `me` / lines tagged `me`.
    mine: usize,
    mine_found: usize,
    tagged_me: usize,
    /// Mic lines that are only the far end leaking in / of those, caught /
    /// lines wrongly called an echo.
    echoes: usize,
    echoes_caught: usize,
    false_echoes: usize,
    /// People found / people there.
    found: usize,
    present: usize,
}

const ECHO: &str = "(echo)";

impl CallScore {
    /// `truth` and `guess` per line; `me` and the echo marker must match by
    /// name, every other label is paired up the way that scores best.
    fn of(truth: &[(i64, String)], guess: &HashMap<i64, String>, present: usize) -> CallScore {
        let mut out = CallScore { present, ..Default::default() };
        let mut others = Vec::new();
        for (idx, truth) in truth {
            let guess = guess.get(idx).map(String::as_str);
            let fixed = |label: &str| label == diarize::ME || label == ECHO;
            match (truth.as_str(), guess) {
                (t, g) if fixed(t) || g.is_some_and(fixed) => {
                    if Some(t) == g {
                        out.lines.correct += 1;
                    }
                }
                (t, g) => others.push((t.to_string(), g.map(str::to_string))),
            }
            out.mine += usize::from(truth == diarize::ME);
            out.mine_found += usize::from(truth == diarize::ME && guess == Some(diarize::ME));
            out.tagged_me += usize::from(guess == Some(diarize::ME));
            out.echoes += usize::from(truth == ECHO);
            out.echoes_caught += usize::from(truth == ECHO && guess == Some(ECHO));
            out.false_echoes += usize::from(truth != ECHO && guess == Some(ECHO));
        }
        out.lines.correct += eval::line_accuracy(&others).correct;
        out.lines.total = truth.len();
        let mut labels: Vec<&String> = guess.values().filter(|g| g.as_str() != ECHO).collect();
        labels.sort();
        labels.dedup();
        out.found = labels.len();
        out
    }

    fn print(&self, name: &str) {
        println!(
            "  {name:<8} lines {:>5.1}%   me: found {:>5.1}% of mine, {:>5.1}% of 'me' right   echo: caught {}/{}, {} false   people {}/{}",
            self.lines.accuracy() * 100.0,
            pct(self.mine_found as u64, self.mine as u64),
            pct(self.mine_found as u64, self.tagged_me as u64),
            self.echoes_caught,
            self.echoes,
            self.false_echoes,
            self.found,
            self.present,
        );
    }
}

async fn calls(dir: &Path, options: &Options) -> Result<(), String> {
    println!(
        "two-track calls, threshold {}, echo {}",
        options.config.cluster_threshold,
        options.echo_db.map_or("none".into(), |db| format!("{db} dB"))
    );
    for series in ["ES2004", "IS1009"] {
        if options.only.as_ref().is_some_and(|only| !only.iter().any(|o| o == series)) {
            continue;
        }
        call(dir, series, options).await?;
    }
    Ok(())
}

async fn call(dir: &Path, series: &str, options: &Options) -> Result<(), String> {
    let (enrol_id, call_id) = (format!("{series}a"), format!("{series}b"));
    let mut reference = read_rttm(&dir.join(format!("{call_id}.rttm")))?;
    let mut headsets: Vec<Vec<f32>> = (0..4)
        .map(|n| eval::read_16k(&dir.join(format!("{call_id}.headset-{n}.wav"))))
        .collect::<Result<_, _>>()?;
    if let Some(limit) = options.limit_ms {
        reference = eval::crop(&reference, limit);
        for headset in &mut headsets {
            headset.truncate((limit * 16) as usize);
        }
    }
    let owners: Vec<String> = headsets
        .iter()
        .map(|h| eval::owner(h, &reference).ok_or("a headset with no owner"))
        .collect::<Result<_, _>>()?;
    let me = owners[0].clone();

    // The user's voice, from the series' first meeting.
    let enrol_reference = read_rttm(&dir.join(format!("{enrol_id}.rttm")))?;
    let mut enrolment = Vec::new();
    for n in 0..4 {
        let headset = eval::read_16k(&dir.join(format!("{enrol_id}.headset-{n}.wav")))?;
        if eval::owner(&headset, &enrol_reference).as_deref() == Some(me.as_str()) {
            enrolment = eval::clips(&headset, &enrol_reference, &me, 60_000);
        }
    }
    if enrolment.is_empty() {
        return Err(format!("{me} is not in {enrol_id}"));
    }

    let length = headsets.iter().map(Vec::len).max().unwrap_or(0);
    let sum = |which: &[usize], gain: f32, delay: usize| -> Vec<f32> {
        let mut out = vec![0.0f32; length + delay];
        for &n in which {
            for (i, sample) in headsets[n].iter().enumerate() {
                out[i + delay] += sample * gain;
            }
        }
        out.truncate(length);
        out
    };
    let mut mic = sum(&[0, 1], 1.0, 0);
    if let Some(db) = options.echo_db {
        // Out of the speakers and back in a few tens of milliseconds later.
        let leak = sum(&[2, 3], 10f32.powf(db / 20.0), 16 * 40);
        for (m, l) in mic.iter_mut().zip(leak) {
            *m += l;
        }
    }
    let system = sum(&[2, 3], 1.0, 0);

    let on = |which: &[usize]| -> Vec<eval::Segment> {
        reference.iter().filter(|s| which.iter().any(|&n| owners[n] == s.speaker)).cloned().collect()
    };
    let (mic_reference, system_reference) = (on(&[0, 1]), on(&[2, 3]));

    let mic_lines = eval::app_lines(&mic);
    let system_lines: Vec<Span> = eval::app_lines(&system)
        .into_iter()
        .map(|span| Span { idx: span.idx + 100_000, ..span })
        .collect();

    // What each line really is.
    let mut truth: Vec<(i64, String)> = Vec::new();
    for line in &mic_lines {
        match eval::majority(&mic_reference, line.start_ms, line.end_ms) {
            Some(who) if who == me => truth.push((line.idx, diarize::ME.into())),
            Some(who) => truth.push((line.idx, who.into())),
            None if eval::majority(&system_reference, line.start_ms, line.end_ms).is_some() => {
                truth.push((line.idx, ECHO.into()))
            }
            None => {}
        }
    }
    for line in &system_lines {
        if let Some(who) = eval::majority(&system_reference, line.start_ms, line.end_ms) {
            truth.push((line.idx, who.into()));
        }
    }
    let scored: std::collections::HashSet<i64> = truth.iter().map(|(idx, _)| *idx).collect();
    let present = 4;

    let cancel = AtomicBool::new(false);
    let scratch = std::env::temp_dir().join(format!("diarize-eval-{}.wav", std::process::id()));

    // Today: every mic line is the user; the far end is diarized alone.
    eval::write_16k(&system, &scratch)?;
    let turns = diarize::run_with(&scratch, &options.config, &cancel).await?;
    let mut today: HashMap<i64, String> =
        mic_lines.iter().map(|line| (line.idx, diarize::ME.to_string())).collect();
    today.extend(diarize::assign(&system_lines, &turns));
    today.retain(|idx, _| scored.contains(idx));

    // Joined: one run over the enrolment, the mic and the far end.
    let joined = diarize::join(&[
        (Source::Enrolment, &enrolment),
        (Source::Mic, &mic),
        (Source::System, &system),
    ]);
    eval::write_16k(&joined.samples, &scratch)?;
    let turns = diarize::run_with(&scratch, &options.config, &cancel).await;
    let _ = std::fs::remove_file(&scratch);
    let tagged = diarize::tag_call(&mic_lines, &system_lines, &joined.split(&turns?));
    let mut now: HashMap<i64, String> = tagged.tags.into_iter().collect();
    now.extend(tagged.echoes.into_iter().map(|idx| (idx, ECHO.to_string())));
    now.retain(|idx, _| scored.contains(idx));

    println!(
        "{call_id}: {} mic lines, {} far-end lines, {:.0} s of enrolment",
        mic_lines.len(),
        system_lines.len(),
        enrolment.len() as f64 / 16_000.0
    );
    CallScore::of(&truth, &today, present).print("today");
    CallScore::of(&truth, &now, present).print("joined");
    Ok(())
}
