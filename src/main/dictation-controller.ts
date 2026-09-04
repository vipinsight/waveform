import { globalShortcut, shell, type WebContents } from "electron";
import type {
  DictationMode,
  DictationPhrase,
  DictationSink,
  DictationStatus,
  HotkeyStatus,
  PrivacyPane,
} from "../shared/contracts";
import { hotkeyKeyCode } from "../shared/hotkeys";
import { IPC_CHANNELS } from "../shared/ipc";
import type { AppSettings } from "../shared/settings";
import { HotkeyGestureMachine } from "./hotkey-gestures";
import { HotkeyHelper, isHelperAvailable, type HelperEvent } from "./hotkey-helper";
import { OverlayWindow } from "./overlay-window";
import type { Rewriter } from "./rewriter";
import type { SettingsStore } from "./settings-store";

const PRIVACY_PANES: Record<PrivacyPane, string> = {
  accessibility:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "input-monitoring":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
  microphone:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
};

interface Session {
  sink: DictationSink;
  mode: DictationMode;
}

/**
 * Coordinates a dictation session across three processes: the native key
 * watcher, the overlay renderer that owns the microphone, and the main window
 * that shows the running transcript.
 */
export class DictationController {
  private readonly overlay = new OverlayWindow();
  private readonly helper: HotkeyHelper;
  private gestures: HotkeyGestureMachine;
  private session: Session | null = null;
  private escapeRegistered = false;
  private polishShortcut: string | null = null;
  private polishing = false;
  private status: HotkeyStatus;

  constructor(
    private readonly settings: SettingsStore,
    private readonly getMainWindowContents: () => WebContents | null,
    private readonly onSessionStarting: () => void,
    private readonly onPhraseRecorded: (text: string) => void = () => undefined,
    private readonly rewriter: Rewriter | null = null,
  ) {
    this.helper = new HotkeyHelper((event) => this.handleHelperEvent(event));
    this.gestures = this.createGestureMachine();
    this.status = {
      supported: process.platform === "darwin",
      running: false,
      tapActive: false,
      accessibility: false,
      inputMonitoring: false,
      binding: this.settings.value.hotkeyId,
    };
  }

  async initialize(): Promise<void> {
    this.overlay.create();
    if (process.platform !== "darwin") {
      this.patchStatus({ supported: false });
      return;
    }

    const available = await isHelperAvailable();
    if (!available) {
      this.patchStatus({ supported: false });
      return;
    }

    await this.helper.start();
    this.patchStatus({ running: this.helper.isRunning });
    this.applyBinding();
    this.applyPolishShortcut();
  }

  dispose(): void {
    this.releaseEscape();
    this.releasePolishShortcut();
    this.helper.stop();
    this.overlay.destroy();
  }

  get overlayContents(): WebContents | null {
    return this.overlay.webContents;
  }

  get hotkeyStatus(): HotkeyStatus {
    return this.status;
  }

  /** Re-reads timings and binding after the user changes settings. */
  applySettings(settings: AppSettings): void {
    this.gestures.reset();
    this.gestures = this.createGestureMachine();
    this.applyBinding();
    this.applyPolishShortcut();
    this.patchStatus({ binding: settings.hotkeyId });
  }

  /**
   * Rewrites whatever is selected in the focused app, in place.
   *
   * The selection has to be copied to be readable, so this is only ever driven
   * by an explicit user gesture, never automatically.
   */
  async polishSelection(): Promise<void> {
    if (!this.rewriter) return;
    if (this.polishing) return;
    if (this.session) {
      this.reportError("Finish dictating before polishing.");
      return;
    }
    if (!this.rewriter.isConfigured) {
      this.reportError("Add an OpenRouter API key in Settings first.");
      return;
    }

    this.polishing = true;
    this.overlay.show(this.settings.value.overlayPlacement, {
      x: this.settings.value.overlayX,
      y: this.settings.value.overlayY,
    });
    this.sendToOverlay({ action: "busy", sink: "insert", mode: "hold" });

    try {
      const selection = await this.helper.requestSelection();
      const polished = await this.rewriter.polish(selection);
      if (polished !== selection) this.helper.paste(polished);
      this.sendToOverlay({ action: "stop", sink: "insert", mode: "hold" });
    } catch (error) {
      this.sendToOverlay({ action: "cancel", sink: "insert", mode: "hold" });
      this.reportError(error instanceof Error ? error.message : String(error));
    } finally {
      this.polishing = false;
    }
  }

  private applyPolishShortcut(): void {
    const wanted = this.settings.value.polishShortcut;
    if (wanted === this.polishShortcut) return;

    this.releasePolishShortcut();
    if (wanted === "none") return;

    // Another app may already own the combination; failing to register is not
    // an error worth interrupting the user over, but it must not look bound.
    if (globalShortcut.register(wanted, () => void this.polishSelection())) {
      this.polishShortcut = wanted;
    }
  }

  private releasePolishShortcut(): void {
    if (!this.polishShortcut) return;
    globalShortcut.unregister(this.polishShortcut);
    this.polishShortcut = null;
  }

  private reportError(message: string): void {
    this.sendToMainWindow({
      status: { state: "error", sink: "insert", mode: "hold", message },
    });
  }

  /** Shows the HUD briefly with synthetic levels, so the user can locate it. */
  previewIndicator(): void {
    this.overlay.show(this.settings.value.overlayPlacement, {
      x: this.settings.value.overlayX,
      y: this.settings.value.overlayY,
    });
    this.sendToOverlay({ action: "preview", sink: "transcript", mode: "hold" });
  }

  beginOverlayDrag(): void {
    this.overlay.beginDrag();
  }

  dragOverlay(deltaX: number, deltaY: number): void {
    this.overlay.dragBy(deltaX, deltaY);
  }

  /** Persists where the HUD was dropped; returns it so settings can be saved. */
  endOverlayDrag(): { x: number; y: number } | null {
    return this.overlay.endDrag();
  }

  requestPermission(scope: "accessibility" | "input-monitoring"): void {
    this.helper.requestPermission(scope);
  }

  async openPrivacyPane(pane: PrivacyPane): Promise<void> {
    await shell.openExternal(PRIVACY_PANES[pane]);
  }

  refreshPermissions(): void {
    this.helper.refreshPermissions();
  }

  /** The in-app Start/Stop button: same pipeline, but text stays in the app. */
  toggleFromApp(): void {
    if (this.session) {
      this.endSession("stop");
      return;
    }
    this.beginSession("transcript", "latched");
  }

  private createGestureMachine(): HotkeyGestureMachine {
    const { holdMs, doubleTapMs } = this.settings.value;
    return new HotkeyGestureMachine(
      (command) => {
        switch (command.type) {
          case "start":
            this.beginSession("insert", "hold");
            return;
          case "latch":
            this.promoteToLatched();
            return;
          case "commit":
            this.endSession("stop");
            return;
          case "discard":
            this.endSession("cancel");
            return;
        }
      },
      { holdMs, doubleTapMs },
    );
  }

  private applyBinding(): void {
    const keyCode = hotkeyKeyCode(this.settings.value.hotkeyId);
    if (keyCode === null) {
      this.helper.unwatch();
      return;
    }
    this.helper.watch(keyCode);
  }

  private handleHelperEvent(event: HelperEvent): void {
    switch (event.type) {
      case "ready":
        this.patchStatus({ running: true });
        this.applyBinding();
        return;
      case "key":
        if (event.phase === "down") this.gestures.keyDown();
        else this.gestures.keyUp();
        return;
      case "tap":
        this.patchStatus({ tapActive: event.active });
        return;
      case "permissions":
        this.patchStatus({
          accessibility: event.accessibility,
          inputMonitoring: event.inputMonitoring,
        });
        return;
      case "paste":
        if (!event.ok && event.reason === "accessibility") {
          this.helper.refreshPermissions();
        }
        return;
    }
  }

  private beginSession(sink: DictationSink, mode: DictationMode): void {
    if (this.session) return;
    this.session = { sink, mode };
    this.onSessionStarting();
    this.overlay.show(this.settings.value.overlayPlacement, {
      x: this.settings.value.overlayX,
      y: this.settings.value.overlayY,
    });
    this.sendToOverlay({ action: "start", sink, mode });
    this.captureEscape();
  }

  private promoteToLatched(): void {
    if (!this.session) return;
    this.session = { ...this.session, mode: "latched" };
    this.sendToOverlay({ action: "start", sink: this.session.sink, mode: "latched" });
  }

  private endSession(action: "stop" | "cancel"): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    this.releaseEscape();
    this.sendToOverlay({ action, sink: session.sink, mode: session.mode });
  }

  /** Escape aborts a dictation without pasting, but only while one is running. */
  private captureEscape(): void {
    if (this.escapeRegistered) return;
    this.escapeRegistered = globalShortcut.register("Escape", () => {
      this.gestures.cancel();
      if (this.session) this.endSession("cancel");
    });
  }

  private releaseEscape(): void {
    if (!this.escapeRegistered) return;
    globalShortcut.unregister("Escape");
    this.escapeRegistered = false;
  }

  /** Called when the overlay reports where its capture actually got to. */
  handleOverlayState(status: DictationStatus): void {
    if (status.state === "idle") {
      this.overlay.hide();
      if (this.session) {
        // The overlay stopped on its own (a device error, say); resync.
        this.session = null;
        this.gestures.reset();
        this.releaseEscape();
      }
    }
    this.sendToMainWindow({ status });
  }

  handleOverlayPhrase(phrase: DictationPhrase): void {
    const trimmed = phrase.text.trim();
    if (!trimmed) return;
    void this.deliverPhrase(phrase, trimmed);
  }

  /**
   * Sends a finished phrase onward, optionally cleaned up by the model first.
   *
   * A failed rewrite falls back to the raw transcript rather than dropping what
   * the user just said.
   */
  private async deliverPhrase(phrase: DictationPhrase, trimmed: string): Promise<void> {
    let text = trimmed;

    if (this.rewriter && phrase.sink === "insert") {
      try {
        const cleaned = await this.rewriter.cleanUpDictation(trimmed);
        if (cleaned) text = cleaned;
      } catch (error) {
        this.reportError(error instanceof Error ? error.message : String(error));
      }
    }

    if (phrase.sink === "insert" && this.settings.value.insertIntoFocusedApp) {
      this.helper.paste(`${text} `);
    }
    this.onPhraseRecorded(text);

    this.sendToMainWindow({
      status: {
        state: this.session ? "listening" : "idle",
        sink: phrase.sink,
        mode: this.session?.mode ?? "hold",
      },
      phrase: { text, sink: phrase.sink },
    });
  }

  private sendToOverlay(command: {
    action: "start" | "stop" | "cancel" | "preview" | "busy";
    sink: DictationSink;
    mode: DictationMode;
  }): void {
    this.overlay.webContents?.send(IPC_CHANNELS.dictationCommand, command);
  }

  private sendToMainWindow(update: {
    status: DictationStatus;
    phrase?: DictationPhrase;
  }): void {
    this.getMainWindowContents()?.send(IPC_CHANNELS.dictationUpdate, update);
  }

  private patchStatus(patch: Partial<HotkeyStatus>): void {
    const next = { ...this.status, ...patch };
    if (
      next.supported === this.status.supported &&
      next.running === this.status.running &&
      next.tapActive === this.status.tapActive &&
      next.accessibility === this.status.accessibility &&
      next.inputMonitoring === this.status.inputMonitoring &&
      next.binding === this.status.binding
    ) {
      return;
    }
    this.status = next;
    this.getMainWindowContents()?.send(IPC_CHANNELS.hotkeyStatusChanged, next);
  }
}
