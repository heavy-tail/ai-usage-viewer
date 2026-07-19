import { describe, expect, it } from "vitest";
import {
  lastVerifiedLabel,
  toneForUsageRow,
} from "../src/components/UsageRow";
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

  it("shows hard-stop rows as exhausted even when their gauge is low", () => {
    expect(
      toneForUsageRow({
        id: "codex:5h",
        provider: "codex",
        providerLabel: "Codex",
        scope: "5h limit",
        usedPercent: 3,
        remainingPercent: 97,
        status: "exhausted",
        blockingReason: "Workspace usage limit reached",
        sourceCommand: "fixture",
        sourceText: "fixture",
        checkedAt: "2026-07-18T12:00:00.000Z",
      } satisfies UsageLimit)
    ).toBe("red");
  });

  it("labels retained values with their last verified time", () => {
    expect(
      lastVerifiedLabel(
        {
          checkedAt: "2026-07-18T12:00:00.000Z",
          freshness: "stale",
        },
        "Asia/Seoul"
      )
    ).toBe("Last verified Jul 18, 9:00 PM");
  });
});
