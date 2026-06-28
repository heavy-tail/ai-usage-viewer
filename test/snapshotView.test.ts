import { describe, expect, it } from "vitest";
import {
  actionableUsageLimits,
  emptyUsageSnapshot,
  visibleProvidersForSnapshot,
} from "../src/lib/snapshotView";
import { groupByProvider } from "../src/lib/usage";
import type { UsageLimit, UsageSnapshot } from "../src/types";

describe("snapshot view helpers", () => {
  it("starts with no visible providers for the loading snapshot", () => {
    expect(visibleProvidersForSnapshot(emptyUsageSnapshot())).toEqual([]);
  });

  it("shows providers with successful detection or previous rows only", () => {
    const snapshot: UsageSnapshot = {
      generatedAt: "2026-06-03T12:00:00.000Z",
      collectors: [
        {
          provider: "claude",
          ok: false,
          state: "unavailable",
          checkedAt: "2026-06-03T12:00:00.000Z",
          durationMs: 1,
        },
        {
          provider: "codex",
          ok: true,
          state: "ok",
          checkedAt: "2026-06-03T12:00:00.000Z",
          durationMs: 1,
        },
        {
          provider: "agy",
          ok: false,
          state: "error",
          checkedAt: "2026-06-03T12:00:00.000Z",
          durationMs: 1,
        },
        {
          provider: "grok",
          ok: false,
          state: "error",
          checkedAt: "2026-06-03T12:00:00.000Z",
          durationMs: 1,
        },
      ],
      limits: [limit("grok")],
    };

    expect(visibleProvidersForSnapshot(snapshot)).toEqual(["codex", "grok"]);
  });

  it("does not use informational rows as visible quota rows", () => {
    const contextOnly = limit("codex", true);
    const quota = limit("codex", false);

    expect(actionableUsageLimits([contextOnly])).toEqual([]);
    expect(actionableUsageLimits([contextOnly, quota])).toEqual([quota]);
  });

  it("keeps the latest row when a snapshot contains duplicate ids", () => {
    const first = { ...limit("codex"), id: "codex:spark", usedPercent: 1 };
    const latest = { ...first, usedPercent: 2, resetLabel: "latest reset" };

    expect(groupByProvider([first, latest]).codex).toEqual([latest]);
  });

  it("hides providers that only have informational rows", () => {
    const snapshot: UsageSnapshot = {
      generatedAt: "2026-06-03T12:00:00.000Z",
      collectors: [
        {
          provider: "codex",
          ok: true,
          state: "ok",
          checkedAt: "2026-06-03T12:00:00.000Z",
          durationMs: 1,
        },
      ],
      limits: [limit("codex", true)],
    };

    expect(visibleProvidersForSnapshot(snapshot)).toEqual([]);
  });
});

function limit(provider: "codex" | "grok", informational = false): UsageLimit {
  return {
    id: informational ? `${provider}:context` : `${provider}:credits`,
    provider,
    providerLabel: provider,
    scope: informational ? "Context window" : "Free credits",
    usedPercent: 10,
    remainingPercent: 90,
    status: "available",
    informational,
    sourceCommand: "fixture",
    sourceText: "fixture",
    checkedAt: "2026-06-03T12:00:00.000Z",
  };
}
