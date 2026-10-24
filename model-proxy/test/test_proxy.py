"""End-to-end test for the model proxy, run as if Hugging Face were blocked.

Every check runs with huggingface.co and its CDN hosts made unresolvable in
this process, the way a filtered corporate network sees them, so a pass means
the download never needed Hugging Face directly.

The files and repositories under test are read from the app's own Rust
sources, so a model added to the app is tested (and caught if the Worker's
allowlist misses it) without editing this file.

    python test_proxy.py https://models.webtiara.com          # quick, ~200 MB
    python test_proxy.py https://models.webtiara.com --full   # every file, many GB
"""

import argparse
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKER = ROOT / "model-proxy/src/index.js"
MODEL_SERVER = ROOT / "src-tauri/src/model_server.rs"
LOCAL_LLM = ROOT / "src-tauri/src/local_llm.rs"

BLOCKED_SUFFIXES = ("huggingface.co", "hf.co")
WHISPER_REPO = "ggerganov/whisper.cpp"
WHISPER_BASE = f"/{WHISPER_REPO}/resolve/main/"
SMALLEST_WHISPER = "ggml-tiny.en.bin"


# --- Blocking Hugging Face ---------------------------------------------------

def is_blocked(host):
    host = (host or "").lower().rstrip(".")
    return any(host == suffix or host.endswith("." + suffix) for suffix in BLOCKED_SUFFIXES)


def block_hugging_face():
    real = socket.getaddrinfo

    def getaddrinfo(host, *args, **kwargs):
        if isinstance(host, bytes):
            host = host.decode()
        if is_blocked(host):
            raise socket.gaierror(socket.EAI_NONAME, f"{host} is blocked for this test")
        return real(host, *args, **kwargs)

    socket.getaddrinfo = getaddrinfo


# --- What the app downloads ----------------------------------------------------

def app_downloads():
    """(name, path on Hugging Face, bytes, sha256) for every single-file download."""
    downloads = []
    for match in re.finditer(
        r'file: "(ggml-[^"]+)",\s*bytes: ([\d_]+),\s*sha256: "([0-9a-f]{64})"',
        MODEL_SERVER.read_text(),
    ):
        name, size, digest = match.groups()
        downloads.append((name, WHISPER_BASE + name, int(size.replace("_", "")), digest))
    for match in re.finditer(
        r'file: "([^"]+)",\s*url: "https://huggingface\.co(/[^"]+)",\s*bytes: ([\d_]+),\s*sha256: "([0-9a-f]{64})"',
        LOCAL_LLM.read_text(),
    ):
        name, path, size, digest = match.groups()
        downloads.append((name, path, int(size.replace("_", "")), digest))
    if not downloads:
        sys.exit("Found no downloads in the Rust sources; the patterns in this test need updating.")
    return downloads


def snapshot_repos():
    """Repositories the app pulls whole through huggingface_hub or nemo-speech."""
    return re.findall(r'remote_id: "([\w.-]+/[\w.-]+)"', MODEL_SERVER.read_text())


def worker_repos():
    block = re.search(r"const REPOS = \[(.*?)\];", WORKER.read_text(), re.S).group(1)
    return set(re.findall(r'"([^"]+)"', block))


def repo_of(path):
    return "/".join(path.strip("/").split("/")[:2])


# --- HTTP ------------------------------------------------------------------------

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def request(url, method="GET", headers=None, follow=True):
    """(status, headers, final url, body) without raising on HTTP errors."""
    req = urllib.request.Request(url, method=method, headers={"User-Agent": "waveform-proxy-test", **(headers or {})})
    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(req, timeout=60) as response:
            return response.status, response.headers, response.url, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, url, error.read()


def sha256_of_download(url):
    digest, size = hashlib.sha256(), 0
    req = urllib.request.Request(url, headers={"User-Agent": "waveform-proxy-test"})
    with urllib.request.urlopen(req, timeout=60) as response:
        final_host = urllib.parse.urlsplit(response.url).hostname
        while chunk := response.read(1 << 20):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size, final_host


# --- The checks --------------------------------------------------------------------

class Results:
    def __init__(self):
        self.failures = 0

    def check(self, name, ok, detail=""):
        print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""), flush=True)
        if not ok:
            self.failures += 1


def run(base, full):
    proxy_host = urllib.parse.urlsplit(base).hostname
    results = Results()
    downloads = app_downloads()
    repos = snapshot_repos()

    print("Sync between the app and the Worker")
    allowed = worker_repos()
    for repo in sorted({repo_of(path) for _, path, _, _ in downloads} | set(repos)):
        results.check(f"Worker allows {repo}", repo in allowed)

    block_hugging_face()

    print("\nBlock is in effect")
    try:
        urllib.request.urlopen("https://huggingface.co", timeout=10)
        results.check("huggingface.co is unreachable", False, "it answered, so nothing below proves anything")
    except urllib.error.URLError:
        results.check("huggingface.co is unreachable", True)

    print("\nWorker rejects what it should")
    status, *_ = request(f"{base}/openai/whisper-large-v3/resolve/main/config.json")
    results.check("repo outside the allowlist is 404", status == 404, status)
    status, *_ = request(f"{base}/cdn/example.com/anything")
    results.check("CDN path to a non-HF host is 404", status == 404, status)
    status, *_ = request(f"{base}{WHISPER_BASE}{SMALLEST_WHISPER}", method="POST")
    results.check("POST is 405", status == 405, status)

    print("\nRedirects stay on the proxy")
    status, headers, _, _ = request(f"{base}{WHISPER_BASE}{SMALLEST_WHISPER}", method="HEAD", follow=False)
    location = headers.get("location", "")
    results.check("HEAD on an LFS file is a redirect", status in (301, 302, 307), status)
    cdn_host = urllib.parse.urlsplit(location).hostname
    results.check("redirect avoids Hugging Face", bool(cdn_host) and not is_blocked(cdn_host), location[:60])
    results.check("redirect leaves the proxy host (so huggingface_hub keeps its metadata)", cdn_host != proxy_host, cdn_host)
    served_by = {proxy_host, cdn_host}
    results.check("x-repo-commit survives", bool(headers.get("x-repo-commit")))
    results.check("x-linked-size survives", bool(headers.get("x-linked-size")))

    print("\nEvery file the app downloads is reachable, at the size the app expects")
    for name, path, size, _ in downloads:
        status, headers, final, _ = request(f"{base}{path}", headers={"Range": "bytes=0-0"})
        total = (headers.get("content-range") or "").rpartition("/")[2]
        host = urllib.parse.urlsplit(final).hostname
        results.check(name, status == 206 and total == str(size) and host in served_by,
                      f"status {status}, size {total or '?'}, served by {host}")

    print("\nResume: a ranged read matches the same bytes of the whole file")
    name, path, size, _ = next(d for d in downloads if d[0] == SMALLEST_WHISPER)
    start, end = size // 2, size // 2 + 4095
    _, _, _, middle = request(f"{base}{path}", headers={"Range": f"bytes={start}-{end}"})
    _, _, _, whole = request(f"{base}{path}")
    results.check("middle 4 KiB matches", middle == whole[start:end + 1] and len(middle) == 4096)

    print("\nChecksums" + ("" if full else f" (just {SMALLEST_WHISPER}; --full for all)"))
    for name, path, size, expected in downloads:
        if not full and name != SMALLEST_WHISPER:
            continue
        digest, got, host = sha256_of_download(f"{base}{path}")
        results.check(f"{name} sha256", digest == expected and got == size and host in served_by,
                      f"{got} bytes from {host}")

    print("\nhuggingface_hub, the way the Qwen installer calls it")
    for case, env_extra, expect_ok in hub_cases(base, repos, full):
        ok, detail = run_hub_child(case, env_extra)
        results.check(case["label"], ok == expect_ok, detail)

    print(f"\n{'All checks passed.' if not results.failures else f'{results.failures} check(s) failed.'}")
    return results.failures == 0


# --- huggingface_hub, in a fresh process so its env vars take effect ------------

def hub_cases(base, repos, full):
    via_proxy = {"HF_ENDPOINT": base, "HF_HUB_DISABLE_XET": "1"}
    yield ({"label": f"without HF_ENDPOINT, the block stops it (control)", "op": "file",
            "repo": WHISPER_REPO, "file": "README.md"}, {"HF_HUB_DISABLE_XET": "1"}, False)
    yield ({"label": f"hf_hub_download {SMALLEST_WHISPER} through the proxy", "op": "file",
            "repo": WHISPER_REPO, "file": SMALLEST_WHISPER}, via_proxy, True)
    for repo in repos:
        patterns = None if full else ["*.json", "*.md", "*.txt"]
        what = "whole repo" if full else "metadata files"
        yield ({"label": f"snapshot_download {repo} ({what})", "op": "snapshot",
                "repo": repo, "patterns": patterns}, via_proxy, True)


def run_hub_child(case, env_extra):
    with tempfile.TemporaryDirectory() as hf_home:
        env = {k: v for k, v in os.environ.items() if not k.startswith("HF_")}
        env.update(env_extra, HF_HOME=hf_home, HF_HUB_DISABLE_TELEMETRY="1")
        child = subprocess.run(
            [sys.executable, __file__, "--hub-child", json.dumps(case)],
            env=env, capture_output=True, text=True, timeout=3600,
        )
    lines = (child.stdout + child.stderr).strip().splitlines()
    return child.returncode == 0, (lines[-1][:120] if lines else "")


def hub_child(case):
    block_hugging_face()
    from huggingface_hub import hf_hub_download, snapshot_download

    if case["op"] == "file":
        path = hf_hub_download(case["repo"], case["file"])
        print(f"{Path(path).stat().st_size} bytes")
    else:
        path = snapshot_download(case["repo"], allow_patterns=case["patterns"])
        files = [p for p in Path(path).rglob("*") if p.is_file()]
        if not files:
            sys.exit("snapshot came back empty")
        print(f"{len(files)} files")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--hub-child":
        hub_child(json.loads(sys.argv[2]))
        sys.exit(0)
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("base", nargs="?", default="https://models.webtiara.com", help="proxy origin")
    parser.add_argument("--full", action="store_true", help="checksum every file and pull whole repos")
    args = parser.parse_args()
    sys.exit(0 if run(args.base.rstrip("/"), args.full) else 1)
