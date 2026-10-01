import type { AppStats, ResourceUsage } from "../../shared/contracts";
import { getSpeechModel } from "../../shared/models";
import { requireElement } from "../ui/dom";
import { formatMemory } from "../ui/format";
import { showToast } from "../ui/toast";
import { state } from "../state";
import { renderEmptyState } from "./history";

/**
 * The Overview page: lifetime counters, what the engine is doing, and what
 * the app costs to run.
 */

const element = {
  statWords: requireElement<HTMLElement>("stat-words"),
  statPhrases: requireElement<HTMLElement>("stat-phrases"),
  statSessions: requireElement<HTMLElement>("stat-sessions"),
  overviewModel: requireElement<HTMLElement>("overview-model"),
  overviewModelState: requireElement<HTMLElement>("overview-model-state"),
  overviewCpu: requireElement<HTMLElement>("overview-cpu"),
  overviewMemory: requireElement<HTMLElement>("overview-memory"),
  overviewEngineMemory: requireElement<HTMLElement>("overview-engine-memory"),
};

export function renderStats(stats: AppStats): void {
  state.lifetimeSessions = stats.sessions;
  element.statWords.textContent = stats.words.toLocaleString();
  element.statPhrases.textContent = stats.phrases.toLocaleString();
  element.statSessions.textContent = stats.sessions.toLocaleString();
  renderEmptyState();
}

export function renderResourceUsage(usage: ResourceUsage): void {
  const memory = formatMemory(usage.memoryMb);
  element.overviewCpu.textContent = `${usage.cpuPercent}%`;
  element.overviewMemory.textContent = memory;
  element.overviewEngineMemory.textContent =
    usage.engineMemoryMb === null
      ? "Speech engine is not running"
      : `Speech engine accounts for ${formatMemory(usage.engineMemoryMb)}`;
}

/** Names the speech model on the Overview page. */
export function renderOverviewModel(): void {
  element.overviewModel.textContent = getSpeechModel(state.settings.modelId).label;
}

/**
 * Says what just happened: on the Overview page's engine line, where it
 * stays, and as a toast, so it is seen from whichever page is up.
 */
export function setStatus(message: string): void {
  element.overviewModelState.textContent = message;
  showToast(message);
}
