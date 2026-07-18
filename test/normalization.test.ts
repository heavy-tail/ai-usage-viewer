import { describe, expect, it } from "vitest";
import {
  fromRemainingPercent,
  fromUsedPercent,
  statusFromPercent,
} from "../src/lib/percent";
import {
  redactSensitiveText,
  redactSensitiveValue,
  redactSnapshot,
} from "../src/lib/redaction";
import { validateSnapshotShape } from "../src/snapshot";
import type { UsageSnapshot } from "../src/types";

describe("percent normalization and status mapping", () => {
  it("normalizes used percentages", () => {
    expect(fromUsedPercent(37)).toEqual({
      usedPercent: 37,
      remainingPercent: 63,
    });
  });

  it("normalizes remaining and left percentages", () => {
    expect(fromRemainingPercent(76)).toEqual({
      usedPercent: 24,
      remainingPercent: 76,
    });
  });

  it("maps available, warning, exhausted, and unknown states", () => {
    expect(statusFromPercent({ usedPercent: 10 })).toBe("available");
    expect(statusFromPercent({ usedPercent: 80 })).toBe("warning");
    expect(statusFromPercent({ remainingPercent: 20 })).toBe("warning");
    expect(statusFromPercent({ remainingPercent: 0 })).toBe("exhausted");
    expect(statusFromPercent({})).toBe("unknown");
  });

  it("uses source text for exhausted status", () => {
    expect(statusFromPercent({ remainingPercent: 50 }, "Quota exhausted")).toBe(
      "exhausted"
    );
  });

  it("keeps informational rows from becoming warnings", () => {
    expect(statusFromPercent({ remainingPercent: 5 }, "", true)).toBe(
      "available"
    );
  });
});

describe("redaction", () => {
  it("redacts emails, organization IDs, and account-like values", () => {
    const text =
      "email test@example.com orgId: org_123456 account_id=acct_abcdef userId: user_123456 Session: 019e8dd1-3c9c-7563-98f3-fe56f5745d55";
    expect(redactSensitiveText(text)).toBe(
      "email <redacted-email> orgId: <redacted-org-id> account_id=<redacted-account-id> userId: <redacted-account-id> Session: <redacted-session-id>"
    );
  });

  it("redacts snapshot string fields recursively", () => {
    const snapshot = sampleSnapshot();
    const redacted = redactSnapshot(snapshot);
    expect(redacted.limits[0].accountLabel).toBe("<redacted-email>");
    expect(redacted.limits[0].sourceText).toContain("<redacted-org-id>");
    expect(redacted.limits[0].sourceText).not.toContain("org_123456");
  });

  it("redacts quoted JSON identifiers, reset credits, and bare account labels", () => {
    const text = JSON.stringify(
      {
        orgId: "org_private123",
        accountId: "account_private123",
        sessionId: "019e8dd1-3c9c-7563-98f3-fe56f5745d55",
        id: "RateLimitResetCredit_bf819d2d369c8191a3653cbd93980b24",
      },
      null,
      2
    );
    const redacted = redactSensitiveText(`${text}\nAccount: wchun`);

    expect(redacted).not.toContain("private123");
    expect(redacted).not.toContain("bf819d2d369c");
    expect(redacted).not.toContain("wchun");
    expect(redacted).toContain("<redacted-reset-credit-id>");
    expect(redacted).toContain("Account: <redacted-account-id>");
  });

  it("uses identity field names to redact organization and account labels", () => {
    const redacted = redactSensitiveValue({
      orgName: "Private Claude Organization",
      organizationName: "Another Private Organization",
      accountLabel: "privateuser",
      providerLabel: "Claude Code",
      organization: { name: "Nested Private Organization", role: "Owner" },
    });

    expect(redacted.orgName).toBe("<redacted-org-id>");
    expect(redacted.organizationName).toBe("<redacted-org-id>");
    expect(redacted.accountLabel).toBe("<redacted-account-id>");
    expect(redacted.providerLabel).toBe("Claude Code");
    expect(redacted.organization.name).toBe("<redacted-org-id>");
    expect(redacted.organization.role).toBe("Owner");
  });

  it("redacts Claude organization label lines without matching ordinary prose", () => {
    const text = [
      "Organization: Private Claude Organization",
      "orgName: Another Private Organization",
      "Organization settings are available in the dashboard.",
    ].join("\n");

    const redacted = redactSensitiveText(text);
    expect(redacted).not.toContain("Private Claude Organization");
    expect(redacted).not.toContain("Another Private Organization");
    expect(redacted).toContain(
      "Organization settings are available in the dashboard."
    );
  });
});

describe("snapshot shape validation", () => {
  it("accepts the normalized snapshot shape", () => {
    expect(validateSnapshotShape(sampleSnapshot())).toBe(true);
  });

  it("rejects invalid snapshots", () => {
    expect(validateSnapshotShape({ generatedAt: "x", collectors: [], limits: [{}] }))
      .toBe(false);
  });
});

function sampleSnapshot(): UsageSnapshot {
  return {
    generatedAt: "2026-06-03T12:00:00.000Z",
    collectors: [
      {
        provider: "claude",
        ok: true,
        state: "ok",
        checkedAt: "2026-06-03T12:00:00.000Z",
        durationMs: 10,
      },
    ],
    limits: [
      {
        id: "claude:session",
        provider: "claude",
        providerLabel: "Claude Code",
        accountLabel: "test@example.com",
        scope: "Current session",
        usedPercent: 0,
        remainingPercent: 100,
        status: "available",
        sourceCommand: "claude -> /usage",
        sourceText: "orgId: org_123456\nemail: test@example.com",
        checkedAt: "2026-06-03T12:00:00.000Z",
      },
    ],
  };
}
