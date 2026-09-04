#!/usr/bin/env python3
"""Generates the macOS app icon from the Waveform brand mark.

macOS needs a filled plate, not a bare glyph: a transparent mark disappears
against a dark dock. This draws the Big Sur icon grid -- an 824pt squircle on a
1024pt canvas -- fills it with the app accent, lays the three-chevron mark over
it in white, and emits both a 1024px PNG and a full .icns.

Run: ./.venv-qwen/bin/python scripts/generate-icon.py
"""
from __future__ import annotations

import math
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

CANVAS = 1024
# Apple's Big Sur grid: the plate is 824/1024 of the canvas, leaving room for
# the shadow the dock expects to see.
PLATE = 824
# Continuous-corner exponent. Lower bows the sides outward; higher approaches a
# plain rectangle. ~7.2 keeps the sides straight while the corners stay
# continuous, which is what reads as a native macOS plate.
SQUIRCLE_EXPONENT = 7.2
# Fraction of the plate the mark spans. Apple keeps glyphs well inside the
# plate; filling it edge to edge is what makes an icon look homemade.
MARK_WIDTH_RATIO = 0.60
SUPERSAMPLE = 4

GRADIENT_TOP = (109, 130, 255)
GRADIENT_BOTTOM = (58, 74, 200)

ICONSET_SIZES = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]


def squircle_mask(size: int, exponent: float = SQUIRCLE_EXPONENT) -> Image.Image:
    """A superellipse mask: |x|^n + |y|^n = 1, the continuous corner Apple uses."""
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    radius = size / 2
    # Walk the curve and fill it as one polygon; far smoother than stacking
    # rounded rectangles, and exact at any size.
    points = []
    steps = 2048
    for index in range(steps):
        theta = 2 * math.pi * index / steps
        cos_t, sin_t = math.cos(theta), math.sin(theta)
        x = radius * math.copysign(abs(cos_t) ** (2 / exponent), cos_t)
        y = radius * math.copysign(abs(sin_t) ** (2 / exponent), sin_t)
        points.append((radius + x, radius + y))
    draw.polygon(points, fill=255)
    return mask


def vertical_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    gradient = Image.new("RGB", (1, size))
    for y in range(size):
        ratio = y / max(1, size - 1)
        # Ease the ramp so the midtone sits high and the plate keeps depth.
        eased = ratio**0.85
        gradient.putpixel(
            (0, y),
            tuple(round(top[i] + (bottom[i] - top[i]) * eased) for i in range(3)),
        )
    return gradient.resize((size, size), Image.BILINEAR)


def draw_mark(plate_size: int) -> Image.Image:
    """The three offset chevrons from the 120pt brand artboard, in white.

    Drawn oversized then cropped to its own ink, so the mark is centred by what
    it actually covers rather than by hand-tuned offsets.
    """
    scale = plate_size / 120 * 2
    canvas = round(160 * scale)
    layer = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    origin = round(30 * scale)
    for shift, alpha in ((-16, 56), (-8, 128), (0, 255)):
        points = [(28, 78), (60, 38), (92, 78)]
        draw.line(
            [(origin + (x + shift) * scale, origin + y * scale) for x, y in points],
            fill=(255, 255, 255, alpha),
            width=round(12 * scale),
        )

    mark = layer.crop(layer.getbbox())
    target_width = round(plate_size * MARK_WIDTH_RATIO)
    target_height = round(mark.height * target_width / mark.width)
    return mark.resize((target_width, target_height), Image.LANCZOS)


def build_icon() -> Image.Image:
    size = CANVAS * SUPERSAMPLE
    plate_size = round(PLATE / CANVAS * size)
    inset = (size - plate_size) // 2

    icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = squircle_mask(plate_size)

    plate = vertical_gradient(plate_size, GRADIENT_TOP, GRADIENT_BOTTOM).convert("RGBA")

    # Soft top-edge highlight, the sheen every native icon has.
    highlight = Image.new("RGBA", (plate_size, plate_size), (0, 0, 0, 0))
    highlight_draw = ImageDraw.Draw(highlight)
    highlight_draw.ellipse(
        [-plate_size * 0.3, -plate_size * 0.95, plate_size * 1.3, plate_size * 0.42],
        fill=(255, 255, 255, 46),
    )
    highlight = highlight.filter(ImageFilter.GaussianBlur(plate_size * 0.06))
    plate = Image.alpha_composite(plate, highlight)

    mark = draw_mark(plate_size)
    plate.alpha_composite(
        mark,
        ((plate_size - mark.width) // 2, (plate_size - mark.height) // 2),
    )
    plate.putalpha(mask)

    # The dock draws its own shadow, but a faint contact shadow keeps the plate
    # from looking pasted on in the Finder and in About windows.
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 52), (inset, inset + round(size * 0.014)), mask)
    shadow = shadow.filter(ImageFilter.GaussianBlur(size * 0.012))
    icon = Image.alpha_composite(icon, shadow)

    icon.paste(plate, (inset, inset), plate)
    return icon.resize((CANVAS, CANVAS), Image.LANCZOS)


def main() -> None:
    icons_dir = Path(__file__).resolve().parent.parent / "icons"
    icon = build_icon()

    png_path = icons_dir / "waveform-icon.png"
    icon.save(png_path)
    print(f"wrote {png_path} ({CANVAS}x{CANVAS})")

    if not shutil.which("iconutil"):
        print("iconutil not found; skipped .icns")
        return

    with tempfile.TemporaryDirectory() as workdir:
        iconset = Path(workdir) / "waveform.iconset"
        iconset.mkdir()
        for name, size in ICONSET_SIZES:
            icon.resize((size, size), Image.LANCZOS).save(iconset / name)

        icns_path = icons_dir / "waveform.icns"
        subprocess.run(
            ["iconutil", "--convert", "icns", "--output", str(icns_path), str(iconset)],
            check=True,
        )
        print(f"wrote {icns_path}")


if __name__ == "__main__":
    main()
