import type { MeetingLine } from "../shared/contracts";

/**
 * The pieces of the meeting panel that are decisions rather than DOM: which
 * lines it keeps, whose they are, and when it follows new ones.
 */

/** Lines the panel keeps; the whole transcript is one click away in Waveform. */
export const MAX_LINES = 200;

/** How close to the bottom still counts as reading the latest line. */
const FOLLOW_SLACK_PX = 24;

/**
 * The lines so far plus new ones, in order, each once, and only the latest
 * `MAX_LINES`. The backlog fetched on open and the live events overlap, so a
 * line can arrive twice.
 */
export function mergeLines(current: MeetingLine[], incoming: MeetingLine[]): MeetingLine[] {
  const byIdx = new Map<number, MeetingLine>();
  for (const line of current) byIdx.set(line.idx, line);
  for (const line of incoming) byIdx.set(line.idx, line);
  return Array.from(byIdx.values())
    .sort((a, b) => a.idx - b.idx)
    .slice(-MAX_LINES);
}

/**
 * Who said a line. While recording, the other side is not told apart yet, so
 * an untagged line from the call is simply "Them".
 */
export function speakerName(line: MeetingLine, speakers: Record<string, string>, localName: string | null): string {
  const label = line.speaker;
  if (!label) return line.track === "system" ? "Them" : (localName ?? "You");
  const named = speakers[label];
  if (named) return named;
  if (label === "me") return localName ?? "You";
  const match = /^speaker_(\d+)$/.exec(label);
  return match ? `Speaker ${Number(match[1]) + 1}` : label;
}

/** Which voice a line belongs to, so consecutive lines from it can group. */
export function voiceOf(line: MeetingLine): string {
  return line.speaker ?? line.track;
}

/** Whether the reader is at the newest line, so new lines should follow. */
export function isFollowing(scrollTop: number, clientHeight: number, scrollHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= FOLLOW_SLACK_PX;
}

/** `mm:ss`, or `h:mm:ss` past the hour. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const h = Math.floor(seconds / 3_600);
  const m = String(Math.floor((seconds % 3_600) / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}
