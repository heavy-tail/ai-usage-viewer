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

  it("redacts authentication headers, cookies, and credential assignments", () => {
    const text = [
      "Authorization: Bearer synthetic-bearer-value-123",
      "Proxy-Authorization: Basic c3ludGhldGljOnBhc3N3b3Jk",
      "Cookie: session=synthetic-session; theme=dark",
      "Set-Cookie: session=synthetic-session; HttpOnly",
      "api_key=synthetic-api-key-value",
      "apiKey: 'synthetic-camel-key-value'",
      'token="synthetic-token-value"',
      "secret: synthetic-secret-value",
      "password=synthetic-password-value",
    ].join("\n");

    const redacted = redactSensitiveText(text);
    expect(redacted).not.toContain("synthetic-");
    expect(redacted).not.toContain("c3ludGhldGljOnBhc3N3b3Jk");
    expect(redacted).toContain(
      "Authorization: Bearer <redacted-credential>"
    );
    expect(redacted).toContain("Cookie: <redacted-cookie>");
    expect(redacted).toContain("api_key=<redacted-credential>");
  });

  it("redacts credential JSON fields without breaking JSON", () => {
    const text = JSON.stringify({
      apiKey: "synthetic-api-key-value",
      token: "synthetic-token-value",
      client_secret: "synthetic-client-secret-value",
      password: "synthetic-password-value",
      authorization: "Bearer synthetic-authorization-value",
      cookie: "session=synthetic-session",
    });

    expect(JSON.parse(redactSensitiveText(text))).toEqual({
      apiKey: "<redacted-credential>",
      token: "<redacted-credential>",
      client_secret: "<redacted-credential>",
      password: "<redacted-credential>",
      authorization: "<redacted-credential>",
      cookie: "<redacted-credential>",
    });
  });

  it("redacts vendor-prefixed environment credential names", () => {
    const assignments = [
      "OPENAI_API_KEY=opaque-openai-value",
      'anthropic-api-key: "opaque anthropic value"',
      "X_API_KEY=opaque-x-value",
      "GITHUB_TOKEN=opaque-github-value",
      "AZURE_CLIENT_SECRET='opaque azure value'",
      "AWS_SECRET_ACCESS_KEY=opaque-aws-value",
      "STRIPE_SECRET_KEY=opaque-stripe-value",
      "HTTP_AUTHORIZATION=opaque-http-auth-value",
      "openaiApiKey=opaque-camel-value",
    ].join("\n");
    const json = JSON.stringify({
      OPENAI_API_KEY: "opaque-openai-value",
      GITHUB_TOKEN: "opaque-github-value",
      AZURE_CLIENT_SECRET: "opaque-azure-value",
      AWS_SECRET_ACCESS_KEY: "opaque-aws-value",
      STRIPE_SECRET_KEY: "opaque-stripe-value",
      HTTP_AUTHORIZATION: "opaque-http-auth-value",
      anthropicApiKey: "opaque-camel-value",
    });

    const redactedAssignments = redactSensitiveText(assignments);
    expect(redactedAssignments).not.toContain("opaque");
    expect(redactedAssignments.match(/<redacted-credential>/g)).toHaveLength(9);
    expect(JSON.parse(redactSensitiveText(json))).toEqual({
      OPENAI_API_KEY: "<redacted-credential>",
      GITHUB_TOKEN: "<redacted-credential>",
      AZURE_CLIENT_SECRET: "<redacted-credential>",
      AWS_SECRET_ACCESS_KEY: "<redacted-credential>",
      STRIPE_SECRET_KEY: "<redacted-credential>",
      HTTP_AUTHORIZATION: "<redacted-credential>",
      anthropicApiKey: "<redacted-credential>",
    });
  });

  it("redacts credential-shaped provider tokens and Windows profile names", () => {
    const text = [
      "sk-proj-syntheticOpenAIKeyMaterial1234567890",
      "sk-ant-api03-syntheticAnthropicKeyMaterial1234567890",
      "ghp_SyntheticGitHubTokenMaterial1234567890",
      "github_pat_SyntheticFineGrainedTokenMaterial_1234567890",
      String.raw`C:\Users\Fixture Person\AppData\Local\usage-viewer`,
      String.raw`{"path":"C:\\Users\\Fixture Person\\Documents\\usage.txt"}`,
    ].join("\n");

    const redacted = redactSensitiveText(text);
    expect(redacted).not.toMatch(/sk-(?:proj|ant)-/);
    expect(redacted).not.toMatch(/(?:ghp_|github_pat_)/);
    expect(redacted).not.toContain("Fixture Person");
    expect(redacted.match(/<redacted-provider-token>/g)).toHaveLength(4);
    expect(redacted).toContain(
      String.raw`C:\Users\<redacted-user>\AppData\Local`
    );
    expect(redacted).toContain(
      String.raw`C:\\Users\\<redacted-user>\\Documents`
    );
  });

  it("uses credential field names during recursive structured redaction", () => {
    const redacted = redactSensitiveValue({
      apiKey: "synthetic-api-key-value",
      accessToken: "synthetic-access-token-value",
      password: "synthetic-password-value",
      headers: {
        authorization: "Bearer synthetic-authorization-value",
        cookie: "session=synthetic-session",
      },
      tokenUsage: "1,234 of 10,000",
    });

    expect(redacted.apiKey).toBe("<redacted-credential>");
    expect(redacted.accessToken).toBe("<redacted-credential>");
    expect(redacted.password).toBe("<redacted-credential>");
    expect(redacted.headers.authorization).toBe("<redacted-credential>");
    expect(redacted.headers.cookie).toBe("<redacted-cookie>");
    expect(redacted.tokenUsage).toBe("1,234 of 10,000");
  });

  it("redacts vendor-prefixed structured credentials but preserves quota fields", () => {
    const redacted = redactSensitiveValue({
      OPENAI_API_KEY: "opaque-openai-value",
      ANTHROPIC_API_KEY: "opaque-anthropic-value",
      X_API_KEY: "opaque-x-value",
      GITHUB_TOKEN: "opaque-github-value",
      AZURE_CLIENT_SECRET: "opaque-azure-value",
      AWS_SECRET_ACCESS_KEY: "opaque-aws-value",
      STRIPE_SECRET_KEY: "opaque-stripe-value",
      HTTP_AUTHORIZATION: "opaque-http-auth-value",
      openaiApiKey: "opaque-camel-value",
      tokenUsage: 1234,
      tokenLimit: 10000,
    });

    expect(redacted.OPENAI_API_KEY).toBe("<redacted-credential>");
    expect(redacted.ANTHROPIC_API_KEY).toBe("<redacted-credential>");
    expect(redacted.X_API_KEY).toBe("<redacted-credential>");
    expect(redacted.GITHUB_TOKEN).toBe("<redacted-credential>");
    expect(redacted.AZURE_CLIENT_SECRET).toBe("<redacted-credential>");
    expect(redacted.AWS_SECRET_ACCESS_KEY).toBe("<redacted-credential>");
    expect(redacted.STRIPE_SECRET_KEY).toBe("<redacted-credential>");
    expect(redacted.HTTP_AUTHORIZATION).toBe("<redacted-credential>");
    expect(redacted.openaiApiKey).toBe("<redacted-credential>");
    expect(redacted.tokenUsage).toBe(1234);
    expect(redacted.tokenLimit).toBe(10000);
  });

  it("leaves ordinary quota and reset text unchanged", () => {
    const text = [
      "Current session",
      "23% used",
      "Resets 8:10pm (Asia/Seoul)",
      "Token usage: 1,234 of 10,000",
      "Token limit: 200000",
      "Usage credits",
      "11% used",
    ].join("\n");

    expect(redactSensitiveText(text)).toBe(text);
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
