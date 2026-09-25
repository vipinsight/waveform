//! Input-only microphone capture via Core Audio.
//!
//! WKWebView's getUserMedia plus AudioContext is what interrupts Music:
//! the context attaches to the default output, so AirPods get pulled into
//! an aggregate with the built-in mic. This opens one HAL input device and
//! never an output, which is how a dictation app can listen while headphones
//! keep playing.
//!
//! The cpal stream is not Send on macOS, so it lives on this module's thread.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig};
use serde::Serialize;
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const OVERLAY_LABEL: &str = "overlay";
const BLOCK: usize = 2048;
const QUEUE: usize = 8;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureBlock {
    samples: Vec<f32>,
    sample_rate: u32,
}

enum Command {
    Start {
        preferred: String,
        app: AppHandle,
        reply: Sender<Result<String, String>>,
    },
    Stop {
        reply: Sender<()>,
    },
}

#[derive(Clone)]
pub struct NativeCapture {
    commands: Sender<Command>,
}

impl NativeCapture {
    pub fn new() -> Self {
        let (commands, inbox) = mpsc::channel();
        std::thread::Builder::new()
            .name("waveform-mic-host".into())
            .spawn(move || run(inbox))
            .expect("microphone thread");
        Self { commands }
    }

    pub fn start(&self, app: &AppHandle, preferred_name: &str) -> Result<String, String> {
        let (reply, wait) = mpsc::channel();
        self.commands
            .send(Command::Start {
                preferred: preferred_name.to_string(),
                app: app.clone(),
                reply,
            })
            .map_err(|_| "Microphone thread stopped".to_string())?;
        wait.recv()
            .map_err(|_| "Microphone thread stopped".to_string())?
    }

    pub fn stop(&self) {
        let (reply, wait) = mpsc::channel();
        if self.commands.send(Command::Stop { reply }).is_err() {
            return;
        }
        let _ = wait.recv_timeout(Duration::from_secs(2));
    }
}

fn run(inbox: Receiver<Command>) {
    let mut stream: Option<Stream> = None;
    while let Ok(command) = inbox.recv() {
        match command {
            Command::Start {
                preferred,
                app,
                reply,
            } => {
                stop_stream(&mut stream);
                match open(&preferred, app) {
                    Ok((opened, next)) => {
                        stream = Some(next);
                        let _ = reply.send(Ok(opened));
                    }
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                }
            }
            Command::Stop { reply } => {
                stop_stream(&mut stream);
                let _ = reply.send(());
            }
        }
    }
}

fn stop_stream(stream: &mut Option<Stream>) {
    if let Some(stream) = stream.take() {
        let _ = stream.pause();
        drop(stream);
    }
}

fn open(preferred_name: &str, app: AppHandle) -> Result<(String, Stream), String> {
    let device = pick_input_device(preferred_name)?;
    let name = device.name().unwrap_or_else(|_| "microphone".into());
    let supported = device
        .default_input_config()
        .map_err(|error| format!("Microphone unavailable: {error}"))?;
    let sample_rate = supported.sample_rate().0;
    let channels = supported.channels() as usize;
    let format = supported.sample_format();
    let config: StreamConfig = supported.into();

    let (sender, receiver) = mpsc::sync_channel::<CaptureBlock>(QUEUE);
    let emit = app.clone();
    std::thread::Builder::new()
        .name("waveform-mic".into())
        .spawn(move || {
            while let Ok(block) = receiver.recv() {
                let _ = emit.emit_to(OVERLAY_LABEL, "capture-block", block);
            }
        })
        .map_err(|error| format!("Microphone unavailable: {error}"))?;

    let stream = match format {
        SampleFormat::F32 => build_f32(&device, &config, channels, sample_rate, sender)?,
        SampleFormat::I16 => build_i16(&device, &config, channels, sample_rate, sender)?,
        other => return Err(format!("Microphone sample format {other} is unsupported")),
    };
    stream
        .play()
        .map_err(|error| format!("Microphone failed to start: {error}"))?;
    Ok((format!("{name} at {sample_rate}Hz"), stream))
}

fn build_f32(
    device: &cpal::Device,
    config: &StreamConfig,
    channels: usize,
    sample_rate: u32,
    sender: SyncSender<CaptureBlock>,
) -> Result<Stream, String> {
    let mut pending = Vec::with_capacity(BLOCK);
    device
        .build_input_stream(
            config,
            move |data: &[f32], _| {
                push_frames(&mut pending, data, channels, sample_rate, &sender);
            },
            |error| eprintln!("waveform: microphone stream error: {error}"),
            None,
        )
        .map_err(|error| format!("Could not open the microphone: {error}"))
}

fn build_i16(
    device: &cpal::Device,
    config: &StreamConfig,
    channels: usize,
    sample_rate: u32,
    sender: SyncSender<CaptureBlock>,
) -> Result<Stream, String> {
    let mut pending = Vec::with_capacity(BLOCK);
    device
        .build_input_stream(
            config,
            move |data: &[i16], _| {
                let converted: Vec<f32> = data.iter().map(|sample| *sample as f32 / 32768.0).collect();
                push_frames(&mut pending, &converted, channels, sample_rate, &sender);
            },
            |error| eprintln!("waveform: microphone stream error: {error}"),
            None,
        )
        .map_err(|error| format!("Could not open the microphone: {error}"))
}

fn push_frames(
    pending: &mut Vec<f32>,
    data: &[f32],
    channels: usize,
    sample_rate: u32,
    sender: &SyncSender<CaptureBlock>,
) {
    let channels = channels.max(1);
    for frame in data.chunks(channels) {
        pending.push(frame.first().copied().unwrap_or(0.0));
        if pending.len() >= BLOCK {
            let samples = std::mem::replace(pending, Vec::with_capacity(BLOCK));
            let _ = sender.try_send(CaptureBlock {
                samples,
                sample_rate,
            });
        }
    }
}

fn pick_input_device(preferred_name: &str) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    let mut devices = host
        .input_devices()
        .map_err(|error| format!("No microphone found: {error}"))?
        .collect::<Vec<_>>();

    if !preferred_name.is_empty() {
        if let Some(index) = devices.iter().position(|device| {
            device
                .name()
                .map(|name| input_device_matches(&name, preferred_name))
                .unwrap_or(false)
        }) {
            return Ok(devices.swap_remove(index));
        }
    }

    // Empty preference (and a preferred name that vanished) used to fall
    // straight through to macOS's default input. AirPods steal that default
    // whenever they are connected, so dictation — and the recording kept for
    // playback — quietly moved off the built-in mic. Prefer the laptop mic
    // unless the user has named something else.
    if let Some(index) = devices
        .iter()
        .position(|device| device.name().map(|name| is_built_in_input(&name)).unwrap_or(false))
    {
        return Ok(devices.swap_remove(index));
    }

    host.default_input_device()
        .ok_or_else(|| "No microphone found.".into())
}

/// The laptop's own microphone, not a headset macOS may have made default.
pub fn is_built_in_input(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    normalized.contains("macbook")
        || normalized.contains("built-in")
        || normalized.contains("internal microphone")
        || normalized.contains("mac mini")
        || normalized.contains("imac")
}

/// Whether a Core Audio device is the one Settings asked for.
///
/// WebKit and HAL spell the same input differently ("MacBook Pro Microphone"
/// vs a shorter HAL name). A default empty preference is not a name.
pub fn input_device_matches(device_name: &str, preferred: &str) -> bool {
    if preferred.is_empty() {
        return false;
    }
    let left = normalize_device_name(device_name);
    let right = normalize_device_name(preferred);
    !left.is_empty()
        && !right.is_empty()
        && (left == right || left.contains(&right) || right.contains(&left))
}

fn normalize_device_name(name: &str) -> String {
    name.to_ascii_lowercase()
        .replace("microphone", " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macbook_labels_from_webkit_and_hal_match() {
        assert!(input_device_matches(
            "MacBook Pro Microphone",
            "MacBook Pro Microphone"
        ));
        assert!(input_device_matches(
            "MacBook Pro Microphone",
            "MacBook Pro"
        ));
    }

    #[test]
    fn an_empty_preference_is_not_a_name() {
        assert!(!input_device_matches("MacBook Pro Microphone", ""));
    }

    #[test]
    fn a_different_device_does_not_match() {
        assert!(!input_device_matches(
            "MacBook Pro Microphone",
            "Vipin's AirPods Pro"
        ));
    }

    #[test]
    fn recognises_the_built_in_mic() {
        assert!(is_built_in_input("MacBook Pro Microphone"));
        assert!(is_built_in_input("Built-in Microphone"));
        assert!(!is_built_in_input("Vipin's AirPods Pro"));
        assert!(!is_built_in_input("AT2020USB+"));
    }
}
