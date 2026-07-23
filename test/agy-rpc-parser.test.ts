import { describe, expect, it } from "vitest";
import { parseAgyRpcQuota } from "../src/parsers/agyRpc";
import { ParserDriftError } from "../src/parsers/errors";

const meta = {
  checkedAt: "2026-07-18T00:00:00.000Z",
  sourceCommand: "must be replaced",
  planLabel: "Google AI Pro",
  accountLabel: "person@example.com",
};

describe("Agy local quota RPC parser", () => {
  it("maps grouped fractions, resets, status, and parser metadata", () => {
    const result = parseAgyRpcQuota(quotaPayload(), meta);

    expect(result.limits).toHaveLength(3);
    expect(result.limits.find((limit) => limit.id === "agy:gemini-models:weekly"))
      .toMatchObject({
        provider: "agy",
        providerLabel: "Antigravity",
        scope: "Gemini Models",
        window: "weekly",
        remainingPercent: 75,
        usedPercent: 25,
        status: "available",
        resetAt: "2026-07-19T23:03:00.000Z",
        resetLabel: "Refreshes in 47h 3m",
        sourceCommand: "agy local quota API",
        planLabel: "Google AI Pro",
        accountLabel: "person@example.com",
        checkedAt: meta.checkedAt,
      });
    expect(result.limits.find((limit) => limit.id === "agy:gemini-models:5h"))
      .toMatchObject({
        remainingPercent: 0,
        usedPercent: 100,
        status: "exhausted",
        resetLabel: "Refreshes in 5h 0m",
      });
    expect(result.limits.find((limit) => limit.id === "agy:claude-models:daily"))
      .toMatchObject({
        window: "daily",
        remainingPercent: 20,
        usedPercent: 80,
        status: "warning",
      });
  });

  it("returns deterministic canonical text without descriptions or identifiers", () => {
    const payload = quotaPayload();
    const result = parseAgyRpcQuota(payload, meta);

    expect(JSON.parse(result.sourceText)).toEqual({
      provider: "agy",
      source: "agy local quota API",
      quotas: [
        {
          group: "Claude Models",
          window: "daily",
          remainingPercent: 20,
        },
        {
          group: "Gemini Models",
          window: "5h",
          remainingPercent: 0,
          resetAt: "2026-07-18T05:00:00.000Z",
        },
        {
          group: "Gemini Models",
          window: "weekly",
          remainingPercent: 75,
          resetAt: "2026-07-19T23:03:00.000Z",
        },
      ],
    });
    expect(result.sourceText).not.toContain("private-project-id");
    expect(result.sourceText).not.toContain("secret bucket description");
    expect(result.limits[0]?.sourceText).not.toContain("person@example.com");
  });

  it("preserves pinnedGroups filtering case-insensitively", () => {
    const result = parseAgyRpcQuota(quotaPayload(), meta, ["  gemini models "]);

    expect(result.limits).toHaveLength(2);
    expect(result.limits.every((limit) => limit.scope === "Gemini Models")).toBe(
      true
    );
    expect(result.sourceText).not.toContain("Claude Models");
  });

  it("rejects missing, empty, and malformed response shapes", () => {
    const malformed = [
      undefined,
      {},
      { response: null },
      { response: {} },
      { response: { groups: [] } },
      { response: { groups: [null] } },
      { response: { groups: [{ displayName: "Gemini", buckets: [] }] } },
      {
        response: {
          groups: [
            {
              displayName: "Gemini",
              buckets: [{ window: "weekly", remainingFraction: "0.5" }],
            },
          ],
        },
      },
      singleBucket({ displayName: null }),
      singleBucket({ bucketId: null }),
      singleBucket({ description: null }),
      singleBucket({ resetTime: null }),
    ];

    for (const payload of malformed) {
      expect(() => parseAgyRpcQuota(payload, meta)).toThrow(ParserDriftError);
    }
  });

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid remainingFraction %s",
    (remainingFraction) => {
      expect(() =>
        parseAgyRpcQuota(singleBucket({ remainingFraction }), meta)
      ).toThrow(ParserDriftError);
    }
  );

  it.each([
    "not-a-date",
    "2026-02-30T00:00:00Z",
    "2026-07-18 05:00:00Z",
    "2026-07-18T25:00:00Z",
  ])("rejects invalid resetTime %s", (resetTime) => {
    expect(() => parseAgyRpcQuota(singleBucket({ resetTime }), meta)).toThrow(
      ParserDriftError
    );
  });

  it.each([
    "9999-01-01T00:00:00Z",
    "2026-07-01T00:00:00Z",
    "2026-08-01T00:00:00Z",
  ])("rejects resetTime outside the weekly horizon: %s", (resetTime) => {
    expect(() => parseAgyRpcQuota(singleBucket({ resetTime }), meta)).toThrow(
      ParserDriftError
    );
  });

  it("accepts an RFC3339 reset with an offset and canonicalizes it to UTC", () => {
    const result = parseAgyRpcQuota(
      singleBucket({ resetTime: "2026-07-18T14:30:00+09:00" }),
      meta
    );

    expect(result.limits[0]).toMatchObject({
      resetAt: "2026-07-18T05:30:00.000Z",
      resetLabel: "Refreshes in 5h 30m",
    });
  });

  it("derives status from the fraction rather than display-label words", () => {
    const payload = singleBucket({ remainingFraction: 0.8 });
    const response = payload.response as {
      groups: Array<{ displayName: string; buckets: unknown[] }>;
    };
    response.groups[0].displayName = "Exhausted Models";

    expect(parseAgyRpcQuota(payload, meta).limits[0]).toMatchObject({
      remainingPercent: 80,
      status: "available",
    });
  });

  it("treats the structured window as authoritative over displayName", () => {
    const result = parseAgyRpcQuota(
      singleBucket({ window: "FIVE_HOURS", displayName: "Weekly limit" }),
      meta
    );

    expect(result.limits[0]).toMatchObject({ window: "5h" });
  });

  it("rejects duplicate semantic group/window rows", () => {
    const payload = singleBucket();
    const response = payload.response as {
      groups: Array<{ displayName: string; buckets: unknown[] }>;
    };
    response.groups[0].buckets.push({
      window: "WEEKLY",
      displayName: "Weekly limit",
      remainingFraction: 0.5,
    });

    expect(() => parseAgyRpcQuota(payload, meta)).toThrow(ParserDriftError);
  });

  it("keeps IDs unique when distinct semantic labels have the same slug", () => {
    const payload = {
      response: {
        groups: [
          {
            displayName: "A+B Models",
            buckets: [{ window: "daily", remainingFraction: 0.5 }],
          },
          {
            displayName: "A B Models",
            buckets: [{ window: "daily", remainingFraction: 0.5 }],
          },
        ],
      },
    };

    const ids = parseAgyRpcQuota(payload, meta).limits.map((limit) => limit.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("rejects unsupported flat or amount quotas and unknown usage fields", () => {
    const flatPayload = singleBucket();
    const flatResponse = flatPayload.response as Record<string, unknown>;
    flatResponse.buckets = [{}];
    expect(() =>
      parseAgyRpcQuota(flatPayload, meta)
    ).toThrow(ParserDriftError);
    expect(() =>
      parseAgyRpcQuota(singleBucket({ remainingAmount: "5" }), meta)
    ).toThrow(ParserDriftError);
    expect(() =>
      parseAgyRpcQuota(singleBucket({ usedFraction: 0.5 }), meta)
    ).toThrow(ParserDriftError);
    expect(() =>
      parseAgyRpcQuota(singleBucket({ undocumentedFlag: false }), meta)
    ).toThrow(ParserDriftError);
  });

  it("skips disabled buckets but validates disabled's type", () => {
    const payload = quotaPayload();
    const response = payload.response as {
      groups: Array<{ displayName: string; buckets: Array<Record<string, unknown>> }>;
    };
    response.groups[0].buckets[0].disabled = true;

    const result = parseAgyRpcQuota(payload, meta);
    expect(result.limits).toHaveLength(2);
    expect(result.limits.some((limit) => limit.id.endsWith(":weekly"))).toBe(false);
    expect(() =>
      parseAgyRpcQuota(singleBucket({ disabled: "yes" }), meta)
    ).toThrow(ParserDriftError);
    expect(() =>
      parseAgyRpcQuota(singleBucket({ disabled: true }), meta)
    ).toThrow(ParserDriftError);
  });

  it("rejects oversized groups, buckets, and known strings", () => {
    expect(() =>
      parseAgyRpcQuota(
        { response: { groups: Array.from({ length: 65 }, () => ({})) } },
        meta
      )
    ).toThrow(ParserDriftError);

    expect(() =>
      parseAgyRpcQuota(
        {
          response: {
            groups: [
              {
                displayName: "Gemini",
                buckets: Array.from({ length: 65 }, () => ({})),
              },
            ],
          },
        },
        meta
      )
    ).toThrow(ParserDriftError);

    expect(() =>
      parseAgyRpcQuota(
        singleBucket({ description: "x".repeat(4_097) }),
        meta
      )
    ).toThrow(ParserDriftError);
  });

  it("uses a privacy-safe ParserDriftError source", () => {
    const secret = "person@example.com/private-project";
    try {
      parseAgyRpcQuota(
        singleBucket({ description: secret, remainingFraction: 2 }),
        meta
      );
      throw new Error("Expected parser drift");
    } catch (error) {
      expect(error).toBeInstanceOf(ParserDriftError);
      expect((error as ParserDriftError).sourceText).not.toContain(secret);
      expect((error as ParserDriftError).sourceText).toContain("redacted");
    }
  });

  it("canonicalizes quota order with a deterministic total ordering", () => {
    const first = {
      response: {
        groups: [
          {
            displayName: "é Models",
            buckets: [{ window: "daily", remainingFraction: 0.5 }],
          },
          {
            displayName: "e Models",
            buckets: [{ window: "daily", remainingFraction: 0.5 }],
          },
        ],
      },
    };
    const second = {
      response: {
        groups: [...first.response.groups].reverse(),
      },
    };

    expect(parseAgyRpcQuota(first, meta).sourceText).toBe(
      parseAgyRpcQuota(second, meta).sourceText
    );
  });

  it("throws when pinnedGroups selects no API group", () => {
    expect(() =>
      parseAgyRpcQuota(quotaPayload(), meta, ["Missing Models"])
    ).toThrow(ParserDriftError);
  });
});

function quotaPayload(): Record<string, unknown> {
  return {
    response: {
      groups: [
        {
          displayName: "Gemini Models",
          description: "private-project-id",
          buckets: [
            {
              bucketId: "private-project-id/weekly",
              displayName: "Weekly limit",
              description: "secret bucket description",
              window: "WEEKLY",
              remainingFraction: 0.75,
              resetTime: "2026-07-19T23:03:00Z",
            },
            {
              window: "FIVE_HOURS",
              remainingFraction: 0,
              resetTime: "2026-07-18T05:00:00Z",
            },
          ],
        },
        {
          displayName: "Claude Models",
          buckets: [{ window: "daily", remainingFraction: 0.2 }],
        },
      ],
    },
  };
}

function singleBucket(
  override: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    response: {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            {
              window: "weekly",
              remainingFraction: 0.5,
              ...override,
            },
          ],
        },
      ],
    },
  };
}
