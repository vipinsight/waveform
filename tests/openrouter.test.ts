import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterError, rewriteText } from "../src/shared/openrouter";

const BASE = { apiKey: "sk-test", model: "test/model", systemPrompt: "Rewrite." };

/** Stubs fetch with one canned HTTP response. */
function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
    ),
  );
}

function reply(content: string): unknown {
  return { choices: [{ message: { content } }] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rewriteText", () => {
  it("returns the model's text", async () => {
    stubFetch(200, reply("Cleaned up sentence."));
    await expect(rewriteText({ ...BASE, text: "cleaned up sentence" })).resolves.toBe(
      "Cleaned up sentence.",
    );
  });

  it("sends the system prompt and text as separate messages", async () => {
    stubFetch(200, reply("ok"));
    await rewriteText({ ...BASE, text: "hello" });

    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(String((call?.[1] as RequestInit).body));
    expect(body.messages).toEqual([
      { role: "system", content: "Rewrite." },
      { role: "user", content: "hello" },
    ]);
    expect(body.model).toBe("test/model");
  });

  it("authorises with the key as a bearer token", async () => {
    stubFetch(200, reply("ok"));
    await rewriteText({ ...BASE, text: "hello" });

    const headers = (vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit).headers;
    expect((headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });

  // Models wrap rewrites despite being told not to; pasting the wrapper into
  // the user's document would be worse than the original text.
  it("strips a wrapping code fence", async () => {
    stubFetch(200, reply("```\nJust the text.\n```"));
    await expect(rewriteText({ ...BASE, text: "x" })).resolves.toBe("Just the text.");
  });

  it("strips surrounding quotes", async () => {
    stubFetch(200, reply('"Just the text."'));
    await expect(rewriteText({ ...BASE, text: "x" })).resolves.toBe("Just the text.");
  });

  it("keeps quotes that are part of the sentence", async () => {
    stubFetch(200, reply('He said "hello" to me.'));
    await expect(rewriteText({ ...BASE, text: "x" })).resolves.toBe(
      'He said "hello" to me.',
    );
  });

  it("skips the request entirely for blank input", async () => {
    stubFetch(200, reply("should not be called"));
    await expect(rewriteText({ ...BASE, text: "   " })).resolves.toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses to call out without a key", async () => {
    stubFetch(200, reply("nope"));
    await expect(rewriteText({ ...BASE, apiKey: "", text: "hi" })).rejects.toThrow(
      OpenRouterError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("explains a rejected key", async () => {
    stubFetch(401, { error: { message: "No auth credentials found" } });
    await expect(rewriteText({ ...BASE, text: "hi" })).rejects.toThrow(
      "OpenRouter rejected the API key.",
    );
  });

  it("surfaces the server's message for a bad model", async () => {
    stubFetch(404, { error: { message: "No endpoints found for foo/bar" } });
    await expect(rewriteText({ ...BASE, text: "hi" })).rejects.toThrow(
      "No endpoints found for foo/bar",
    );
  });

  it("explains rate limiting", async () => {
    stubFetch(429, { error: { message: "slow down" } });
    await expect(rewriteText({ ...BASE, text: "hi" })).rejects.toThrow("rate limit");
  });

  it("reports a non-JSON body rather than pasting it", async () => {
    stubFetch(200, "<html>gateway error</html>");
    await expect(rewriteText({ ...BASE, text: "hi" })).rejects.toThrow("not JSON");
  });

  it("treats an empty completion as a failure", async () => {
    stubFetch(200, reply("   "));
    await expect(rewriteText({ ...BASE, text: "hi" })).rejects.toThrow(
      "returned no text",
    );
  });

  it("reports an error payload that carries no choices", async () => {
    stubFetch(200, { error: { message: "context length exceeded" } });
    await expect(rewriteText({ ...BASE, text: "hi" })).rejects.toThrow(
      "context length exceeded",
    );
  });
});
