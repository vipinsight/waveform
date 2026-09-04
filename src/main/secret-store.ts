import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeStorage } from "electron";

/**
 * Stores the OpenRouter API key encrypted at rest.
 *
 * The key is a bearer credential, so it never goes in settings.json and is
 * never handed back to a renderer -- the UI only ever learns whether one is
 * saved. On macOS safeStorage is backed by the login Keychain; if encryption
 * is unavailable the key is held in memory for the session rather than written
 * out in the clear.
 */
export class SecretStore {
  private readonly filePath: string;
  private cached: string | null = null;
  private memoryOnly = false;

  constructor(userDataPath: string) {
    this.filePath = join(userDataPath, "secrets.json");
    this.cached = this.read();
  }

  get hasApiKey(): boolean {
    return this.cached !== null && this.cached.length > 0;
  }

  get apiKey(): string | null {
    return this.cached;
  }

  /** Returns whether the key could be persisted; false means session-only. */
  setApiKey(key: string): boolean {
    const trimmed = key.trim();
    this.cached = trimmed.length > 0 ? trimmed : null;

    if (this.cached === null) {
      this.write(null);
      return true;
    }
    if (!safeStorage.isEncryptionAvailable()) {
      this.memoryOnly = true;
      return false;
    }
    this.write(safeStorage.encryptString(this.cached).toString("base64"));
    return true;
  }

  clear(): void {
    this.cached = null;
    this.write(null);
  }

  get isMemoryOnly(): boolean {
    return this.memoryOnly;
  }

  private read(): string | null {
    try {
      const stored = (
        JSON.parse(readFileSync(this.filePath, "utf8")) as { openRouterApiKey?: unknown }
      ).openRouterApiKey;
      if (typeof stored !== "string" || !stored) return null;
      if (!safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(Buffer.from(stored, "base64")) || null;
    } catch {
      // Missing file, or a key encrypted under a keychain we can no longer
      // open. Either way there is no usable key.
      return null;
    }
  }

  private write(ciphertext: string | null): void {
    try {
      writeFileSync(
        this.filePath,
        `${JSON.stringify({ openRouterApiKey: ciphertext ?? "" })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      // Nothing safe to fall back to; the key stays in memory for this session.
    }
  }
}
