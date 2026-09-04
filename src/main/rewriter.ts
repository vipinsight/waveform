import { rewriteText } from "../shared/openrouter";
import type { SecretStore } from "./secret-store";
import type { SettingsStore } from "./settings-store";

/**
 * Runs text through OpenRouter using whichever prompt the caller asks for.
 *
 * Holds the only reference to the API key in this layer; callers pass text and
 * get text back, so the credential never travels further than it must.
 */
export class Rewriter {
  constructor(
    private readonly settings: SettingsStore,
    private readonly secrets: SecretStore,
  ) {}

  get isConfigured(): boolean {
    return this.secrets.hasApiKey;
  }

  /** Cleans up a dictated phrase. Returns null when the feature is off. */
  async cleanUpDictation(text: string): Promise<string | null> {
    const { transformOnDictate, transformPrompt } = this.settings.value;
    if (!transformOnDictate || !this.secrets.hasApiKey) return null;
    return this.run(transformPrompt, text);
  }

  /** Rewrites arbitrary text with the polish prompt. */
  async polish(text: string): Promise<string> {
    return this.run(this.settings.value.polishPrompt, text);
  }

  private async run(systemPrompt: string, text: string): Promise<string> {
    const apiKey = this.secrets.apiKey;
    if (!apiKey) throw new Error("Add an OpenRouter API key in Settings first.");

    const result = await rewriteText({
      apiKey,
      model: this.settings.value.openRouterModel,
      systemPrompt,
      text,
    });

    // An empty rewrite would silently wipe the user's text; keep the original.
    return result.trim() || text;
  }
}
