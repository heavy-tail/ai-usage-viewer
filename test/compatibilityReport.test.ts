import { describe, expect, it } from "vitest";
import { buildCompatibilityReport } from "../src/compatibilityReport";
import type { UsageSnapshot } from "../src/types";

describe("compatibility report", () => {
  it("passes only enabled providers with verified actionable rows", () => {
    const report = buildCompatibilityReport(snapshot(), ["claude"]);

    expect(report.passed).toBe(true);
    expect(report.providers).toEqual([
      expect.objectContaining({
        provider: "claude",
        passed: true,
        rowCount: 1,
        adapterVersion: "2.0.0",
      }),
    ]);
  });

  it("fails an apparently healthy provider that has no quota rows", () => {
    const value = snapshot();
    value.limits = [];

    const report = buildCompatibilityReport(value, ["claude"]);

    expect(report.passed).toBe(false);
    expect(report.providers[0]).toMatchObject({ passed: false, rowCount: 0 });
  });

  it("preserves the latest failed attempt cause behind stale rows", () => {
    const value = snapshot();
    value.collectors[0] = {
      ...value.collectors[0],
      ok: false,
      state: "stale",
      attemptState: "drift",
    };

    const report = buildCompatibilityReport(value, ["claude"]);

    expect(report.providers[0]).toMatchObject({
      state: "stale",
      attemptState: "drift",
      passed: false,
    });
  });

  it("fails when a provider format changes despite healthy rows", () => {
    const value = snapshot();
    value.collectors[0] = {
      ...value.collectors[0],
      formatChanged: true,
    };

    const report = buildCompatibilityReport(value, ["claude"]);

    expect(report.passed).toBe(false);
    expect(report.providers[0]).toMatchObject({
      passed: false,
      formatChanged: true,
    });
  });

  it("fails when the provider row inventory changes", () => {
    const value = snapshot();
    value.collectors[0] = {
      ...value.collectors[0],
      rowInventoryChanged: true,
    };

    const report = buildCompatibilityReport(value, ["claude"]);

    expect(report.passed).toBe(false);
    expect(report.providers[0]).toMatchObject({
      passed: false,
      rowInventoryChanged: true,
    });
  });

  it("fails when an enabled provider has duplicate collector entries", () => {
    const value = snapshot();
    value.collectors.push({ ...value.collectors[0] });

    const report = buildCompatibilityReport(value, ["claude"]);

    expect(report.passed).toBe(false);
    expect(report.providers).toHaveLength(2);
  });

  it("fails when any enabled provider has no collector entry", () => {
    const report = buildCompatibilityReport(snapshot(), ["claude", "grok"]);

    expect(report.passed).toBe(false);
    expect(report.providers.map((provider) => provider.provider)).toEqual([
      "claude",
    ]);
  });

  it("fails when no providers are enabled", () => {
    const report = buildCompatibilityReport(snapshot(), []);

    expect(report.passed).toBe(false);
    expect(report.providers).toEqual([]);
  });
});

function snapshot(): UsageSnapshot {
  return {
    generatedAt: "2026-07-18T00:00:00.000Z",
    collectors: [
      {
        provider: "claude",
        ok: true,
        state: "ok",
        checkedAt: "2026-07-18T00:00:00.000Z",
        durationMs: 1,
        adapterVersion: "2.0.0",
        formatFingerprint: "abc123",
      },
      {
        provider: "codex",
        ok: false,
        state: "unavailable",
        checkedAt: "2026-07-18T00:00:00.000Z",
        durationMs: 1,
      },
    ],
    limits: [
      {
        id: "claude:session",
        provider: "claude",
        providerLabel: "Claude Code",
        scope: "Current session",
        usedPercent: 10,
        remainingPercent: 90,
        status: "available",
        sourceCommand: "fixture",
        sourceText: "fixture",
        checkedAt: "2026-07-18T00:00:00.000Z",
      },
    ],
  };
}
