#!/usr/bin/env python3
"""Draws the disk image background: two slots and an arrow between them.

The window is 660x400 with the app at (180, 170) and Applications at (480, 170),
matching bundle.macOS.dmg in tauri.conf.json. Those coordinates are Finder's,
measured from the top-left of the window's content, and the icons are 128pt --
so a slot is centred on (x, y) and the art has to be placed around that rather
than at it.

Drawn at 2x and reduced, and written twice: background.png for the 1x display
and background@2x.png beside it, which Finder picks up for Retina.

Run: ./.venv-qwen/bin/python scripts/generate-dmg-background.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

WIDTH, HEIGHT = 660, 400
APP_X, APP_Y = 180, 170
FOLDER_X, FOLDER_Y = 480, 170
ICON = 128
SCALE = 2

# The app's own palette, so the image and the icon it sits under agree.
TOP = (247, 246, 243)
BOTTOM = (237, 235, 230)
SLOT = (0, 0, 0, 18)
ARROW = (60, 58, 54, 150)


def background() -> Image.Image:
    size = (WIDTH * SCALE, HEIGHT * SCALE)
    image = Image.new("RGB", size, TOP)
    draw = ImageDraw.Draw(image, "RGBA")

    # A quiet vertical wash rather than a flat fill: flat reads as a missing
    # image, and anything busier competes with the two icons on top of it.
    for y in range(size[1]):
        ratio = y / max(1, size[1] - 1)
        draw.line(
            [(0, y), (size[0], y)],
            fill=tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * ratio) for i in range(3)),
        )

    # A rounded slot behind each icon, so the two positions read as a pair of
    # places rather than as two loose icons.
    pad = 18 * SCALE
    for cx, cy in ((APP_X, APP_Y), (FOLDER_X, FOLDER_Y)):
        left = (cx - ICON // 2) * SCALE - pad
        top = (cy - ICON // 2) * SCALE - pad
        draw.rounded_rectangle(
            [left, top, left + ICON * SCALE + pad * 2, top + ICON * SCALE + pad * 2],
            radius=22 * SCALE,
            fill=SLOT,
        )

    # The arrow: a shaft between the slots with a solid head, pointing the way
    # the drag goes.
    y = APP_Y * SCALE
    start = (APP_X + ICON // 2 + 34) * SCALE
    end = (FOLDER_X - ICON // 2 - 30) * SCALE
    shaft = 3 * SCALE
    head = 13 * SCALE
    draw.rounded_rectangle(
        [start, y - shaft // 2, end - head, y + shaft // 2],
        radius=shaft,
        fill=ARROW,
    )
    draw.polygon(
        [(end, y), (end - head, y - head * 0.62), (end - head, y + head * 0.62)],
        fill=ARROW,
    )

    return image.resize((WIDTH * 2, HEIGHT * 2), Image.LANCZOS)


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    art = root / "icons"
    retina = background()
    retina.save(art / "dmg-background@2x.png")
    retina.resize((WIDTH, HEIGHT), Image.LANCZOS).save(art / "dmg-background.png")
    print(f"wrote {art / 'dmg-background.png'} ({WIDTH}x{HEIGHT}) and @2x")


if __name__ == "__main__":
    main()
