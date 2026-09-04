/**
 * Minimal OpenRouter chat client.
 *
 * Deliberately dependency-free and free of any Electron or Node imports, so it
 * can be reused unchanged from a different host process.
 */
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 30_000;

export interface RewriteRequest {
  apiKey: string;
  model: string;
  systemPrompt: string;
  text: string;
  signal?: AbortSignal;
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

/** Sends text through a model and returns only the rewritten text. */
export async function rewriteText(request: RewriteRequest): Promise<string> {
  const { apiKey, model, systemPrompt, text } = request;
  if (!apiKey) throw new OpenRouterError("No OpenRouter API key saved.");
  if (!text.trim()) return "";

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // OpenRouter uses these for attribution on its dashboard.
      "HTTP-Referer": "https://github.com/vipiny35/local-speech",
      "X-Title": "Waveform",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      // Rewrites should be faithful, not creative.
      temperature: 0.2,
    }),
    signal: request.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new OpenRouterError(describeFailure(response.status, body), response.status);
  }

  return extractMessage(body);
}

function extractMessage(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new OpenRouterError("OpenRouter returned a response that was not JSON.");
  }

  const choice = (parsed as { choices?: unknown }).choices;
  const first = Array.isArray(choice) ? choice[0] : undefined;
  const content = (first as { message?: { content?: unknown } } | undefined)?.message
    ?.content;

  if (typeof content !== "string" || !content.trim()) {
    const error = (parsed as { error?: { message?: unknown } }).error?.message;
    throw new OpenRouterError(
      typeof error === "string" ? error : "OpenRouter returned no text.",
    );
  }

  // Models sometimes wrap a rewrite in quotes or a code fence despite being
  // told not to; strip that rather than pasting it into the user's document.
  return unwrap(content.trim());
}

function unwrap(text: string): string {
  const fenced = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(text);
  const inner = fenced?.[1]?.trim() ?? text;
  const quoted = /^"([\s\S]*)"$/.exec(inner);
  return (quoted?.[1] ?? inner).trim();
}

function describeFailure(status: number, body: string): string {
  const detail = readErrorMessage(body);
  if (status === 401) return "OpenRouter rejected the API key.";
  if (status === 402) return detail ?? "OpenRouter account has no credit left.";
  if (status === 404) return detail ?? "That OpenRouter model was not found.";
  if (status === 429) return "OpenRouter rate limit reached. Try again shortly.";
  return detail ?? `OpenRouter request failed (${status}).`;
}

function readErrorMessage(body: string): string | null {
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
    return typeof message === "string" ? message : null;
  } catch {
    return null;
  }
}
