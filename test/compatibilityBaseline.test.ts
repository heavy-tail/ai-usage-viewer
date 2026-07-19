import { describe, expect, it } from "vitest";
import { compatibilityBaselineIssues } from "../src/compatibilityBaseline";
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
