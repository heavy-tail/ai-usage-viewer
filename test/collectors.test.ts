import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config";
import { collectAgy } from "../src/collectors/agy";
import { AgyRpcError } from "../src/collectors/agyRpc";
import { collectClaude } from "../src/collectors/claude";
import { collectCodex } from "../src/collectors/codex";
import { CodexAppServerError } from "../src/collectors/codexAppServer";
import { collectGrok } from "../src/collectors/grok";
import { PtyTimeoutError } from "../src/collectors/errors";
import type { PtyRunner } from "../src/collectors/pty";
import type { CollectorContext, CommandRunner } from "../src/collectors/types";

describe("Collectors with mocked provider output", () => {
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

    const result = await collectCodex(context({ ptyRunner }), {
      appServerReader: async () => {
        throw new CodexAppServerError("app-server unavailable in TUI fallback test");
      },
    });

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

    const result = await collectCodex(context({ ptyRunner }), {
      appServerReader: async () => {
        throw new CodexAppServerError("app-server unavailable in TUI fallback test");
      },
    });

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

  it("maps AGY local service failure to collector error", async () => {
    const ptyRunner = vi.fn() as unknown as PtyRunner;
    const result = await collectAgy(context({ ptyRunner }), {
      rpcReader: async () => {
        throw new AgyRpcError("exited early", "process");
      },
    });

    expect(result.state).toBe("error");
    expect(result.error).toBe("exited early");
    expect(result.rawText).toBe("");
    expect(ptyRunner).not.toHaveBeenCalled();
  });

  it("maps parser drift to drift state", async () => {
    const ptyRunner = vi.fn() as unknown as PtyRunner;
    const result = await collectAgy(context({ ptyRunner }), {
      rpcReader: async () => ({
        payload: { response: { groups: [] } },
      }),
    });

    expect(result.state).toBe("drift");
    expect(result.error).toContain("no quota groups");
    expect(result.cleanedText).toContain("redacted");
  });

  it("collects AGY's structured quota without starting a PTY", async () => {
    const ptyRunner = vi.fn() as unknown as PtyRunner;
    const result = await collectAgy(context({ ptyRunner }), {
      rpcReader: async () => ({
        payload: {
          response: {
            groups: [
              {
                displayName: "Gemini Models",
                buckets: [
                  { window: "weekly", remainingFraction: 1 },
                  { window: "5h", remainingFraction: 0.8 },
                ],
              },
            ],
          },
        },
      }),
    });

    expect(result.state).toBe("ok");
    expect(result.limits).toHaveLength(2);
    expect(result.cleanedText).toContain("agy local quota API");
    expect(ptyRunner).not.toHaveBeenCalled();
  });

  it("recognizes Grok's current ready footer and collects both quota rows", async () => {
    const ptyRunner = vi.fn(async (options) => {
      expect(options.steps[0]?.waitFor).toBeInstanceOf(RegExp);
      expect((options.steps[0]?.waitFor as RegExp).test("Weekly limit left: 17%"))
        .toBe(true);
      return {
        rawOutput: "Weekly limit left: 17%\nMonthly limit: 30%",
        cleanedOutput: "Weekly limit left: 17%\nMonthly limit: 30%",
      };
    }) as unknown as PtyRunner;

    const result = await collectGrok(context({ ptyRunner }));

    expect(result.state).toBe("ok");
    expect(result.limits.map((limit) => limit.id)).toEqual([
      "grok:weekly",
      "grok:monthly",
    ]);
  });

  it("keeps Grok's fresh weekly footer when the detail command changes", async () => {
    const footer = "Grok 4.5 (high)\n>\n[stable] Weekly limit left: 0%";
    const ptyRunner = vi.fn(async () => {
      throw new PtyTimeoutError("detail timed out", footer, footer);
    }) as unknown as PtyRunner;

    const result = await collectGrok(context({ ptyRunner }));

    expect(result.state).toBe("ok");
    expect(result.limits).toHaveLength(1);
    expect(result.limits[0]).toMatchObject({
      id: "grok:weekly",
      remainingPercent: 0,
      usedPercent: 100,
    });
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
        stdout: available ? `C:\\Tools\\${args[0]}.exe\n` : "",
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
