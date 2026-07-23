import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
        expect.objectContaining({
          optional: true,
          waitFor: expect.any(RegExp),
          delayMs: 250,
        }),
      ])
    );
    expect(
      options.steps.some(
        (step) =>
          step.optional === true &&
          step.waitFor instanceof RegExp &&
          step.waitFor.test("What's contributing to your limits usage?")
      )
    ).toBe(true);
  });

  it("falls back to the legacy interactive output on older CLI versions", async () => {
    const ptyRunner = successfulPty();
    const result = await collectClaude(context(ptyRunner, false));

    expect(result.state).toBe("ok");
    expect(ptyRunner).toHaveBeenCalledWith(expect.objectContaining({ args: [] }));
  });

  it("does not mark Claude's cached fallback usage as newly verified", async () => {
    const cachedOutput = `${usageOutput}\nShowing last-known usage as of 3m ago (could not refresh)`;
    const ptyRunner = vi.fn(async () => ({
      rawOutput: cachedOutput,
      cleanedOutput: cachedOutput,
    })) as unknown as PtyRunner;

    const result = await collectClaude(context(ptyRunner, true));

    expect(result).toMatchObject({
      ok: false,
      state: "unavailable",
      limits: [],
      error: "Claude CLI could not refresh its usage data.",
    });
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
    if (command.toLowerCase().endsWith("\\where.exe")) {
      return { stdout: "claude.cmd\n", stderr: "", exitCode: 0 };
    }
    if (/claude(?:\.exe|\.cmd)?$/i.test(command) && args[0] === "auth") {
      return {
        stdout: "loggedIn: true\nsubscriptionType: max\n",
        stderr: "",
        exitCode: 0,
      };
    }
    if (/claude(?:\.exe|\.cmd)?$/i.test(command) && args[0] === "--help") {
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
