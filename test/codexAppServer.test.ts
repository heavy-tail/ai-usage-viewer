import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config";
import {
  CodexAppServerError,
  readCodexAppServerRateLimits,
  type CodexAppServerSpawn,
} from "../src/collectors/codexAppServer";
import { collectCodex } from "../src/collectors/codex";
import type { PtyRunner } from "../src/collectors/pty";
import type { CollectorContext, CommandRunner } from "../src/collectors/types";
import { parseCodexAppServerRateLimits } from "../src/parsers/codex";
import { ParserDriftError } from "../src/parsers/errors";
import packageMetadata from "../package.json";

const checkedAt = "2026-07-18T00:00:00.000Z";
const meta = {
  checkedAt,
  sourceCommand: "codex app-server -> account/rateLimits/read",
  planLabel: "ChatGPT",
};

describe("Codex app-server JSON-RPC client", () => {
  it("initializes before reading rate limits and terminates the child", async () => {
    const child = new FakeChildProcess();
    const messages: Array<Record<string, unknown>> = [];
    const payload = rateLimitPayload();

    readJsonLines(child.stdin, (message) => {
      messages.push(message);
      if (message.method === "initialize") {
        child.stdout.write('{"id":1,"result":{"userAgent":"codex-test"}}\n');
      }
      if (message.method === "account/rateLimits/read") {
        child.stdout.write(`${JSON.stringify({ id: 2, result: payload })}\n`);
      }
    });

    const spawnProcess = vi.fn(() =>
      child as unknown as ChildProcessWithoutNullStreams
    ) as unknown as CodexAppServerSpawn;
    const result = await readCodexAppServerRateLimits({
      cwd: "C:\\repo",
      timeoutMs: 500,
      spawnProcess,
      platform: "win32",
      windowsCommandShell: "C:\\Windows\\System32\\cmd.exe",
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", "codex app-server"],
      expect.objectContaining({
        cwd: "C:\\repo",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      })
    );
    expect(messages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "account/rateLimits/read",
    ]);
    expect(messages[0]).toMatchObject({
      id: 1,
      params: {
        clientInfo: {
          name: "usage_viewer",
          title: "AI Usage Viewer",
          version: packageMetadata.version,
        },
      },
    });
    expect(messages[1]).not.toHaveProperty("id");
    expect(messages[2]).toMatchObject({ id: 2 });
    expect(result.payload).toEqual(payload);
    expect(JSON.parse(result.rawText)).toEqual(payload);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("times out and kills an app-server that does not respond", async () => {
    const child = new FakeChildProcess();
    const spawnProcess = (() =>
      child as unknown as ChildProcessWithoutNullStreams
    ) as CodexAppServerSpawn;

    await expect(
      readCodexAppServerRateLimits({
        cwd: process.cwd(),
        timeoutMs: 20,
        spawnProcess,
      })
    ).rejects.toMatchObject<CodexAppServerError>({
      name: "CodexAppServerError",
      message: "Codex app-server timed out after 20ms.",
    });
    expect(child.kill).toHaveBeenCalledOnce();
  });
});

describe("Codex structured rate-limit parser", () => {
  it("maps every bucket and window from the multi-bucket response", () => {
    const limits = parseCodexAppServerRateLimits(rateLimitPayload(), meta);

    expect(limits).toHaveLength(4);
    expect(limits.find((limit) => limit.id === "codex:5h")).toMatchObject({
      scope: "5h limit",
      window: "5h",
      usedPercent: 25,
      remainingPercent: 75,
      resetLabel: `Resets ${new Date(1_730_947_200_000).toISOString()}`,
      resetAt: new Date(1_730_947_200_000).toISOString(),
      planLabel: "Pro",
    });
    expect(limits.find((limit) => limit.id === "codex:weekly")).toMatchObject({
      scope: "Weekly limit",
      window: "weekly",
      usedPercent: 60,
      remainingPercent: 40,
    });
    expect(
      limits.find((limit) => limit.id === "codex:codex-other:1h")
    ).toMatchObject({
      scope: "Codex Other 1h limit",
      window: "1h",
      usedPercent: 42,
      remainingPercent: 58,
      statusLabel: "Codex Other",
    });
    expect(limits.find((limit) => limit.id === "codex:individual")).toMatchObject({
      scope: "Individual usage limit",
      window: "spend-control",
      usedPercent: 20,
      remainingPercent: 80,
      statusLabel: "$2 of $10",
      resetLabel: `Resets ${new Date(1_731_551_400_000).toISOString()}`,
    });
  });

  it("rejects an invalid window instead of returning a partial result", () => {
    const payload = {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null },
        secondary: { usedPercent: 101, windowDurationMins: 10_080, resetsAt: null },
      },
      rateLimitsByLimitId: null,
    };

    expect(() => parseCodexAppServerRateLimits(payload, meta)).toThrow(
      ParserDriftError
    );
  });

  it("rejects malformed buckets and individual limits", () => {
    expect(() =>
      parseCodexAppServerRateLimits(
        {
          rateLimits: {
            limitId: "codex",
            primary: null,
            secondary: null,
            individualLimit: {
              limit: "$10",
              used: "$2",
              remainingPercent: "80",
              resetsAt: 1_731_551_400,
            },
          },
        },
        meta
      )
    ).toThrow(ParserDriftError);

    expect(() =>
      parseCodexAppServerRateLimits(
        {
          rateLimits: { limitId: "codex", primary: null, secondary: null },
          rateLimitsByLimitId: { codex_other: "not-a-bucket" },
        },
        meta
      )
    ).toThrow(ParserDriftError);
  });

  it("rejects a newly added percentage window instead of silently omitting it", () => {
    const payload = rateLimitPayload();
    const buckets = payload.rateLimitsByLimitId as Record<
      string,
      Record<string, unknown>
    >;
    buckets.codex.tertiary = {
      usedPercent: 12,
      windowDurationMins: 43_200,
      resetsAt: 1_731_551_400,
    };

    expect(() => parseCodexAppServerRateLimits(payload, meta)).toThrow(
      ParserDriftError
    );
  });

  it("rejects percentage windows nested inside an unknown array", () => {
    const payload = rateLimitPayload();
    const buckets = payload.rateLimitsByLimitId as Record<
      string,
      Record<string, unknown>
    >;
    buckets.codex.experimentalWindows = [{ usedPercent: 12 }];

    expect(() => parseCodexAppServerRateLimits(payload, meta)).toThrow(
      ParserDriftError
    );
  });

  it("rejects unknown percentages inside recognized structured records", () => {
    const payload = rateLimitPayload();
    const buckets = payload.rateLimitsByLimitId as Record<
      string,
      Record<string, unknown>
    >;
    (buckets.codex.primary as Record<string, unknown>).remainingPercent = 75;

    expect(() => parseCodexAppServerRateLimits(payload, meta)).toThrow(
      ParserDriftError
    );
  });
});

describe("Codex collector app-server preference", () => {
  it("uses structured quota without starting a terminal session", async () => {
    const ptyRunner = vi.fn() as unknown as PtyRunner;
    const payload = rateLimitPayload();
    const result = await collectCodex(collectorContext(ptyRunner), {
      appServerReader: async () => ({
        payload,
        rawText: JSON.stringify(payload),
      }),
    });

    expect(result.state).toBe("ok");
    expect(result.limits.some((limit) => limit.id === "codex:5h")).toBe(true);
    expect(result.limits[0]?.sourceCommand).toBe(
      "codex app-server -> account/rateLimits/read"
    );
    expect(ptyRunner).not.toHaveBeenCalled();
  });

  it("falls back to the existing terminal collector when app-server fails", async () => {
    const footer =
      "gpt-5.5 - Context 100% left - 5h 97% left - weekly 76% left";
    const ptyRunner = vi.fn(async () => ({
      rawOutput: footer,
      cleanedOutput: footer,
    })) as unknown as PtyRunner;
    const result = await collectCodex(collectorContext(ptyRunner), {
      appServerReader: async () => {
        throw new CodexAppServerError("Method not found");
      },
    });

    expect(result.state).toBe("ok");
    expect(result.limits.find((limit) => limit.id === "codex:5h")).toMatchObject({
      remainingPercent: 97,
    });
    expect(ptyRunner).toHaveBeenCalledOnce();
  });

  it("fails closed when app-server returns an incomplete structured payload", async () => {
    const footer =
      "gpt-5.5 - Context 100% left - 5h 95% left - weekly 70% left";
    const ptyRunner = vi.fn(async () => ({
      rawOutput: footer,
      cleanedOutput: footer,
    })) as unknown as PtyRunner;
    const result = await collectCodex(collectorContext(ptyRunner), {
      appServerReader: async () => ({
        payload: {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 5, windowDurationMins: 300 },
            secondary: { usedPercent: "missing" },
          },
        },
        rawText: "malformed structured payload",
      }),
    });

    expect(result.state).toBe("drift");
    expect(result.limits).toEqual([]);
    expect(ptyRunner).not.toHaveBeenCalled();
  });
});

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  readonly kill = vi.fn(() => {
    this.killed = true;
    this.exitCode = 0;
    this.emit("exit", 0, null);
    return true;
  });
}

function readJsonLines(
  stream: PassThrough,
  onMessage: (message: Record<string, unknown>) => void
): void {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) onMessage(JSON.parse(line) as Record<string, unknown>);
    }
  });
}

function collectorContext(ptyRunner: PtyRunner): CollectorContext {
  return {
    rootDir: process.cwd(),
    config: DEFAULT_CONFIG,
    ptyRunner,
    commandRunner: commandRunner(),
  };
}

function commandRunner(): CommandRunner {
  return async (command) => {
    if (command === "where.exe") {
      return { stdout: "codex.cmd\n", stderr: "", exitCode: 0 };
    }
    if (command === "codex") {
      return { stdout: "Logged in using ChatGPT\n", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}

function rateLimitPayload(): Record<string, unknown> {
  return {
    // The multi-bucket view must win over this compatibility field.
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 99, windowDurationMins: 300 },
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        limitName: null,
        planType: "pro",
        primary: {
          usedPercent: 25,
          windowDurationMins: 300,
          resetsAt: 1_730_947_200,
        },
        secondary: {
          usedPercent: 60,
          windowDurationMins: 10_080,
          resetsAt: 1_731_551_400,
        },
        individualLimit: {
          limit: "$10",
          used: "$2",
          remainingPercent: 80,
          resetsAt: 1_731_551_400,
        },
        rateLimitReachedType: null,
      },
      codex_other: {
        limitId: "codex_other",
        limitName: "Codex Other",
        primary: {
          usedPercent: 42,
          windowDurationMins: 60,
          resetsAt: 1_730_950_800,
        },
        secondary: null,
        rateLimitReachedType: null,
      },
    },
  };
}
