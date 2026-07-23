import { describe, expect, it } from "vitest";
import {
  compatibilityBaselineIssues,
  redactedCompatibilityBaseline,
} from "../src/compatibilityBaseline";
import type { UsageSnapshot } from "../src/types";

const config = {
  enabledProviders: ["claude" as const],
  timezone: "Asia/Seoul",
};

describe("protected compatibility baseline", () => {
  it("accepts a passing snapshot with verified rows and adapter provenance", () => {
    expect(compatibilityBaselineIssues(snapshot(), config)).toEqual([]);
  });

  it("rejects malformed or stale baseline data instead of treating it as absent", () => {
    expect(compatibilityBaselineIssues({ malformed: true }, config)).toEqual([
      "snapshot schema is invalid",
    ]);

    const stale = snapshot();
    stale.limits[0].freshness = "stale";
    expect(compatibilityBaselineIssues(stale, config)).toContain(
      "claude contains unverified rows"
    );
  });

  it("creates a structural baseline without account or quota data", () => {
    const source = snapshot();
    source.limits[0] = {
      ...source.limits[0],
      planLabel: "Private plan",
      accountLabel: "person@example.com",
      resetLabel: "Resets Jul 30, 4pm",
      resetAt: "2026-07-30T07:00:00.000Z",
      sourceText: "Private provider output 73% used",
      checkedAt: "2026-07-19T00:01:00.000Z",
    };

    const baseline = redactedCompatibilityBaseline(source);
    const serialized = JSON.stringify(baseline);

    expect(compatibilityBaselineIssues(baseline, config)).toEqual([]);
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("Private plan");
    expect(serialized).not.toContain("73%");
    expect(serialized).not.toContain("Jul 30");
    expect(baseline.limits[0]).toEqual({
      id: "claude:session",
      provider: "claude",
      providerLabel: "Claude Code",
      scope: "claude:session",
      window: "structural",
      usedPercent: 0,
      remainingPercent: 100,
      status: "available",
      freshness: "verified",
      informational: false,
      sourceCommand: "protected compatibility baseline",
      sourceText: "claude:session structural contract",
      checkedAt: source.generatedAt,
    });
  });
});

function snapshot(): UsageSnapshot {
  return {
    generatedAt: "2026-07-19T00:00:00.000Z",
    timezone: "Asia/Seoul",
    collectors: [
      {
        provider: "claude",
        enabled: true,
        ok: true,
        state: "ok",
        attemptState: "ok",
        checkedAt: "2026-07-19T00:00:00.000Z",
        durationMs: 10,
        adapterVersion: "2.2.0",
        formatFingerprint: "0123456789abcdef",
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
        freshness: "verified",
        sourceCommand: "fixture",
        sourceText: "Current session 10% used",
        checkedAt: "2026-07-19T00:00:00.000Z",
      },
    ],
  };
}
