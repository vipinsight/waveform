import { join } from "node:path";

export function qwenRuntimeCandidates(
  userDataPath: string,
  projectRoot: string,
  configuredPython?: string,
): string[] {
  return [
    configuredPython,
    join(userDataPath, "qwen", "bin", "python3"),
    join(projectRoot, ".venv-qwen", "bin", "python3"),
  ].filter((candidate): candidate is string => Boolean(candidate));
}
