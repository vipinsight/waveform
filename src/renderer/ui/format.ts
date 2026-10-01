/**
 * Numbers and times as the interface writes them. One place, so a size on
 * the Models page and the same size on the Meetings page cannot disagree.
 */

/**
 * A download's size, in the unit someone would say it in.
 *
 * Whisper Medium is "1.5 GB", not "1534 MB": past a thousand the megabytes
 * stop being a size and start being a number to read.
 */
export function formatBytes(bytes: number): string {
  const megabytes = bytes / 1_000_000;
  return megabytes >= 1_000
    ? `${(megabytes / 1_000).toFixed(1)} GB`
    : `${Math.round(megabytes)} MB`;
}

export function formatMemory(megabytes: number): string {
  return megabytes >= 1024 ? `${(megabytes / 1024).toFixed(1)} GB` : `${megabytes} MB`;
}

/** The day carries the date, so each row only needs its clock time. */
export function formatTime(timestamp: number): string {
  return new Date(timestamp)
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .toLowerCase();
}

export function formatDay(timestamp: number): string {
  const when = new Date(timestamp);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const days = Math.floor((midnight.getTime() - when.getTime()) / 86_400_000) + 1;

  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return when.toLocaleDateString([], { weekday: "long" });
  if (when.getFullYear() === new Date().getFullYear()) {
    return when.toLocaleDateString([], { day: "numeric", month: "long" });
  }
  return when.toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });
}

/** Named the way macOS names a screenshot, so a folder of them sorts by time. */
export function audioFileName(createdAt: number): string {
  const date = new Date(createdAt);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `Waveform ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `at ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`
  );
}

/** An elapsed time as a running clock reads it: `mm:ss`, or `h:mm:ss` past an hour. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const h = Math.floor(seconds / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** A length as a sentence would say it: "45 s", "12 min", "1 h 5 min". */
export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.round(ms / 1_000)} s`;
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Renders an Electron accelerator the way macOS writes it. */
export function describeAccelerator(accelerator: string): string {
  if (accelerator === "none") return "Off";
  return accelerator.replace("Alt+", "⌥ + ");
}

/** The same accelerator in words, for under the glyph and for VoiceOver. */
export function nameAccelerator(accelerator: string): string {
  if (accelerator === "none") return "Off";
  return accelerator.replace("Alt+", "Option + ");
}

/** The first line or so of a prompt, for a card that only previews it. */
export function promptPreview(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 140) return compact;
  return `${compact.slice(0, 139).trimEnd()}…`;
}
