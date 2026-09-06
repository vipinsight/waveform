#!/usr/bin/env python3
"""Write the disk image's Finder layout so the background actually shows.

Tauri copies the art into .background/ and records icon positions, but the
.DS_Store it produces has no picture reference. Telling Finder via AppleScript
used to write one; on macOS 26 (Tahoe) that handler fails, and Finder then
prefers a stale pBBk bookmark over the portable alias. The picture never
appears, so the window opens with the icons on default grey and nothing
showing that one is meant to be dragged onto the other.

This writes the same records dmgbuild does: an icvp alias to the background,
window bounds, and icon positions, and it leaves the bookmark out.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from ds_store import DSStore
from mac_alias import Alias


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mount")
    parser.add_argument("--background", default=".background/dmg-background.png")
    parser.add_argument("--window", nargs=2, type=int, metavar=("W", "H"), default=[660, 400])
    parser.add_argument("--origin", nargs=2, type=int, metavar=("X", "Y"), default=[200, 140])
    parser.add_argument("--app", nargs=2, type=int, metavar=("X", "Y"), default=[180, 170])
    parser.add_argument("--folder", nargs=2, type=int, metavar=("X", "Y"), default=[480, 170])
    parser.add_argument("--icon-size", type=int, default=128)
    args = parser.parse_args()

    mount = Path(args.mount)
    background = mount / args.background
    if not background.is_file():
        raise SystemExit(f"write-dmg-layout: no {background}")

    window_w, window_h = args.window
    origin_x, origin_y = args.origin
    bwsp = {
        "ShowStatusBar": False,
        "WindowBounds": f"{{{{{origin_x}, {origin_y}}}, {{{window_w}, {window_h}}}}}",
        "ContainerShowSidebar": False,
        "PreviewPaneVisibility": False,
        "SidebarWidth": 180,
        "ShowTabView": False,
        "ShowToolbar": False,
        "ShowPathbar": False,
        "ShowSidebar": False,
    }
    icvp = {
        "viewOptionsVersion": 1,
        "backgroundType": 2,
        "backgroundColorRed": 1.0,
        "backgroundColorGreen": 1.0,
        "backgroundColorBlue": 1.0,
        "backgroundImageAlias": Alias.for_file(str(background)).to_bytes(),
        "gridOffsetX": 0.0,
        "gridOffsetY": 0.0,
        "gridSpacing": 100.0,
        "arrangeBy": "none",
        "showIconPreview": False,
        "showItemInfo": False,
        "labelOnBottom": True,
        "textSize": 16.0,
        "iconSize": float(args.icon_size),
        "scrollPositionX": 0.0,
        "scrollPositionY": 0.0,
    }

    store = mount / ".DS_Store"
    store.unlink(missing_ok=True)
    with DSStore.open(str(store), "w+") as d:
        d["."]["vSrn"] = ("long", 1)
        d["."]["bwsp"] = bwsp
        d["."]["icvp"] = icvp
        d["Waveform.app"]["Iloc"] = tuple(args.app)
        d["Applications"]["Iloc"] = tuple(args.folder)


if __name__ == "__main__":
    main()
