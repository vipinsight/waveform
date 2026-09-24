import { InputGain } from "./gain";
import { SpeechSegmenter, rootMeanSquare } from "./segmenter";
import { SPECTRUM_WINDOW, spectrumFromBlock } from "./spectrum";
import { encodeMonoPcm16Wav } from "./wav";

/**
 * Whether an already-open microphone can serve this session.
 *
 * The stream is released when dictation ends. This only avoids a second
 * getUserMedia if a new session starts before that release has finished.
 */
export function canReuseMicrophoneStream(
  stream: MediaStream | null,
  openedDeviceId: string,
  requestedDeviceId: string,
): stream is MediaStream {
  if (!stream || openedDeviceId !== requestedDeviceId) return false;
  return stream.getAudioTracks().some((track) => track.readyState === "live");
}

/**
 * A plain input, kept for tests and any leftover WebKit path.
 *
 * Dictation itself no longer uses getUserMedia: that plus an AudioContext is
 * what pulls AirPods into the same aggregate as the built-in mic and makes
 * Music hitch.
 */
export function microphoneConstraints(deviceId: string): MediaTrackConstraints {
  return {
    autoGainControl: false,
    echoCancellation: false,
    noiseSuppression: false,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

export interface CaptureHandlers {
  /** A finished phrase, already transcribed. */
  onPhrase(text: string): void;
  /** Fired when transcription work starts and finishes, to drive the HUD state. */
  onPendingChange(pending: number): void;
  onError(message: string): void;
  /** Writes into the app's log. Nowhere else knows these numbers. */
  log(message: string): void;
  transcribe(wavBytes: Uint8Array): Promise<{ text: string }>;
  startNativeCapture(): Promise<string>;
  stopNativeCapture(): Promise<void>;
}

/**
 * Owns one dictation session: opens the native input, splits it at natural
 * pauses, and hands each phrase off to be transcribed.
 *
 * The microphone is a HAL input in the host, not a WebKit stream, so Music
 * playing through headphones is not on the same device graph.
 */
export class AudioCapture {
  private running = false;
  private sampleRate = 48_000;
  private spectrum: Uint8Array<ArrayBuffer> | null = null;
  /** DFT window the current spectrum was taken from, so the meter can map Hz. */
  private spectrumWindow = SPECTRUM_WINDOW;
  private segmenter: SpeechSegmenter | null = null;
  private pending = 0;
  private discarding = false;
  /**
   * What this session heard, so a session that produced nothing can say why.
   *
   * Silence and a stream that never arrived look identical from the outside --
   * the meter runs off the spectrum, so the pill animates either way.
   */
  private blocks = 0;
  private peak = 0;
  private phrases = 0;
  private inserted = 0;
  private empty = 0;
  /** The last phrase sent, for a session that comes back with no words. */
  private lastSeconds = 0;
  private lastPeak = 0;
  /**
   * WAV clips queued this session, kept so a failed transcription can Retry
   * without speaking again. Replaced when a new listen starts.
   */
  private lastClips: Uint8Array[] = [];
  /** Per session, so a shout in one does not starve the next. */
  private gain = new InputGain();
  /** In-flight open, so a second start cannot stop the first stream. */
  private opening: Promise<void> | null = null;
  /** Bumped on every release so a late start cannot keep the microphone. */
  private epoch = 0;

  constructor(private readonly handlers: CaptureHandlers) {}

  get isRunning(): boolean {
    return this.running;
  }

  get pendingCount(): number {
    return this.pending;
  }

  /** True when this session queued audio that Retry can send again. */
  get hasRetryableClips(): boolean {
    return this.lastClips.length > 0;
  }

  /** Phrase WAVs from this session, for persisting a failed dictation. */
  clips(): Uint8Array[] {
    return this.lastClips.map((clip) => new Uint8Array(clip));
  }

  /** Drops held clips after Dismiss or a successful Retry. */
  clearRetryClips(): void {
    this.lastClips = [];
  }

  /** Nothing to warm: native capture does not build an AudioContext. */
  prepare(): void {}

  async start(): Promise<void> {
    if (this.opening) {
      await this.opening;
      return;
    }
    if (this.running) return;
    this.opening = this.openSession();
    try {
      await this.opening;
    } finally {
      this.opening = null;
    }
  }

  /** PCM from the host, already mono. */
  feed(samples: Float32Array, sampleRate: number): void {
    if (!this.running) return;
    if (sampleRate !== this.sampleRate || !this.segmenter) {
      this.sampleRate = sampleRate;
      this.segmenter = new SpeechSegmenter({ sampleRate });
    }
    this.spectrum = spectrumFromBlock(samples);
    this.spectrumWindow = Math.min(samples.length, SPECTRUM_WINDOW);
    this.handleBlock(samples);
  }

  private async openSession(): Promise<void> {
    this.discarding = false;
    this.blocks = 0;
    this.peak = 0;
    this.phrases = 0;
    this.inserted = 0;
    this.empty = 0;
    this.lastClips = [];
    this.gain = new InputGain();
    this.sampleRate = 48_000;
    this.segmenter = new SpeechSegmenter({ sampleRate: this.sampleRate });
    this.spectrum = new Uint8Array(128);
    this.spectrumWindow = SPECTRUM_WINDOW;

    const opened = performance.now();
    const epoch = this.epoch;
    try {
      const device = await this.handlers.startNativeCapture();
      if (epoch !== this.epoch) {
        await this.handlers.stopNativeCapture();
        return;
      }
      this.running = true;
      this.handlers.log(
        `session open in ${Math.round(performance.now() - opened)}ms, ${device}, reader native`,
      );
    } catch (error) {
      this.release();
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  /** Ends the session, transcribing whatever is still buffered. */
  stop(): void {
    if (!this.running && !this.opening) return;
    if (!this.running && this.opening) {
      this.release();
      return;
    }
    const tail = this.segmenter?.flush();
    const sampleRate = this.sampleRate;
    const { blocks, peak, phrases } = this;
    const threshold = this.segmenter?.threshold() ?? 0;
    this.release();
    if (tail && sampleRate) this.queue(tail, sampleRate);
    this.handlers.log(
      `session closed: ${blocks} blocks, peak ${peak.toFixed(4)}, ` +
        `threshold ${threshold.toFixed(4)}, gain ${this.gain.factor().toFixed(1)}x, ` +
        `${phrases} phrase(s)`,
    );
    if (phrases === 0 && !tail) {
      this.handlers.onError(
        blocks === 0
          ? "Heard nothing: no audio arrived from the microphone."
          : `Heard nothing above the speech threshold: ${blocks} blocks, peak ${peak.toFixed(4)} against ${threshold.toFixed(4)}.`,
      );
    }
  }

  /** Ends the session and throws away the audio, including anything in flight. */
  cancel(): void {
    this.discarding = true;
    this.lastClips = [];
    this.release();
  }

  /**
   * Re-transcribes held clips without opening the microphone.
   *
   * Empty-room failures leave no clips, so there is nothing to Retry.
   */
  async retryLast(): Promise<{ texts: string[]; error?: string }> {
    if (this.lastClips.length === 0) {
      return { texts: [], error: "Nothing to retry." };
    }
    return this.transcribeClips(this.lastClips);
  }

  /** Re-transcribes a single WAV loaded from a failed history row. */
  async retryFromWav(wav: Uint8Array): Promise<{ texts: string[]; error?: string }> {
    this.lastClips = [new Uint8Array(wav)];
    return this.transcribeClips(this.lastClips);
  }

  private async transcribeClips(
    clips: Uint8Array[],
  ): Promise<{ texts: string[]; error?: string }> {
    this.discarding = false;
    this.pending += clips.length;
    this.handlers.onPendingChange(this.pending);
    const texts: string[] = [];
    let error: string | undefined;
    try {
      for (const wav of clips) {
        try {
          const { text } = await this.handlers.transcribe(wav);
          if (text) texts.push(text);
        } catch (caught: unknown) {
          error = caught instanceof Error ? caught.message : String(caught);
          break;
        }
      }
      if (!error && texts.length === 0) {
        error = `No words in ${clips.length === 1 ? "the phrase" : `${clips.length} phrases`}.`;
      }
      if (!error) {
        for (const text of texts) this.handlers.onPhrase(text);
      }
    } finally {
      this.pending -= clips.length;
      this.handlers.onPendingChange(this.pending);
    }
    return error ? { texts, error } : { texts };
  }

  /**
   * Current frequency magnitudes, and the rate they were taken at.
   *
   * Driving each bar from its own speech band is what makes the meter look
   * like it is listening; one RMS value moving every bar together reads as a
   * loading spinner, not a voice. The sample rate travels with the bins
   * because speech occupies a different slice of the DFT at 16 kHz than at
   * 48 kHz, and mapping bars without it leaves the outer ones still.
   */
  sampleSpectrum(): {
    bins: Uint8Array<ArrayBuffer>;
    sampleRate: number;
    window: number;
  } | null {
    if (!this.running || !this.spectrum) return null;
    return {
      bins: this.spectrum,
      sampleRate: this.sampleRate,
      window: this.spectrumWindow,
    };
  }

  private release(): void {
    this.epoch += 1;
    this.running = false;
    this.segmenter = null;
    this.spectrum = null;
    void this.handlers.stopNativeCapture();
  }

  private handleBlock(samples: Float32Array): void {
    const boosted = this.gain.apply(samples);
    this.blocks += 1;
    this.peak = Math.max(this.peak, rootMeanSquare(boosted));
    const segment = this.segmenter?.push(boosted);
    if (segment) this.queue(segment, this.sampleRate);
  }

  private queue(samples: Float32Array, sampleRate: number): void {
    if (this.discarding) return;
    this.phrases += 1;
    this.pending += 1;
    this.lastSeconds = samples.length / sampleRate;
    this.lastPeak = rootMeanSquare(samples);
    const wav = encodeMonoPcm16Wav(samples, sampleRate);
    this.lastClips.push(wav);
    this.handlers.log(
      `phrase ${this.lastSeconds.toFixed(1)}s at level ${this.lastPeak.toFixed(4)}`,
    );
    this.handlers.onPendingChange(this.pending);

    void this.handlers
      .transcribe(wav)
      .then(({ text }) => {
        if (this.discarding) return;
        if (!text) {
          // The engine heard the audio and found no words in it. whisper.cpp
          // says so as the literal text "[BLANK_AUDIO]", which is filtered
          // out on the way back rather than typed into whatever the cursor
          // was in -- so an empty reply is the normal shape of that answer.
          this.empty += 1;
          return;
        }
        this.inserted += 1;
        this.handlers.onPhrase(text);
      })
      .catch((error: unknown) => {
        if (this.discarding) return;
        this.handlers.onError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        this.pending -= 1;
        this.handlers.onPendingChange(this.pending);
        // Every phrase is back and none of them had words in it. Silence in a
        // recording that measured well above the speech threshold is worth
        // saying, with the numbers: it is the difference between a quiet room
        // and audio arriving mangled.
        if (this.pending === 0 && this.inserted === 0 && this.empty > 0) {
          const empty = this.empty;
          this.empty = 0;
          this.handlers.onError(
            `No words in ${empty === 1 ? "the phrase" : `${empty} phrases`}: ` +
              `${this.lastSeconds.toFixed(1)}s at level ${this.lastPeak.toFixed(4)}.`,
          );
        }
      });
  }
}
