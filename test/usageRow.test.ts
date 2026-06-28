import { describe, expect, it } from "vitest";
import { toneForUsageRow } from "../src/components/UsageRow";
import type { UsageLimit } from "../src/types";

describe("UsageRow", () => {
  it("colors quota bars by saved usage percentage even when data is stale", () => {
    expect(
      toneForUsageRow({
        id: "claude:week",
        provider: "claude",
        providerLabel: "Claude Code",
        scope: "Current week",
        usedPercent: 3,
        remainingPercent: 97,
        status: "drift",
        statusLabel: "stale - stale",
        sourceCommand: "fixture",
        sourceText: "fixture",
        checkedAt: "2026-06-03T12:00:00.000Z",
      } satisfies UsageLimit)
    ).toBe("green");
  });
});
