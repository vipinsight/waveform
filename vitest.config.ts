import { defineConfig } from "vitest/config";

// Agent worktrees live under .claude/worktrees; their copies of the tests must
// not run as this checkout's.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**"],
  },
});
