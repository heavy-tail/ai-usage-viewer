import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/collectors/command";

describe("Windows command runner", () => {
  it.skipIf(process.platform !== "win32")(
    "executes an absolute .cmd shim with spaced arguments",
    async () => {
      const command = resolve("test", "fixtures", "command-runner.cmd");
      const result = await runCommand(
        command,
        ["hello world", "safe-value"],
        { cwd: process.cwd(), timeoutMs: 10_000 }
      );

      expect(result.exitCode, JSON.stringify(result)).toBe(0);
      expect(result.stdout).toContain("first=hello world");
      expect(result.stdout).toContain("second=safe-value");
      expect(result.stdout).not.toContain("INJECTED");
    },
    15_000
  );

  it.skipIf(process.platform !== "win32")(
    "kills descendants when a non-PTY command times out",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usage-viewer-command-"));
      const marker = join(directory, "orphan-marker.txt");
      const fixture = resolve("test", "fixtures", "spawn-descendant.mjs");

      const result = await runCommand(process.execPath, [fixture, marker], {
        cwd: process.cwd(),
        timeoutMs: 250,
      });
      expect(Number.isNaN(result.exitCode)).toBe(true);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_300));
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
    5_000
  );
});
