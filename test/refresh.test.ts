import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createRefreshService, RefreshInProgressError } from "../src/refresh";
import type { ProviderCollector } from "../src/collectors/types";
import type { UsageLimit, UsageProvider } from "../src/types";

describe("refresh service", () => {
  it("rejects concurrent refreshes with the refresh lock", async () => {
    const rootDir = await tempWorkspace(["claude"]);
    const service = createRefreshService();
    const slowCollector: ProviderCollector = async () => {
      await sleep(60);
      return okResult("claude", [limit("claude")]);
    };

    const first = service.refresh({
      rootDir,
      collectors: { claude: slowCollector },
    });
    await expect(
      service.refresh({ rootDir, collectors: { claude: slowCollector } })
    ).rejects.toBeInstanceOf(RefreshInProgressError);
    await first;
  });

  it("rejects concurrent refreshes from separate service instances", async () => {
    const rootDir = await tempWorkspace(["claude"]);
    const firstService = createRefreshService();
    const secondService = createRefreshService();
    let started!: () => void;
    let finish!: () => void;
    const collectorStarted = new Promise<void>((resolve) => (started = resolve));
    const collectorCanFinish = new Promise<void>((resolve) => (finish = resolve));
    const slowCollector: ProviderCollector = async () => {
      started();
      await collectorCanFinish;
      return okResult("claude", [limit("claude")]);
    };

    const first = firstService.refresh({
      rootDir,
      collectors: { claude: slowCollector },
    });
    await collectorStarted;
    await expect(
      secondService.refresh({
        rootDir,
        collectors: { claude: slowCollector },
      })
    ).rejects.toBeInstanceOf(RefreshInProgressError);
    finish();
    await first;
  });

  it("persists a snapshot when one provider fails", async () => {
    const rootDir = await tempWorkspace(["claude", "codex"]);
    const service = createRefreshService();
    const snapshot = await service.refresh({
      rootDir,
      collectors: {
        claude: async () => okResult("claude", [limit("claude")]),
        codex: async () => ({
          provider: "codex",
          ok: false,
          state: "error",
          checkedAt: "2026-06-03T12:00:01.000Z",
          durationMs: 20,
          limits: [],
          rawText: "raw error",
          cleanedText: "clean error",
          rawFileName: "codex-default.txt",
          error: "mock failure",
        }),
      },
    });

    expect(snapshot.collectors.find((c) => c.provider === "claude")?.state).toBe(
      "ok"
    );
    expect(snapshot.collectors.find((c) => c.provider === "claude")?.enabled).toBe(
      true
    );
    expect(snapshot.collectors.find((c) => c.provider === "codex")?.state).toBe(
      "error"
    );
    expect(snapshot.limits).toHaveLength(1);
    expect(snapshot.timezone).toBe("Asia/Seoul");
    expect(snapshot.limits[0].freshness).toBe("verified");

    const stored = JSON.parse(
      await readFile(join(rootDir, "data", "usage-snapshot.json"), "utf8")
    );
    expect(stored.limits[0].accountLabel).toBe("<redacted-email>");
    await expect(
      readFile(join(rootDir, "data", "raw", "codex-default.txt"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    const compatibility = JSON.parse(
      await readFile(join(rootDir, "data", "compatibility-report.json"), "utf8")
    ) as { passed: boolean; providers: Array<{ provider: string; passed: boolean }> };
    expect(compatibility.passed).toBe(false);
    expect(compatibility.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "claude", passed: true }),
        expect.objectContaining({ provider: "codex", passed: false }),
      ])
    );
  });

  it("starts AGY first, then runs terminal collectors concurrently", async () => {
    const rootDir = await tempWorkspace(["claude", "codex", "agy", "grok"]);
    const service = createRefreshService();
    const events: string[] = [];

    await service.refresh({
      rootDir,
      collectors: {
        claude: orderedCollector("claude", events),
        codex: orderedCollector("codex", events),
        agy: orderedCollector("agy", events),
        grok: orderedCollector("grok", events),
      },
    });

    expect(events).toHaveLength(8);
    expect(events.slice(0, 2)).toEqual(["start:agy", "end:agy"]);
    // Once AGY has established and released its private service, every terminal
    // collector starts before any of them ends, proving they still overlap.
    expect(events.slice(2, 5).every((event) => event.startsWith("start:"))).toBe(
      true
    );
    expect(events.filter((event) => event.startsWith("start:")).sort()).toEqual([
      "start:agy",
      "start:claude",
      "start:codex",
      "start:grok",
    ]);
  });

  it("preserves unrelated provider health during provider-specific refresh", async () => {
    const rootDir = await tempWorkspace(["claude", "codex"]);
    const service = createRefreshService();

    await service.refresh({
      rootDir,
      collectors: {
        claude: async () => okResult("claude", [limit("claude")]),
        codex: async () => okResult("codex", [limit("codex")]),
      },
    });

    const snapshot = await service.refresh({
      rootDir,
      provider: "codex",
      collectors: {
        codex: async () => okResult("codex", [limit("codex")]),
      },
    });

    expect(snapshot.collectors.find((c) => c.provider === "claude")).toMatchObject({
      ok: true,
      state: "ok",
    });
    expect(snapshot.limits.some((item) => item.provider === "claude")).toBe(true);
  });

  it("does not overwrite a full-run compatibility report on provider-only refresh", async () => {
    const rootDir = await tempWorkspace(["claude", "codex"]);
    const service = createRefreshService();

    await service.refresh({
      rootDir,
      collectors: {
        claude: async () => okResult("claude", [limit("claude")]),
        codex: async () => okResult("codex", [limit("codex")]),
      },
    });
    const reportPath = join(rootDir, "data", "compatibility-report.json");
    const fullRunReport = await readFile(reportPath, "utf8");
    expect(JSON.parse(fullRunReport)).toMatchObject({ passed: true });

    const partialSnapshot = await service.refresh({
      rootDir,
      provider: "codex",
      collectors: {
        codex: async () => ({
          provider: "codex",
          ok: false,
          state: "drift",
          checkedAt: "2026-06-03T12:00:01.000Z",
          durationMs: 20,
          limits: [],
          rawText: "raw drift",
          cleanedText: "clean drift",
          rawFileName: "codex-default.txt",
          error: "mock drift",
        }),
      },
    });

    expect(
      partialSnapshot.collectors.find((item) => item.provider === "codex")
    ).toMatchObject({ ok: false, state: "stale", attemptState: "drift" });
    await expect(readFile(reportPath, "utf8")).resolves.toBe(fullRunReport);
  });

  it("rejects a collector result whose provider does not match its route", async () => {
    const rootDir = await tempWorkspace(["claude"]);
    const service = createRefreshService();

    await service.refresh({
      rootDir,
      collectors: {
        claude: async () => okResult("claude", [limit("claude")]),
      },
    });
    const snapshot = await service.refresh({
      rootDir,
      collectors: {
        claude: async () => okResult("codex", [limit("codex")]),
      },
    });

    expect(
      snapshot.collectors.find((item) => item.provider === "claude")
    ).toMatchObject({
      ok: false,
      state: "stale",
      attemptState: "drift",
      error: expect.stringContaining(
        'collector routed for "claude" returned provider "codex"'
      ),
    });
    expect(snapshot.limits).toHaveLength(1);
    expect(snapshot.timezone).toBe("Asia/Seoul");
    expect(snapshot.limits[0].freshness).toBe("stale");
    expect(snapshot.limits[0]).toMatchObject({
      id: "claude:limit",
      provider: "claude",
    });
  });

  it("does not stack stale prefixes after repeated failed refreshes", async () => {
    const rootDir = await tempWorkspace(["grok"]);
    const service = createRefreshService();
    const failingGrok: ProviderCollector = async () => ({
      provider: "grok",
      ok: false,
      state: "error",
      checkedAt: "2026-06-03T12:00:01.000Z",
      durationMs: 20,
      limits: [],
      rawText: "raw error",
      cleanedText: "clean error",
      rawFileName: "grok.txt",
      error: "mock failure",
    });

    await service.refresh({
      rootDir,
      collectors: {
        grok: async () => okResult("grok", [
          { ...limit("grok"), statusLabel: "previous detail" },
        ]),
      },
    });

    const firstFailure = await service.refresh({
      rootDir,
      collectors: { grok: failingGrok },
    });
    const secondFailure = await service.refresh({
      rootDir,
      collectors: { grok: failingGrok },
    });

    expect(firstFailure.limits[0].statusLabel).toBe("stale - previous detail");
    expect(secondFailure.limits[0].statusLabel).toBe("stale - previous detail");
  });

  it("keeps stale usage rows graded by their saved percentages", async () => {
    const rootDir = await tempWorkspace(["claude"]);
    const service = createRefreshService();

    await service.refresh({
      rootDir,
      collectors: {
        claude: async () => okResult("claude", [
          { ...limit("claude"), usedPercent: 3, remainingPercent: 97, statusLabel: "stale" },
        ]),
      },
    });

    const snapshot = await service.refresh({
      rootDir,
      collectors: {
        claude: async () => ({
          provider: "claude",
          ok: false,
          state: "drift",
          checkedAt: "2026-06-03T12:00:01.000Z",
          durationMs: 20,
          limits: [],
          rawText: "raw drift",
          cleanedText: "clean drift",
          rawFileName: "claude.txt",
          error: "mock drift",
        }),
      },
    });

    expect(snapshot.limits[0]).toMatchObject({
      usedPercent: 3,
      remainingPercent: 97,
      status: "available",
      statusLabel: "stale",
      freshness: "stale",
    });
  });

  it("preserves a verified hard stop when a later refresh fails", async () => {
    const rootDir = await tempWorkspace(["codex"]);
    const service = createRefreshService();

    await service.refresh({
      rootDir,
      collectors: {
        codex: async () =>
          okResult("codex", [
            {
              ...limit("codex"),
              usedPercent: 3,
              remainingPercent: 97,
              status: "exhausted",
              blockingReason: "Workspace usage limit reached",
            },
          ]),
      },
    });

    const snapshot = await service.refresh({
      rootDir,
      collectors: {
        codex: async () => ({
          provider: "codex",
          ok: false,
          state: "error",
          checkedAt: "2026-06-03T12:00:01.000Z",
          durationMs: 20,
          limits: [],
          rawText: "",
          cleanedText: "",
          rawFileName: "codex-default.txt",
          error: "mock failure",
        }),
      },
    });

    expect(snapshot.limits[0]).toMatchObject({
      status: "exhausted",
      blockingReason: "Workspace usage limit reached",
      freshness: "stale",
    });
  });

  it("keeps the last verified rows when a collector returns a false-green result", async () => {
    const rootDir = await tempWorkspace(["claude"]);
    const service = createRefreshService();

    await service.refresh({
      rootDir,
      collectors: {
        claude: async () => okResult("claude", [limit("claude")]),
      },
    });

    const snapshot = await service.refresh({
      rootDir,
      collectors: {
        claude: async () => okResult("claude", []),
      },
    });

    expect(snapshot.collectors.find((item) => item.provider === "claude")).toMatchObject({
      ok: false,
      state: "stale",
      attemptState: "drift",
      adapterVersion: "2.7.0",
      error: expect.stringContaining("Adapter contract rejected"),
    });
    expect(snapshot.limits).toHaveLength(1);
    expect(snapshot.limits[0].id).toBe("claude:limit");
  });

  it("keeps the last verified rows when quota row identities change", async () => {
    const rootDir = await tempWorkspace(["claude"]);
    const service = createRefreshService();

    await service.refresh({
      rootDir,
      collectors: {
        claude: async () => okResult("claude", [limit("claude")]),
      },
    });

    const snapshot = await service.refresh({
      rootDir,
      collectors: {
        claude: async () =>
          okResult("claude", [{ ...limit("claude"), id: "claude:new-limit" }]),
      },
    });

    expect(snapshot.collectors.find((item) => item.provider === "claude"))
      .toMatchObject({
        ok: false,
        state: "stale",
        attemptState: "drift",
        rowInventoryChanged: true,
      });
    expect(snapshot.limits).toEqual([
      expect.objectContaining({
        id: "claude:limit",
        freshness: "stale",
      }),
    ]);
    const report = JSON.parse(
      await readFile(join(rootDir, "data", "compatibility-report.json"), "utf8")
    ) as { passed: boolean };
    expect(report.passed).toBe(false);
  });

  it("accepts Claude's conditionally omitted model-specific row", async () => {
    const rootDir = await tempWorkspace(["claude"]);
    const service = createRefreshService();
    const core = limit("claude");

    await service.refresh({
      rootDir,
      collectors: {
        claude: async () =>
          okResult("claude", [
            core,
            {
              ...core,
              id: "claude:week-fable",
              scope: "Current week (Fable)",
              window: "weekly",
            },
          ]),
      },
    });
    const snapshot = await service.refresh({
      rootDir,
      collectors: {
        claude: async () => okResult("claude", [core]),
      },
    });

    expect(snapshot.collectors.find((item) => item.provider === "claude"))
      .toMatchObject({
        ok: true,
        state: "ok",
        rowInventoryChanged: false,
        formatChanged: false,
      });
    expect(snapshot.limits.map((row) => row.id)).toEqual(["claude:limit"]);
  });

  it("keeps the last verified rows when the provider format changes", async () => {
    const rootDir = await tempWorkspace(["claude"]);
    const service = createRefreshService();

    await service.refresh({
      rootDir,
      collectors: {
        claude: async () => okResult("claude", [limit("claude")]),
      },
    });

    const snapshot = await service.refresh({
      rootDir,
      collectors: {
        claude: async () => ({
          ...okResult("claude", [
            {
              ...limit("claude"),
              usedPercent: 40,
              remainingPercent: 60,
              sourceText: "a structurally different provider layout",
            },
          ]),
          rawText: "a structurally different provider layout",
          cleanedText: "a structurally different provider layout",
        }),
      },
    });

    expect(snapshot.collectors.find((item) => item.provider === "claude"))
      .toMatchObject({
        ok: false,
        state: "stale",
        attemptState: "drift",
        formatChanged: true,
      });
    expect(snapshot.limits).toEqual([
      expect.objectContaining({
        id: "claude:limit",
        usedPercent: 10,
        remainingPercent: 90,
        freshness: "stale",
      }),
    ]);
  });

  it("does not let an adapter version bump authorize an undeclared row change", async () => {
    const rootDir = await tempWorkspace(["claude"]);
    const service = createRefreshService();

    await service.refresh({
      rootDir,
      collectors: {
        claude: async () => okResult("claude", [limit("claude")]),
      },
    });
    const snapshotPath = join(rootDir, "data", "usage-snapshot.json");
    const previous = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      collectors: Array<{ provider: string; adapterVersion?: string }>;
    };
    const previousClaude = previous.collectors.find(
      (collector) => collector.provider === "claude"
    );
    if (!previousClaude) throw new Error("Claude fixture health is missing.");
    previousClaude.adapterVersion = "2.2.0";
    await writeFile(snapshotPath, JSON.stringify(previous), "utf8");

    const snapshot = await service.refresh({
      rootDir,
      collectors: {
        claude: async () => ({
          ...okResult("claude", [
            { ...limit("claude"), id: "claude:new-limit" },
          ]),
          rawText: "new adapter layout",
          cleanedText: "new adapter layout",
        }),
      },
    });

    expect(snapshot.collectors.find((item) => item.provider === "claude"))
      .toMatchObject({
        ok: false,
        state: "stale",
        attemptState: "drift",
        formatChanged: true,
        rowInventoryChanged: true,
      });
    expect(snapshot.limits).toEqual([
      expect.objectContaining({
        id: "claude:limit",
        freshness: "stale",
      }),
    ]);
    const report = JSON.parse(
      await readFile(join(rootDir, "data", "compatibility-report.json"), "utf8")
    ) as { passed: boolean };
    expect(report.passed).toBe(false);
  });

  it("publishes only the exact row transition declared by an adapter migration", async () => {
    const rootDir = await tempWorkspace(["claude"]);
    const service = createRefreshService({
      isRowInventoryMigrationApproved: (input) =>
        input.provider === "claude" &&
        input.fromAdapterVersion === "2.2.0" &&
        input.toAdapterVersion === "2.7.0" &&
        input.previousRowIds.join() === "claude:limit" &&
        input.currentRowIds.join() === "claude:new-limit",
    });

    await service.refresh({
      rootDir,
      collectors: {
        claude: async () => okResult("claude", [limit("claude")]),
      },
    });
    const snapshotPath = join(rootDir, "data", "usage-snapshot.json");
    const previous = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      collectors: Array<{ provider: string; adapterVersion?: string }>;
    };
    const previousClaude = previous.collectors.find(
      (collector) => collector.provider === "claude"
    );
    if (!previousClaude) throw new Error("Claude fixture health is missing.");
    previousClaude.adapterVersion = "2.2.0";
    await writeFile(snapshotPath, JSON.stringify(previous), "utf8");

    const snapshot = await service.refresh({
      rootDir,
      collectors: {
        claude: async () => ({
          ...okResult("claude", [
            { ...limit("claude"), id: "claude:new-limit" },
          ]),
          rawText: "new adapter layout",
          cleanedText: "new adapter layout",
        }),
      },
    });

    expect(snapshot.collectors.find((item) => item.provider === "claude"))
      .toMatchObject({
        ok: true,
        state: "ok",
        formatChanged: true,
        rowInventoryChanged: true,
      });
    expect(snapshot.limits).toEqual([
      expect.objectContaining({
        id: "claude:new-limit",
        freshness: "verified",
      }),
    ]);
  });

  it("does not consume an adapter upgrade when its first attempt fails", async () => {
    const rootDir = await tempWorkspace(["claude"]);
    const service = createRefreshService();

    await service.refresh({
      rootDir,
      collectors: {
        claude: async () => okResult("claude", [limit("claude")]),
      },
    });
    const snapshotPath = join(rootDir, "data", "usage-snapshot.json");
    const previous = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      collectors: Array<{
        provider: string;
        adapterVersion?: string;
        formatFingerprint?: string;
      }>;
    };
    const previousClaude = previous.collectors.find(
      (collector) => collector.provider === "claude"
    );
    if (!previousClaude) throw new Error("Claude fixture health is missing.");
    previousClaude.adapterVersion = "2.3.0";
    const verifiedFingerprint = previousClaude.formatFingerprint;
    await writeFile(snapshotPath, JSON.stringify(previous), "utf8");

    const failed = await service.refresh({
      rootDir,
      collectors: {
        claude: async () => ({
          provider: "claude",
          ok: false,
          state: "drift",
          checkedAt: "2026-06-03T12:00:01.000Z",
          durationMs: 20,
          limits: [],
          rawText: "incomplete upgraded frame",
          cleanedText: "incomplete upgraded frame",
          rawFileName: "claude.txt",
          error: "upgraded parser rejected an incomplete frame",
        }),
      },
    });
    expect(failed.collectors.find((item) => item.provider === "claude"))
      .toMatchObject({
        state: "stale",
        adapterVersion: "2.3.0",
        formatFingerprint: verifiedFingerprint,
      });

    const recovered = await service.refresh({
      rootDir,
      collectors: {
        claude: async () => ({
          ...okResult("claude", [limit("claude")]),
          rawText: "repaired upgraded layout",
          cleanedText: "repaired upgraded layout",
        }),
      },
    });
    expect(recovered.collectors.find((item) => item.provider === "claude"))
      .toMatchObject({
        ok: true,
        state: "ok",
        adapterVersion: "2.7.0",
      });
  });

  it("drops legacy Grok pay-as-you-go details from stale labels", async () => {
    const rootDir = await tempWorkspace(["grok"]);
    const service = createRefreshService();

    await service.refresh({
      rootDir,
      collectors: {
        grok: async () => okResult("grok", [
          { ...limit("grok"), statusLabel: "stale - pay-as-you-go disabled" },
        ]),
      },
    });

    const snapshot = await service.refresh({
      rootDir,
      collectors: {
        grok: async () => ({
          provider: "grok",
          ok: false,
          state: "error",
          checkedAt: "2026-06-03T12:00:01.000Z",
          durationMs: 20,
          limits: [],
          rawText: "raw error",
          cleanedText: "clean error",
          rawFileName: "grok.txt",
          error: "mock failure",
        }),
      },
    });

    expect(snapshot.limits[0].statusLabel).toBe("stale");
  });

  it("hides a provider after it is disabled in config on refresh-all", async () => {
    const rootDir = await tempWorkspace(["claude", "codex"]);
    const service = createRefreshService();

    await service.refresh({
      rootDir,
      collectors: {
        claude: async () => okResult("claude", [limit("claude")]),
        codex: async () => okResult("codex", [limit("codex")]),
      },
    });

    await writeFile(
      join(rootDir, "config.json"),
      JSON.stringify({
        enabledProviders: ["claude"],
        codex: { collectDefault: true, additionalModelsForContext: [] },
        agy: { pinnedGroups: [] },
        timezone: "Asia/Seoul",
        wsl: { cwd: ".", grokCommand: "grok" },
        planLabelFallback: { claude: "Max 200", codex: "ChatGPT" },
      }),
      "utf8"
    );

    const snapshot = await service.refresh({
      rootDir,
      collectors: {
        claude: async () => okResult("claude", [limit("claude")]),
      },
    });

    const codex = snapshot.collectors.find((c) => c.provider === "codex");
    expect(codex?.ok).toBe(false);
    expect(codex?.state).toBe("unavailable");
    expect(codex?.enabled).toBe(false);
    expect(snapshot.limits.some((l) => l.provider === "codex")).toBe(false);
  });
});

async function tempWorkspace(enabledProviders: UsageProvider[]): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "usage-viewer-"));
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "config.json"),
    JSON.stringify({
      enabledProviders,
      codex: { collectDefault: true, additionalModelsForContext: [] },
      agy: { pinnedGroups: [] },
      timezone: "Asia/Seoul",
      wsl: { cwd: ".", grokCommand: "grok" },
      planLabelFallback: { claude: "Max 200", codex: "ChatGPT" },
    }),
    "utf8"
  );
  return rootDir;
}

function okResult(provider: UsageProvider, limits: UsageLimit[]) {
  return {
    provider,
    ok: true,
    state: "ok" as const,
    checkedAt: "2026-06-03T12:00:00.000Z",
    durationMs: 10,
    limits,
    rawText: `raw ${provider}`,
    cleanedText: `clean ${provider}`,
    rawFileName: provider === "codex" ? "codex-default.txt" : `${provider}.txt`,
  };
}

function orderedCollector(
  provider: UsageProvider,
  events: string[]
): ProviderCollector {
  return async () => {
    events.push(`start:${provider}`);
    await sleep(5);
    events.push(`end:${provider}`);
    return okResult(provider, [limit(provider)]);
  };
}

function limit(provider: UsageProvider): UsageLimit {
  return {
    id: `${provider}:limit`,
    provider,
    providerLabel: provider,
    accountLabel: "person@example.com",
    scope: "Fixture limit",
    usedPercent: 10,
    remainingPercent: 90,
    status: "available",
    sourceCommand: "fixture",
    sourceText: "email person@example.com orgId: org_123456",
    checkedAt: "2026-06-03T12:00:00.000Z",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
