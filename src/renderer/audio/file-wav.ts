import { encodeMonoPcm16Wav } from "./wav";

/**
 * Turns a dropped audio file into the mono PCM16 WAV the speech engine takes.
 *
 * WebKit decodes the container; this mixes to one channel and re-encodes at
 * the file's own rate. Whisper resamples from there.
 */
export async function audioFileToMonoWav(file: File): Promise<Uint8Array> {
  const raw = await file.arrayBuffer();
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(raw.slice(0));
    const mono = mixToMono(decoded);
    return encodeMonoPcm16Wav(mono, Math.round(decoded.sampleRate));
  } catch {
    throw new Error(
      "Could not read that audio file. Try a WAV, MP3, M4A, or CAF recording.",
    );
  } finally {
    await context.close();
  }
}

/** Averages every channel into one, which is what a mono speech model expects. */
export function mixToMono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  if (channels <= 1) {
    return buffer.getChannelData(0).slice();
  }
  const mixed = new Float32Array(length);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      mixed[index] = (mixed[index] ?? 0) + (data[index] ?? 0) / channels;
    }
  }
  return mixed;
}

/** Extensions and MIME types the drop zone will accept. */
export const TRANSCRIBE_ACCEPT =
  "audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac,.caf,.aiff,.aif,.webm";

export function isAudioFile(file: File): boolean {
  if (file.type.startsWith("audio/")) return true;
  return /\.(wav|mp3|m4a|aac|ogg|flac|caf|aiff?|webm)$/i.test(file.name);
}
