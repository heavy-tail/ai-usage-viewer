import { EventEmitter } from "node:events";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import { WINDOWS_JOB_HOST_PATH } from "../src/collectors/windowsJobHost";

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
      command: "C:\\Tools\\codex.exe",
      timeoutMs: 500,
      spawnProcess,
      platform: "win32",
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      WINDOWS_JOB_HOST_PATH,
      [
        "--pipe",
        String(process.pid),
        "C:\\Tools\\codex.exe",
        "C:\\repo",
        "app-server",
      ],
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
        command: process.execPath,
        timeoutMs: 20,
        spawnProcess,
      })
    ).rejects.toMatchObject<CodexAppServerError>({
      name: "CodexAppServerError",
      message: "Codex app-server timed out after 20ms.",
    });
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("rejects and terminates an app-server that exceeds its output limit", async () => {
    const child = new FakeChildProcess();
    readJsonLines(child.stdin, (message) => {
      if (message.method === "initialize") {
        child.stdout.write("x".repeat(512));
      }
    });

    await expect(
      readCodexAppServerRateLimits({
        cwd: process.cwd(),
        command: process.execPath,
        timeoutMs: 500,
        maxOutputBytes: 256,
        spawnProcess: (() =>
          child as unknown as ChildProcessWithoutNullStreams) as CodexAppServerSpawn,
      })
    ).rejects.toMatchObject<CodexAppServerError>({
      name: "CodexAppServerError",
      message: "Codex app-server output exceeded 256 bytes.",
    });
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("does not resolve until process cleanup is confirmed", async () => {
    const child = new FakeChildProcess();
    const payload = rateLimitPayload();
    let cleanupFinished = false;
    readJsonLines(child.stdin, (message) => {
      if (message.method === "initialize") {
        child.stdout.write('{"id":1,"result":{}}\n');
      }
      if (message.method === "account/rateLimits/read") {
        child.stdout.write(`${JSON.stringify({ id: 2, result: payload })}\n`);
      }
    });

    const result = await readCodexAppServerRateLimits({
      cwd: process.cwd(),
      command: process.execPath,
      spawnProcess: (() =>
        child as unknown as ChildProcessWithoutNullStreams) as CodexAppServerSpawn,
      terminateProcess: async (process) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        process.kill();
        cleanupFinished = true;
      },
    });

    expect(result.payload).toEqual(payload);
    expect(cleanupFinished).toBe(true);
  });

  it.skipIf(process.platform !== "win32")(
    "contains the real app-server process tree from launch through success",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usage-viewer-codex-app-"));
      const marker = join(directory, "orphan-marker.txt");
      const fixture = resolve("test", "fixtures", "codex-app-server.mjs");
      const previousMarker = process.env.USAGE_VIEWER_TEST_CODEX_ORPHAN_MARKER;
      process.env.USAGE_VIEWER_TEST_CODEX_ORPHAN_MARKER = marker;
      try {
        const result = await readCodexAppServerRateLimits({
          cwd: process.cwd(),
          command: process.execPath,
          commandArgs: [fixture],
          timeoutMs: 5_000,
        });
        expect(result.payload).toEqual({ fixture: true });
      } finally {
        if (previousMarker === undefined) {
          delete process.env.USAGE_VIEWER_TEST_CODEX_ORPHAN_MARKER;
        } else {
          process.env.USAGE_VIEWER_TEST_CODEX_ORPHAN_MARKER = previousMarker;
        }
      }

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_300));
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
    12_000
  );
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

  it("rejects millisecond reset timestamps where epoch seconds are required", () => {
    expect(() =>
      parseCodexAppServerRateLimits(
        {
          rateLimits: {
            limitId: "codex",
            primary: {
              usedPercent: 25,
              windowDurationMins: 300,
              resetsAt: 1_730_947_200_000,
            },
          },
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

  it("surfaces a hard stop even when the percentage gauge is low", () => {
    const limits = parseCodexAppServerRateLimits(
      {
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: 12,
            windowDurationMins: 300,
            resetsAt: null,
          },
          secondary: null,
          rateLimitReachedType: "workspace_member_usage_limit_reached",
        },
        rateLimitsByLimitId: null,
      },
      meta
    );

    expect(limits[0]).toMatchObject({
      usedPercent: 12,
      status: "exhausted",
      blockingReason: "Workspace usage limit reached",
    });
  });

  it("does not downgrade a single-view workspace hard stop when multi-bucket data exists", () => {
    const payload = rateLimitPayload();
    const single = payload.rateLimits as Record<string, unknown>;
    single.rateLimitReachedType = "workspace_member_usage_limit_reached";
    const buckets = payload.rateLimitsByLimitId as Record<
      string,
      Record<string, unknown>
    >;
    buckets.codex.rateLimitReachedType = null;
    buckets.codex_other.rateLimitReachedType = null;

    const limits = parseCodexAppServerRateLimits(payload, meta);

    expect(limits).not.toHaveLength(0);
    expect(limits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "codex:5h",
          status: "exhausted",
          blockingReason: "Workspace usage limit reached",
        }),
        expect.objectContaining({
          id: "codex:codex-other:1h",
          status: "exhausted",
          blockingReason: "Workspace usage limit reached",
        }),
      ])
    );
  });

  it("supports the forward-compatible spend-control hard stop", () => {
    const limits = parseCodexAppServerRateLimits(
      {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 1, windowDurationMins: 300 },
        },
        spendControlReached: true,
      },
      meta
    );

    expect(limits[0]).toMatchObject({
      status: "exhausted",
      blockingReason: "Workspace spending limit reached",
    });
  });

  it("applies the current per-bucket spend-control hard stop only to its bucket", () => {
    const payload = rateLimitPayload();
    const buckets = payload.rateLimitsByLimitId as Record<
      string,
      Record<string, unknown>
    >;
    buckets.codex.spendControlReached = false;
    buckets.codex_other.spendControlReached = true;

    const limits = parseCodexAppServerRateLimits(payload, meta);
    expect(limits.find((limit) => limit.id === "codex:5h")).toMatchObject({
      status: "available",
    });
    expect(
      limits.find((limit) => limit.id === "codex:codex-other:1h")
    ).toMatchObject({
      status: "exhausted",
      blockingReason: "Workspace spending limit reached",
    });
  });

  it("rejects map-key mismatches and duplicate semantic windows", () => {
    const mismatched = rateLimitPayload();
    const mismatchedBuckets = mismatched.rateLimitsByLimitId as Record<
      string,
      Record<string, unknown>
    >;
    mismatchedBuckets.codex.limitId = "different";
    expect(() => parseCodexAppServerRateLimits(mismatched, meta)).toThrow(
      ParserDriftError
    );

    const duplicate = rateLimitPayload();
    const duplicateBuckets = duplicate.rateLimitsByLimitId as Record<
      string,
      Record<string, unknown>
    >;
    duplicateBuckets.codex.secondary = {
      usedPercent: 40,
      windowDurationMins: 300,
      resetsAt: 1_730_947_200,
    };
    expect(() => parseCodexAppServerRateLimits(duplicate, meta)).toThrow(
      ParserDriftError
    );
  });

  it("fails closed on unknown hard-stop values and non-usage fields", () => {
    expect(() =>
      parseCodexAppServerRateLimits(
        {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 10, windowDurationMins: 300 },
            rateLimitReachedType: "new_unknown_reason",
          },
        },
        meta
      )
    ).toThrow(ParserDriftError);

    expect(() =>
      parseCodexAppServerRateLimits(
        {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 10, windowDurationMins: 300 },
          },
          spendControlReached: "yes",
        },
        meta
      )
    ).toThrow(ParserDriftError);

    expect(() =>
      parseCodexAppServerRateLimits(
        {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 10, windowDurationMins: 300 },
            undocumentedFlag: false,
          },
        },
        meta
      )
    ).toThrow(ParserDriftError);
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

  it("does not promote a terminal subset when app-server fails", async () => {
    const ptyRunner = vi.fn() as unknown as PtyRunner;
    const result = await collectCodex(collectorContext(ptyRunner), {
      appServerReader: async () => {
        throw new CodexAppServerError("Method not found");
      },
    });

    expect(result.state).toBe("unavailable");
    expect(result.limits).toEqual([]);
    expect(ptyRunner).not.toHaveBeenCalled();
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
    if (command.toLowerCase().endsWith("\\where.exe")) {
      return { stdout: "codex.cmd\n", stderr: "", exitCode: 0 };
    }
    if (/codex(?:\.exe|\.cmd)?$/i.test(command)) {
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
