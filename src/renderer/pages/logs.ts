import type { LogLine } from "../../shared/contracts";
import { host } from "../host";
import { requireElement } from "../ui/dom";

/**
 * The Logs page in Settings: what the host has said this session, pulled
 * when the page opens and appended to while it is up.
 */

const element = {
  logView: requireElement<HTMLElement>("log-view"),
  logFollow: requireElement<HTMLInputElement>("log-follow"),
  logCopy: requireElement<HTMLButtonElement>("log-copy"),
  logClear: requireElement<HTMLButtonElement>("log-clear"),
};

/** Everything the log has said this session, oldest first. */
let logLines: LogLine[] = [];

export function bindLogs(): void {
  host().onLogLine(handleLogLine);
  element.logCopy.addEventListener("click", () => {
    const text = logLines
      .map((line) => `${new Date(line.at).toISOString()} ${line.source} ${line.message}`)
      .join("\n");
    void navigator.clipboard.writeText(text);
  });
  element.logClear.addEventListener("click", () => {
    void host().clearLogs();
    logLines = [];
    renderLogs();
  });
}

/**
 * Fills the log page from the buffer Rust holds.
 *
 * Pulled rather than accumulated from events alone: this window can open long
 * after the interesting part, and the engine says most of what matters while
 * it is starting.
 */
export async function loadLogs(): Promise<void> {
  logLines = await host().getLogs().catch(() => []);
  renderLogs();
}

function renderLogs(): void {
  const view = element.logView;
  // Measured before the write, because appending changes both numbers.
  const pinned = element.logFollow.checked;
  view.replaceChildren(
    ...logLines.map((line) => {
      const row = document.createElement("div");
      const time = document.createElement("b");
      time.textContent = new Date(line.at).toLocaleTimeString([], { hour12: false });
      const source = document.createElement("i");
      source.textContent = ` ${line.source} `;
      const message =
        line.level === "error"
          ? document.createElement("s")
          : document.createElement("span");
      message.textContent = line.message;
      row.append(time, source, message);
      return row;
    }),
  );
  if (pinned) view.scrollTop = view.scrollHeight;
}

function handleLogLine(line: LogLine): void {
  logLines.push(line);
  // The same cap Rust keeps, so a long session does not grow this window's
  // copy without bound.
  if (logLines.length > 400) logLines.shift();
  const page = element.logView.closest<HTMLElement>(".settings-page");
  if (page && !page.hidden) renderLogs();
}
