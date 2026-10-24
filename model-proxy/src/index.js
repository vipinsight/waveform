// Pass-through proxy for the Hugging Face repos Waveform installs from, for
// networks that block huggingface.co. Stores nothing: every response streams
// from Hugging Face. Redirects to HF's file CDN are rewritten to come back
// through here, since those hosts are usually blocked too.
//
// CDN redirects point at a second hostname (env.CDN_ORIGIN) on purpose:
// huggingface_hub follows same-host redirects when reading a file's metadata,
// and the metadata (X-Repo-Commit, X-Linked-Etag) is only on the 302 itself.

const HUB = "https://huggingface.co";

const REPOS = [
  "ggerganov/whisper.cpp",
  "unsloth/Qwen3-0.6B-GGUF",
  "Qwen/Qwen3-0.6B-GGUF",
  "unsloth/Qwen3-1.7B-GGUF",
  "nvidia/parakeet-tdt-0.6b-v3",
  "Qwen/Qwen3-ASR-0.6B",
];

// CDN redirects become /cdn/<host>/<path>.
const CDN_PREFIX = "/cdn/";
const CDN_HOST = /^([a-z0-9-]+\.)*(hf\.co|huggingface\.co)$/;

const FORWARDED_HEADERS = ["range", "if-none-match", "if-range", "user-agent", "accept"];

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    const url = new URL(request.url);
    const target = upstreamUrl(url);
    if (!target) return new Response("not found", { status: 404 });

    const headers = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const upstream = await fetch(target, { method: request.method, headers, redirect: "manual" });

    const responseHeaders = new Headers(upstream.headers);
    // The runtime has already decoded the body; let it re-encode for the client.
    if (responseHeaders.has("content-encoding")) {
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
    }
    const location = upstream.headers.get("location");
    if (location) {
      const rewritten = rewriteLocation(new URL(location, target), url.origin, env.CDN_ORIGIN);
      if (!rewritten) return new Response("redirect outside Hugging Face", { status: 502 });
      responseHeaders.set("location", rewritten);
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  },
};

function upstreamUrl(url) {
  if (url.pathname.startsWith(CDN_PREFIX)) {
    const rest = url.pathname.slice(CDN_PREFIX.length);
    const slash = rest.indexOf("/");
    const host = slash === -1 ? rest : rest.slice(0, slash);
    if (!CDN_HOST.test(host)) return null;
    return `https://${host}${slash === -1 ? "/" : rest.slice(slash)}${url.search}`;
  }
  const repoPath = url.pathname.replace(/^\/api\/(resolve-cache\/)?models\//, "/");
  if (!REPOS.some((repo) => repoPath.startsWith(`/${repo}/`) || repoPath === `/${repo}`)) return null;
  return `${HUB}${url.pathname}${url.search}`;
}

function rewriteLocation(location, origin, cdnOrigin) {
  if (location.origin === HUB) return `${origin}${location.pathname}${location.search}`;
  if (location.protocol === "https:" && CDN_HOST.test(location.hostname)) {
    return `${cdnOrigin}${CDN_PREFIX}${location.hostname}${location.pathname}${location.search}`;
  }
  return null;
}
