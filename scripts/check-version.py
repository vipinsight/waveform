#!/usr/bin/env python3
"""Check the four release versions without changing any files."""
import json
import pathlib
import re
import sys

root = pathlib.Path(__file__).resolve().parent.parent
versions = {}
for name in ("package.json", "src-tauri/tauri.conf.json"):
    versions[name] = json.loads((root / name).read_text())["version"]
for name, pattern in (
    ("src-tauri/Cargo.toml", r'(?m)^version = "([^"]+)"'),
    ("src-tauri/Cargo.lock", r'(?m)^name = "waveform"\nversion = "([^"]+)"'),
):
    match = re.search(pattern, (root / name).read_text())
    if not match:
        sys.exit(f"version: no package version in {name}")
    versions[name] = match.group(1)
if len(set(versions.values())) != 1:
    sys.exit("version: mismatch: " + ", ".join(f"{p}={v}" for p, v in versions.items()))
version = next(iter(versions.values()))
if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
    sys.exit(f"version: expected a stable major.minor.patch version, got {version}")
print(f"version: all four files agree on {version}")
