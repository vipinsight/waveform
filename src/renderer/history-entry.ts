import type { SavedDictation } from "../shared/contracts";

/** Failed rows are first-class history entries with optional local audio. */
export function isFailedDictation(entry: SavedDictation): boolean {
  return entry.status === "failed";
}

export type DictationEntryAction = "copy" | "play" | "retry" | "delete";

/** Actions shown beside a Transcripts row. */
export function actionsForDictation(entry: SavedDictation): DictationEntryAction[] {
  if (isFailedDictation(entry)) return ["play", "retry", "delete"];
  return ["copy", "delete"];
}

/** Primary label for a history row; failed rows do not use empty text. */
export function dictationEntryTitle(entry: SavedDictation): string {
  if (isFailedDictation(entry)) return "Transcribe failed";
  return entry.text;
}
