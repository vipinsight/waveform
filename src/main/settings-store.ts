import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type AppSettings,
} from "../shared/settings";

/**
 * Settings live in a single JSON file in userData. Reads are synchronous and
 * happen once at launch; writes are debounced so dragging a slider does not
 * hammer the disk.
 */
export class SettingsStore {
  private current: AppSettings;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly filePath: string;

  constructor(userDataPath: string) {
    this.filePath = join(userDataPath, "settings.json");
    this.current = this.read();
  }

  get value(): AppSettings {
    return this.current;
  }

  update(patch: unknown): AppSettings {
    this.current = normalizeSettings(patch, this.current);
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

  private read(): AppSettings {
    try {
      return normalizeSettings(JSON.parse(readFileSync(this.filePath, "utf8")));
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.write();
    }, 250);
  }

  private write(): void {
    try {
      writeFileSync(this.filePath, `${JSON.stringify(this.current, null, 2)}\n`, "utf8");
    } catch {
      // A read-only container is not worth crashing over; settings stay in memory.
    }
  }
}
