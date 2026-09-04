import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ResourceUsage } from "../shared/contracts";

const run = promisify(execFile);
const SAMPLE_INTERVAL_MS = 2_000;

/**
 * Samples CPU and memory for the whole app, not just the Electron side.
 *
 * The speech engine is a separate Python or Go process and is by far the
 * largest consumer, so a figure that ignored it would be misleading. Electron
 * reports its own processes through getAppMetrics; the engine is read from ps.
 */
export class ResourceMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly getAppMetrics: () => Electron.ProcessMetric[],
    private readonly getEnginePid: () => number | null,
    private readonly emit: (usage: ResourceUsage) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.sample();
    this.timer = setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS);
    // Never hold the event loop open just to report statistics.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async sample(): Promise<void> {
    let cpuPercent = 0;
    let memoryMb = 0;

    for (const metric of this.getAppMetrics()) {
      cpuPercent += metric.cpu?.percentCPUUsage ?? 0;
      // workingSetSize is in kilobytes.
      memoryMb += (metric.memory?.workingSetSize ?? 0) / 1024;
    }

    const engine = await this.readEngineUsage();
    if (engine) {
      cpuPercent += engine.cpuPercent;
      memoryMb += engine.memoryMb;
    }

    this.emit({
      cpuPercent: Math.round(cpuPercent),
      memoryMb: Math.round(memoryMb),
      engineMemoryMb: engine ? Math.round(engine.memoryMb) : null,
    });
  }

  private async readEngineUsage(): Promise<{ cpuPercent: number; memoryMb: number } | null> {
    const pid = this.getEnginePid();
    if (pid === null) return null;

    try {
      // -o with trailing "=" suppresses headers, leaving one line: "%cpu rss".
      const { stdout } = await run("ps", ["-o", "%cpu=,rss=", "-p", String(pid)]);
      const [cpu, rss] = stdout.trim().split(/\s+/);
      const cpuPercent = Number.parseFloat(cpu ?? "");
      const rssKb = Number.parseFloat(rss ?? "");
      if (!Number.isFinite(cpuPercent) || !Number.isFinite(rssKb)) return null;
      return { cpuPercent, memoryMb: rssKb / 1024 };
    } catch {
      // The engine exited between the pid read and the ps call.
      return null;
    }
  }
}
