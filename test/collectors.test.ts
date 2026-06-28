import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config";
import { collectAgy } from "../src/collectors/agy";
import { collectClaude } from "../src/collectors/claude";
import { collectCodex } from "../src/collectors/codex";
import { PtyProcessError, PtyTimeoutError } from "../src/collectors/errors";
import type { PtyRunner } from "../src/collectors/pty";
import type { CollectorContext, CommandRunner } from "../src/collectors/types";

describe("PTY collectors with mocked process output", () => {
  it("returns unavailable when a CLI is missing", async () => {
    const ptyRunner = vi.fn() as unknown as PtyRunner;
    const result = await collectClaude(context({ available: false, ptyRunner }));

    expect(result.state).toBe("unavailable");
    expect(result.error).toContain("not installed");
    expect(ptyRunner).not.toHaveBeenCalled();
  });

  it("maps PTY timeout to collector error", async () => {
    const ptyRunner = vi.fn(async () => {
      throw new PtyTimeoutError("timed out", "raw timeout", "clean timeout");
    }) as unknown as PtyRunner;

    const result = await collectCodex(context({ ptyRunner }));

    expect(result.state).toBe("error");
    expect(result.error).toBe("timed out");
    expect(result.cleanedText).toBe("clean timeout");
  });

  it("keeps Codex footer quota when status enrichment times out", async () => {
    const footer =
      "gpt-5.5 xhigh fast · Context 100% left · 5h 97% left · weekly 76% left";
    const ptyRunner = vi.fn(async () => {
      throw new PtyTimeoutError(
        "PTY timeout waiting for /Weekly limit:/i.",
        footer,
        footer
      );
    }) as unknown as PtyRunner;

    const result = await collectCodex(context({ ptyRunner }));

    expect(result.state).toBe("ok");
    expect(result.error).toBeUndefined();
    expect(result.limits.find((limit) => limit.id === "codex:5h")).toMatchObject({
      remainingPercent: 97,
      resetLabel: undefined,
    });
    expect(result.limits.find((limit) => limit.id === "codex:weekly")).toMatchObject({
      remainingPercent: 76,
      resetLabel: undefined,
    });
  });

  it("maps PTY process failure to collector error", async () => {
    const ptyRunner = vi.fn(async () => {
      throw new PtyProcessError("exited early", "raw error", "clean error");
    }) as unknown as PtyRunner;

    const result = await collectAgy(context({ ptyRunner }));

    expect(result.state).toBe("error");
    expect(result.error).toBe("exited early");
    expect(result.rawText).toBe("raw error");
  });

  it("maps parser drift to drift state", async () => {
    const ptyRunner = vi.fn(async () => ({
      rawOutput: "Models & Quota\nNo known model groups",
      cleanedOutput: "Models & Quota\nNo known model groups",
    })) as unknown as PtyRunner;

    const result = await collectAgy(context({ ptyRunner }));

    expect(result.state).toBe("drift");
    expect(result.error).toContain("no recognized quota groups");
    expect(result.cleanedText).toContain("Models & Quota");
  });
});

function context(input: {
  available?: boolean;
  ptyRunner: PtyRunner;
}): CollectorContext {
  return {
    rootDir: process.cwd(),
    config: DEFAULT_CONFIG,
    ptyRunner: input.ptyRunner,
    commandRunner: commandRunner(input.available ?? true),
  };
}

function commandRunner(available: boolean): CommandRunner {
  return async (command, args) => {
    if (command === "where.exe") {
      return {
        stdout: available ? `${args[0]}.cmd\n` : "",
        stderr: "",
        exitCode: available ? 0 : 1,
      };
    }
    if (command === "codex") {
      return { stdout: "Logged in using ChatGPT\n", stderr: "", exitCode: 0 };
    }
    if (command === "claude") {
      return {
        stdout:
          "loggedIn: true\nsubscriptionType: max\nemail: test@example.com\n",
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}
