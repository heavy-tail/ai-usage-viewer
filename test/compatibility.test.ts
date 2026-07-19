import { describe, expect, it } from "vitest";
import {
  fingerprintFormat,
  validateLimits,
  verifyCollectorResult,
} from "../src/compatibility";
import type { ProviderCollectorResult } from "../src/collectors/types";
import type { UsageLimit } from "../src/types";

describe("provider adapter contract", () => {
  it("accepts normalized, internally consistent quota rows", () => {
    const result = verifyCollectorResult(success([limit()]));

    expect(result).toMatchObject({
      ok: true,
      state: "ok",
      adapterVersion: "2.2.0",
    });
    expect(result.formatFingerprint).toMatch(/^[a-f0-9]{16}$/);
  });

  it("turns a false-green collector result into drift", () => {
    const result = verifyCollectorResult(success([]));

    expect(result).toMatchObject({
      ok: false,
      state: "drift",
      limits: [],
    });
    expect(result.error).toContain("no usage rows were recognized");
  });

  it("rejects duplicate, cross-provider, and impossible percentages", () => {
    const malformed = {
      ...limit(),
      provider: "codex" as const,
      usedPercent: 80,
      remainingPercent: 80,
    };
    const issues = validateLimits("claude", [malformed, malformed]);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("belongs to codex"),
        expect.stringContaining("duplicated"),
        expect.stringContaining("do not add up to 100"),
      ])
    );
  });

  it("fingerprints layout while ignoring changing values and identities", () => {
    const first = fingerprintFormat(
      "Account person@example.com\\nCurrent week 25% used\\nResets 4:30"
    );
    const second = fingerprintFormat(
      "Account another@example.com\\nCurrent week 71% used\\nResets 9:15"
    );

    expect(first).toBe(second);
    expect(first).not.toContain("person");
  });

  it("ignores changing opaque reset-credit identifiers", () => {
    const first = fingerprintFormat(
      '"id": "RateLimitResetCredit_bf819d2d369c8191a3653cbd93980b24"'
    );
    const second = fingerprintFormat(
      '"id": "RateLimitResetCredit_a89a1957b59c819183eec7698fa62f36"'
    );

    expect(first).toBe(second);
  });

  it("ignores changing bare account labels", () => {
    expect(fingerprintFormat("Account: first-user\nWeekly 10% used")).toBe(
      fingerprintFormat("Account: second-user\nWeekly 80% used")
    );
  });

  it("does not encode organization or account labels in format hashes", () => {
    const first = fingerprintFormat(
      '{"orgName":"Private Alpha","accountLabel":"Founder One","usage":"10%"}'
    );
    const second = fingerprintFormat(
      '{"orgName":"Secret Beta","accountLabel":"Founder Two","usage":"90%"}'
    );

    expect(first).toBe(second);
  });

  it("fingerprints JSON structure independently of values and key order", () => {
    const first = fingerprintFormat('{"usage":10,"account":{"name":"alpha"}}');
    const reordered = fingerprintFormat(
      '{"account":{"name":"beta"},"usage":90}'
    );
    const changed = fingerprintFormat(
      '{"account":{"name":"beta"},"usage":90,"newWindow":true}'
    );

    expect(first).toBe(reordered);
    expect(changed).not.toBe(first);
  });
});

function success(limits: UsageLimit[]): ProviderCollectorResult {
  return {
    provider: "claude",
    ok: true,
    state: "ok",
    checkedAt: "2026-07-18T00:00:00.000Z",
    durationMs: 12,
    limits,
    rawText: "Current session 10% used",
    cleanedText: "Current session 10% used",
    rawFileName: "claude.txt",
  };
}

function limit(): UsageLimit {
  return {
    id: "claude:session",
    provider: "claude",
    providerLabel: "Claude Code",
    scope: "Current session",
    usedPercent: 10,
    remainingPercent: 90,
    status: "available",
    sourceCommand: "fixture",
    sourceText: "Current session 10% used",
    checkedAt: "2026-07-18T00:00:00.000Z",
  };
}
