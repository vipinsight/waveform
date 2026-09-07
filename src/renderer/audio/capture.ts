import { SpeechSegmenter } from "./segmenter";
import { encodeMonoPcm16Wav } from "./wav";

export interface CaptureHandlers {
  /** A finished phrase, already transcribed. */
  onPhrase(text: string): void;
  /** Fired when transcription work starts and finishes, to drive the HUD state. */
  onPendingChange(pending: number): void;
  onError(message: string): void;
  transcribe(wavBytes: Uint8Array): Promise<{ text: string }>;
  requestMicrophoneAccess(): Promise<{ granted: boolean; status: string }>;
  getMicrophoneDeviceId(): string;
}

/**
 * Owns the microphone for one dictation session: opens the stream, splits it at
 * natural pauses, and hands each phrase off to be transcribed.
 *
 * Phrases are emitted as they complete rather than at the end of the session,
 * so dictating into another app feels continuous instead of arriving in a lump.
 */
export class AudioCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private analyser: AnalyserNode | null = null;
  private segmenter: SpeechSegmenter | null = null;
  /** Reused across sessions: building an AudioContext is a large part of the
      delay between pressing the key and the meter moving. */
  private sharedContext: AudioContext | null = null;
  private spectrum: Uint8Array<ArrayBuffer> | null = null;
  private pending = 0;
  private discarding = false;

  constructor(private readonly handlers: CaptureHandlers) {}

  get isRunning(): boolean {
    return this.context !== null;
  }

  get pendingCount(): number {
    return this.pending;
  }

  async start(): Promise<void> {
    if (this.context) return;
    this.discarding = false;

    const permission = await this.handlers.requestMicrophoneAccess();
    if (!permission.granted) throw new Error(microphoneMessage(permission.status));

    const deviceId = this.handlers.getMicrophoneDeviceId();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // These three are one decision, not three. WebKit provides all of
        // them from the same voice-processing audio unit, and it only reaches
        // for that unit when echoCancellation is asked for -- so turning that
        // one off takes gain control and noise suppression with it, and
        // dictation stopped producing anything at all. It was tried, in the
        // hope of stopping macOS ducking other apps' output while the
        // microphone is open, and reverted the same day.
        //
        // The ducking is real and still unsolved. See
        // docs/plans/microphone-ducking.md before trying this again.
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });

    const context = this.sharedContext ?? new AudioContext();
    this.sharedContext = context;
    if (context.state === "suspended") await context.resume();
    this.context = context;
    this.segmenter = new SpeechSegmenter({ sampleRate: context.sampleRate });
    this.source = context.createMediaStreamSource(this.stream);
    this.analyser = context.createAnalyser();
    // Small FFT with light built-in smoothing: the meter does its own easing,
    // and anything heavier here reads as lag between voice and bars.
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.25;
    this.spectrum = new Uint8Array(this.analyser.frequencyBinCount);
    this.processor = context.createScriptProcessor(2048, 1, 1);
    this.processor.onaudioprocess = (event) => this.handleAudio(event);

    this.source.connect(this.analyser);
    this.source.connect(this.processor);
    // A ScriptProcessorNode only pulls audio while connected to a sink. Routing
    // it through a muted gain node keeps it running without echoing the mic to
    // the speakers.
    const mute = context.createGain();
    mute.gain.value = 0;
    this.processor.connect(mute);
    mute.connect(context.destination);
  }

  /** Ends the session, transcribing whatever is still buffered. */
  stop(): void {
    const tail = this.segmenter?.flush();
    const sampleRate = this.context?.sampleRate;
    this.release();
    if (tail && sampleRate) this.queue(tail, sampleRate);
  }

  /** Ends the session and throws away the audio, including anything in flight. */
  cancel(): void {
    this.discarding = true;
    this.release();
  }

  /** Reads the analyser for a smooth level, independent of the segmenter. */
  sampleLevel(): number {
    const analyser = this.analyser;
    if (!analyser) return 0;
    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    return Math.sqrt(sum / samples.length);
  }

  /**
   * Current frequency magnitudes, 0..1 per bin.
   *
   * Driving each bar from its own band is what makes the meter look like it is
   * listening; one RMS value moving every bar together reads as a loading
   * spinner, not a voice.
   */
  sampleSpectrum(): Uint8Array<ArrayBuffer> | null {
    const analyser = this.analyser;
    const spectrum = this.spectrum;
    if (!analyser || !spectrum) return null;
    analyser.getByteFrequencyData(spectrum);
    return spectrum;
  }

  private release(): void {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    // The context is kept alive and reused; only the microphone is released,
    // so the macOS recording indicator still clears between sessions.

    this.processor = null;
    this.source = null;
    this.analyser = null;
    this.spectrum = null;
    this.stream = null;
    this.context = null;
    this.segmenter = null;
  }

  private handleAudio(event: AudioProcessingEvent): void {
    const samples = new Float32Array(event.inputBuffer.getChannelData(0));
    const segment = this.segmenter?.push(samples);
    if (segment && this.context) this.queue(segment, this.context.sampleRate);
  }

  private queue(samples: Float32Array, sampleRate: number): void {
    if (this.discarding) return;
    this.pending += 1;
    this.handlers.onPendingChange(this.pending);

    void this.handlers
      .transcribe(encodeMonoPcm16Wav(samples, sampleRate))
      .then(({ text }) => {
        if (this.discarding || !text) return;
        this.handlers.onPhrase(text);
      })
      .catch((error: unknown) => {
        if (this.discarding) return;
        this.handlers.onError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        this.pending -= 1;
        this.handlers.onPendingChange(this.pending);
      });
  }
}

function microphoneMessage(status: string): string {
  if (status === "denied") {
    return "Microphone denied. Enable Waveform in System Settings → Privacy & Security → Microphone.";
  }
  if (status === "restricted") return "Microphone blocked by macOS restrictions.";
  return `Microphone unavailable (${status}).`;
}
