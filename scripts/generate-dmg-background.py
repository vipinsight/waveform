#!/usr/bin/env python3
"""Renders scripts/dmg-background.html into the disk image background.

Headless Chrome draws the page at 2x for icons/dmg-background@2x.png (Finder
picks it up on Retina), and sips scales that to icons/dmg-background.png for
1x displays. Edit the HTML, run this, and commit both PNGs; the release build
only copies them.

Run: python3 scripts/generate-dmg-background.py
"""
import os
import subprocess
import sys
from pathlib import Path

WIDTH, HEIGHT = 660, 400
CHROME = os.environ.get(
    "CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
)


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    page = root / "scripts" / "dmg-background.html"
    retina = root / "icons" / "dmg-background@2x.png"
    normal = root / "icons" / "dmg-background.png"

    if not Path(CHROME).exists():
        sys.exit(f"generate-dmg-background: no Chrome at {CHROME} (set CHROME)")

    subprocess.run(
        [
            CHROME,
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--force-device-scale-factor=2",
            f"--window-size={WIDTH},{HEIGHT}",
            f"--screenshot={retina}",
            page.as_uri(),
        ],
        check=True,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(
        ["sips", "-z", str(HEIGHT), str(WIDTH), str(retina), "--out", str(normal)],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    print(f"wrote {normal} ({WIDTH}x{HEIGHT}) and @2x")


if __name__ == "__main__":
    main()
