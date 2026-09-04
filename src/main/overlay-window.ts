import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import type { OverlayPlacement } from "../shared/settings";

const OVERLAY_WIDTH = 148;
const OVERLAY_HEIGHT = 46;
const EDGE_MARGIN = 88;

/**
 * The floating dictation HUD, and the only place the microphone is ever opened.
 *
 * It lives for the whole app session because it owns the audio pipeline; it is
 * merely hidden between dictations. Two properties are load-bearing:
 * `focusable: false` keeps the frontmost app frontmost — otherwise the ⌘V we
 * paste would land in Waveform — and `backgroundThrottling: false` keeps the
 * audio graph running while the window is off screen.
 */
export class OverlayWindow {
  private window: BrowserWindow | null = null;
  private dragOrigin: { x: number; y: number } | null = null;

  create(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;

    const window = new BrowserWindow({
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      acceptFirstMouse: true,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Mouse events stay enabled so the HUD can be dragged. It is tiny and only
    // on screen while dictating, so it costs the user almost no clickable area.
    void window.loadFile(join(__dirname, "../renderer/overlay.html"));

    window.on("closed", () => {
      this.window = null;
    });

    this.window = window;
    return window;
  }

  get webContents(): Electron.WebContents | null {
    const window = this.window;
    return window && !window.isDestroyed() ? window.webContents : null;
  }

  show(placement: OverlayPlacement, saved: { x: number | null; y: number | null }): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    if (saved.x !== null && saved.y !== null) {
      this.positionAt(window, saved.x, saved.y);
    } else {
      this.positionOnActiveDisplay(window, placement);
    }
    // showInactive, never show: activating this window would move focus away
    // from the app the user is dictating into.
    window.showInactive();
    window.setAlwaysOnTop(true, "screen-saver");
  }

  hide(): void {
    const window = this.window;
    if (!window || window.isDestroyed() || !window.isVisible()) return;
    window.hide();
  }

  destroy(): void {
    const window = this.window;
    this.window = null;
    if (window && !window.isDestroyed()) window.destroy();
  }

  /** Records where the HUD is as a drag starts, so moves can be relative. */
  beginDrag(): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    const { x, y } = window.getBounds();
    this.dragOrigin = { x, y };
  }

  dragBy(deltaX: number, deltaY: number): void {
    const window = this.window;
    const origin = this.dragOrigin;
    if (!window || window.isDestroyed() || !origin) return;
    this.positionAt(window, origin.x + deltaX, origin.y + deltaY);
  }

  /** Returns the resting position so it can be persisted, or null if no drag ran. */
  endDrag(): { x: number; y: number } | null {
    const window = this.window;
    if (!this.dragOrigin || !window || window.isDestroyed()) return null;
    this.dragOrigin = null;
    const { x, y } = window.getBounds();
    return { x, y };
  }

  /** Keeps the HUD on a real display, so it cannot be dragged out of reach. */
  private positionAt(window: BrowserWindow, x: number, y: number): void {
    const area = screen.getDisplayNearestPoint({
      x: Math.round(x + OVERLAY_WIDTH / 2),
      y: Math.round(y + OVERLAY_HEIGHT / 2),
    }).workArea;

    window.setBounds({
      x: clamp(Math.round(x), area.x, area.x + area.width - OVERLAY_WIDTH),
      y: clamp(Math.round(y), area.y, area.y + area.height - OVERLAY_HEIGHT),
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
    });
  }

  /** Follows the pointer's display so the HUD appears on the screen you are working on. */
  private positionOnActiveDisplay(
    window: BrowserWindow,
    placement: OverlayPlacement,
  ): void {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { x, y, width, height } = display.workArea;
    const left = Math.round(x + (width - OVERLAY_WIDTH) / 2);
    const top =
      placement === "top"
        ? Math.round(y + EDGE_MARGIN)
        : Math.round(y + height - OVERLAY_HEIGHT - EDGE_MARGIN);
    window.setBounds({ x: left, y: top, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT });
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
