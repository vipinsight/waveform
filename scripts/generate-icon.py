#!/usr/bin/env python3
"""Generates the Waveform mark, app icon and menu bar icon from one definition.

Implements the "Waveform Logo" design: a squircle in a vertical dark gradient
carrying five rounded bars, the middle one in the accent colour. Bars thicken
and shorten in proportion as the icon shrinks, and the accent bar is dropped
at 16pt where it stops reading as a separate bar.

Run: ./.venv-qwen/bin/python scripts/generate-icon.py
"""
from __future__ import annotations

import math
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# Colours are the design's OKLCH values converted to sRGB.
ACCENT = (50, 132, 208)        # oklch(0.6 0.14 250)
GRADIENT_TOP = (51, 56, 67)    # oklch(0.34 0.02 265)
GRADIENT_BOTTOM = (17, 20, 26) # oklch(0.19 0.014 265)
BAR = (246, 245, 242)          # oklch(0.97 0.004 95)

CANVAS = 1024
# The squircle occupies the Big Sur grid rather than the full canvas. macOS
# renders the whole 1024 square at the tile size, so a full-bleed master would
# sit noticeably larger than every neighbour in the Dock -- the opposite of what
# the design's Dock mock shows.
TILE = 824
# Continuous-corner exponent that matches the design's 22.4% radius while
# keeping the sides straight, which is what reads as a native squircle.
SQUIRCLE_EXPONENT = 7.2
SUPERSAMPLE = 4

# Proportions of the tile, per the design's size ladder. Bars take a larger
# share of the tile as it shrinks so they survive the downsample.
LADDER = [
    # (applies at or above this pixel size, bar width, gap, bar heights)
    (128, 0.0781, 0.0664, (0.289, 0.516, 0.203, 0.516, 0.289)),
    (32, 0.0938, 0.0625, (0.297, 0.531, 0.203, 0.531, 0.297)),
    # At 16pt the accent bar is dropped: four bars read where five blur.
    (0, 0.1250, 0.0938, (0.375, 0.5625, 0.5625, 0.375)),
]

ICONSET_SIZES = [
    ("icon_16x16.png", 16, 16),
    ("icon_16x16@2x.png", 32, 16),
    ("icon_32x32.png", 32, 32),
    ("icon_32x32@2x.png", 64, 32),
    ("icon_128x128.png", 128, 128),
    ("icon_128x128@2x.png", 256, 128),
    ("icon_256x256.png", 256, 256),
    ("icon_256x256@2x.png", 512, 512),
    ("icon_512x512.png", 512, 512),
    ("icon_512x512@2x.png", 1024, 1024),
]


def proportions(point_size: int) -> tuple[float, float, tuple[float, ...]]:
    for threshold, width, gap, heights in LADDER:
        if point_size >= threshold:
            return width, gap, heights
    raise AssertionError("ladder must cover every size")


def squircle_mask(size: int, exponent: float = SQUIRCLE_EXPONENT) -> Image.Image:
    """A superellipse mask: |x|^n + |y|^n = 1, the continuous corner Apple uses.

    Coverage is computed per pixel from the distance to the curve rather than
    by filling a polygon and relying on the downsample to soften it. A polygon
    fill is hard-edged, so its only smoothing came from supersampling, which
    left a handful of alpha steps along the corners; this gives a full
    gradient and stays exact on the flat sides.
    """
    radius = size / 2
    # Pixel centres, in units where the curve sits at r = radius.
    axis = np.arange(size, dtype=np.float64) + 0.5 - radius
    dx = np.abs(axis)[None, :]
    dy = np.abs(axis)[:, None]

    # r is the superellipse radius through each point; the curve is r = radius.
    with np.errstate(over="ignore"):
        r = (dx**exponent + dy**exponent) ** (1.0 / exponent)

    # One pixel of falloff centred on the curve.
    coverage = np.clip(radius - r + 0.5, 0.0, 1.0)
    return Image.fromarray((coverage * 255).round().astype(np.uint8), mode="L")


def vertical_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    gradient = Image.new("RGB", (1, size))
    for y in range(size):
        ratio = y / max(1, size - 1)
        gradient.putpixel(
            (0, y),
            tuple(round(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3)),
        )
    return gradient.resize((size, size), Image.BILINEAR)


def draw_bars(tile: Image.Image, point_size: int) -> None:
    """Lays the bars across the centre of the tile."""
    size = tile.width
    bar_width, gap, heights = proportions(point_size)

    width = bar_width * size
    spacing = gap * size
    total = len(heights) * width + (len(heights) - 1) * spacing
    x = (size - total) / 2
    centre = size / 2
    accent_index = 2 if len(heights) == 5 else None

    draw = ImageDraw.Draw(tile)
    for index, height_ratio in enumerate(heights):
        height = height_ratio * size
        colour = ACCENT if index == accent_index else BAR
        draw.rounded_rectangle(
            [x, centre - height / 2, x + width, centre + height / 2],
            radius=width / 2,
            fill=(*colour, 255),
        )
        x += width + spacing


def build_tile(point_size: int, pixels: int) -> Image.Image:
    """Renders one squircle tile, supersampled then reduced."""
    size = pixels * SUPERSAMPLE
    tile = vertical_gradient(size, GRADIENT_TOP, GRADIENT_BOTTOM).convert("RGBA")

    # A wide, soft ellipse off the top edge: the sheen every native icon has.
    sheen = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(sheen).ellipse(
        [-0.2 * size, -0.55 * size, 1.2 * size, 0.35 * size],
        fill=(255, 255, 255, 13),
    )
    tile = Image.alpha_composite(tile, sheen.filter(ImageFilter.GaussianBlur(size * 0.04)))

    draw_bars(tile, point_size)

    # Inner top highlight and bottom shading, which give the tile its edge.
    edges = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    edge_draw = ImageDraw.Draw(edges)
    lip = max(1, round(size * 0.006))
    edge_draw.rectangle([0, 0, size, lip], fill=(255, 255, 255, 41))
    edge_draw.rectangle([0, size - lip, size, size], fill=(0, 0, 0, 89))
    tile = Image.alpha_composite(tile, edges)

    # Mask last, at final resolution: computing coverage here rather than
    # supersampling a hard-edged mask is what keeps the corners smooth.
    tile = tile.resize((pixels, pixels), Image.LANCZOS)
    tile.putalpha(squircle_mask(pixels))
    return tile


def build_icon(point_size: int, pixels: int) -> Image.Image:
    """Places the tile on the canvas at the Big Sur grid, with no baked shadow.

    The design calls for no shadow in the artwork: macOS draws its own in the
    Dock, and a second one underneath it reads as a halo.
    """
    tile_pixels = max(1, round(pixels * TILE / CANVAS))
    inset = (pixels - tile_pixels) // 2

    icon = Image.new("RGBA", (pixels, pixels), (0, 0, 0, 0))
    icon.paste(build_tile(point_size, tile_pixels), (inset, inset))
    return icon


def build_mark_svg() -> str:
    """The bare mark, for use inside the interface."""
    bar_width, gap, heights = proportions(128)
    size = 100.0
    width = bar_width * size
    spacing = gap * size
    total = len(heights) * width + (len(heights) - 1) * spacing
    x = (size - total) / 2

    bars = []
    for index, height_ratio in enumerate(heights):
        height = height_ratio * size
        # currentColor for the four, so the mark takes the interface's ink;
        # the middle bar keeps the accent that identifies it.
        fill = "var(--mark-accent, #3284d0)" if index == 2 else "currentColor"
        bars.append(
            f'<rect x="{x:.2f}" y="{(size - height) / 2:.2f}" '
            f'width="{width:.2f}" height="{height:.2f}" '
            f'rx="{width / 2:.2f}" fill="{fill}"/>'
        )
        x += width + spacing

    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" '
        'width="100" height="100">' + "".join(bars) + "</svg>\n"
    )


def build_tray_icon(size: int = 44) -> Image.Image:
    """A monochrome template icon for the menu bar.

    macOS recolours template images, so this carries shape in the alpha channel
    only and drops both the tile and the accent.

    The mark's own proportions are relative to a tile it sits inside with
    padding. Reused directly here the bars would fill only half the menu bar's
    height, so they are rescaled about the tallest bar -- the ratios between
    bar width, gap and each height are the mark's, the overall size is not.
    """
    bar_width, gap, heights = proportions(128)
    tallest_ratio = max(heights)

    # Tallest bar fills most of the slot; everything else follows the mark.
    tallest = size * 0.78
    width = tallest * (bar_width / tallest_ratio)
    spacing = tallest * (gap / tallest_ratio)

    total = len(heights) * width + (len(heights) - 1) * spacing
    x = (size - total) / 2
    centre = size / 2

    icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(icon)
    for height_ratio in heights:
        height = tallest * (height_ratio / tallest_ratio)
        draw.rounded_rectangle(
            [x, centre - height / 2, x + width, centre + height / 2],
            radius=width / 2,
            fill=(0, 0, 0, 255),
        )
        x += width + spacing
    return icon


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    icons = root / "icons"

    master = build_icon(1024, CANVAS)
    master.save(icons / "waveform-icon.png")
    print(f"wrote {icons / 'waveform-icon.png'} ({CANVAS}x{CANVAS})")

    (icons / "waveform-mark.svg").write_text(build_mark_svg())
    print(f"wrote {icons / 'waveform-mark.svg'}")

    build_tray_icon().save(icons / "tray-icon.png")
    print(f"wrote {icons / 'tray-icon.png'} (menu bar template)")

    if not shutil.which("iconutil"):
        print("iconutil not found; skipped .icns")
        return

    with tempfile.TemporaryDirectory() as workdir:
        iconset = Path(workdir) / "waveform.iconset"
        iconset.mkdir()
        for name, pixels, point_size in ICONSET_SIZES:
            build_icon(point_size, pixels).save(iconset / name)

        icns = icons / "waveform.icns"
        subprocess.run(
            ["iconutil", "--convert", "icns", "--output", str(icns), str(iconset)],
            check=True,
        )
        print(f"wrote {icns}")

    # Tauri embeds these into the binary and applies them at runtime, which
    # overrides whatever the bundle carries. Left stale, the correct icon
    # appears for a moment at launch and is then replaced by the old one.
    embedded = root / "src-tauri" / "icons"
    embedded.mkdir(parents=True, exist_ok=True)
    shutil.copy(icons / "waveform-icon.png", embedded / "icon.png")
    shutil.copy(icons / "waveform.icns", embedded / "icon.icns")
    print(f"wrote {embedded / 'icon.png'} and icon.icns (embedded by Tauri)")


if __name__ == "__main__":
    main()
