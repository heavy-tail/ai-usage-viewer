import { describe, expect, it, vi } from "vitest";
import { collectClaude } from "../src/collectors/claude";
import { DEFAULT_CONFIG } from "../src/config";
import type { PtyRunner, RunPtyOptions } from "../src/collectors/pty";
import type { CollectorContext, CommandRunner } from "../src/collectors/types";

const usageOutput = [
  "Current session",
  "3% used",
  "Resets 3:10am (Asia/Seoul)",
  "Current week (all models)",
  "20% used",
  "Resets Jul 20, 4pm (Asia/Seoul)",
].join("\n");

describe("Claude collector compatibility", () => {
  it("uses flat screen-reader output when the installed CLI supports it", async () => {
    const ptyRunner = successfulPty();
    const result = await collectClaude(context(ptyRunner, true));

    expect(result.state).toBe("ok");
    expect(ptyRunner).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["--ax-screen-reader"] })
    );
    const options = vi.mocked(ptyRunner).mock.calls[0][0];
    expect(options.totalTimeoutMs).toBeGreaterThanOrEqual(45_000);
    expect(options.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ optional: true, waitFor: expect.any(RegExp) }),
      ])
    );
  });

  it("falls back to the legacy interactive output on older CLI versions", async () => {
    const ptyRunner = successfulPty();
    const result = await collectClaude(context(ptyRunner, false));

    expect(result.state).toBe("ok");
    expect(ptyRunner).toHaveBeenCalledWith(expect.objectContaining({ args: [] }));
  });
});

function successfulPty(): PtyRunner {
  return vi.fn(async (_options: RunPtyOptions) => ({
    rawOutput: usageOutput,
    cleanedOutput: usageOutput,
  })) as unknown as PtyRunner;
}

function context(ptyRunner: PtyRunner, supportsFlatOutput: boolean): CollectorContext {
  const commandRunner: CommandRunner = async (command, args) => {
    if (command === "where.exe") {
      return { stdout: "claude.cmd\n", stderr: "", exitCode: 0 };
    }
    if (command === "claude" && args[0] === "auth") {
      return {
        stdout: "loggedIn: true\nsubscriptionType: max\n",
        stderr: "",
        exitCode: 0,
      };
    }
    if (command === "claude" && args[0] === "--help") {
      return {
        stdout: supportsFlatOutput
          ? "Options:\n  --ax-screen-reader  Render flat text"
          : "Options:\n  --verbose  Enable verbose output",
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  return {
    rootDir: process.cwd(),
    config: DEFAULT_CONFIG,
    ptyRunner,
    commandRunner,
  };
}
