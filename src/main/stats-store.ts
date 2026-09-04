import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppStats } from "../shared/contracts";

const EMPTY: AppStats = { words: 0, phrases: 0, sessions: 0 };

/**
 * Lifetime dictation counters, kept next to the settings file.
 *
 * Only aggregate counts are stored -- never transcribed text -- so the Activity
 * view can say something true without the app keeping a record of what was said.
 */
export class StatsStore {
  private current: AppStats;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly filePath: string;

  constructor(userDataPath: string) {
    this.filePath = join(userDataPath, "stats.json");
    this.current = this.read();
  }

  get value(): AppStats {
    return this.current;
  }

  recordSession(): AppStats {
    this.current = { ...this.current, sessions: this.current.sessions + 1 };
    this.scheduleWrite();
    return this.current;
  }

  recordPhrase(text: string): AppStats {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    this.current = {
      ...this.current,
      words: this.current.words + words,
      phrases: this.current.phrases + 1,
    };
    this.scheduleWrite();
    return this.current;
  }

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.write();
  }

  private read(): AppStats {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<AppStats>;
      return {
        words: count(parsed.words),
        phrases: count(parsed.phrases),
        sessions: count(parsed.sessions),
      };
    } catch {
      return EMPTY;
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.write();
    }, 500);
  }

  private write(): void {
    try {
      writeFileSync(this.filePath, `${JSON.stringify(this.current)}\n`, "utf8");
    } catch {
      // Counters are not worth crashing over; they stay in memory.
    }
  }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}
