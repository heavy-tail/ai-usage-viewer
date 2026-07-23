import { describe, expect, it } from "vitest";
import { displayResetLabel, resolveResetInstant } from "../src/lib/resetTime";

const options = { locale: "en-US", timeZone: "Asia/Seoul" } as const;

describe("reset time display", () => {
  it("formats canonical timestamps consistently", () => {
    expect(
      displayResetLabel(
        {
          checkedAt: "2026-07-18T14:00:00.000Z",
          resetAt: "2026-07-25T04:56:08.000Z",
          resetLabel: "Resets 2026-07-25T04:56:08.000Z",
        },
        options
      )
    ).toBe("Resets Jul 25, 1:56 PM");
  });

  it("normalizes Claude's dated and time-only labels", () => {
    expect(
      displayResetLabel(
        {
          checkedAt: "2026-07-18T14:16:58.000Z",
          resetLabel: "Resets Jul 21, 3:59pm (Asia/Seoul)",
        },
        options
      )
    ).toBe("Resets Jul 21, 3:59 PM");

    expect(
      displayResetLabel(
        {
          checkedAt: "2026-07-18T14:16:58.000Z",
          resetLabel: "Resets 1:59am (Asia/Seoul)",
        },
        options
      )
    ).toBe("Resets Jul 19, 1:59 AM");
  });

  it("converts Grok Pacific time into the user's local time", () => {
    expect(
      displayResetLabel(
        {
          checkedAt: "2026-07-18T14:16:58.000Z",
          resetLabel: "Resets July 24, 22:12 PT",
        },
        options
      )
    ).toBe("Resets Jul 25, 2:12 PM");
  });

  it("normalizes Antigravity relative reset labels", () => {
    expect(
      displayResetLabel(
        {
          checkedAt: "2026-07-18T14:16:58.000Z",
          resetLabel: "Refreshes in 5h 1m",
        },
        options
      )
    ).toBe("Resets Jul 19, 4:17 AM");
  });

  it("preserves offset-less labels when their source timezone is unknown", () => {
    expect(
      displayResetLabel(
        {
          checkedAt: "2026-06-03T12:00:00.000Z",
          resetLabel: "Resets 3:41 AM on 4 Jun",
        },
        options
      )
    ).toBe("Resets 3:41 AM on 4 Jun");
  });

  it("canonicalizes an offset-less label with the provider source timezone", () => {
    const instant = resolveResetInstant(
      {
        checkedAt: "2026-07-18T04:00:00.000Z",
        resetLabel: "Resets 2:39 PM on 18 Jul",
      },
      "Asia/Seoul"
    );
    expect(instant?.toISOString()).toBe("2026-07-18T05:39:00.000Z");
    expect(
      displayResetLabel(
        {
          checkedAt: "2026-07-18T04:00:00.000Z",
          resetAt: instant?.toISOString(),
          resetLabel: "Resets 2:39 PM on 18 Jul",
        },
        { locale: "en-US", timeZone: "UTC" }
      )
    ).toBe("Resets Jul 18, 5:39 AM");
  });

  it("chooses the second matching wall-clock time during a DST fallback", () => {
    expect(
      displayResetLabel(
        {
          // 1:45 AM PDT, after the first 1:30 but before clocks fall back.
          checkedAt: "2026-11-01T08:45:00.000Z",
          resetLabel: "Resets 1:30 AM (America/Los_Angeles)",
        },
        { locale: "en-US", timeZone: "UTC" }
      )
    ).toBe("Resets Nov 1, 9:30 AM");
  });

  it("preserves unknown labels instead of guessing", () => {
    expect(
      displayResetLabel(
        {
          checkedAt: "2026-07-18T14:00:00.000Z",
          resetLabel: "Resets after billing review",
        },
        options
      )
    ).toBe("Resets after billing review");
  });

  it("does not throw or construct invalid Dates from unbounded reset text", () => {
    const label = "Resets in 104000000d";
    expect(() =>
      displayResetLabel(
        {
          checkedAt: "2026-07-18T14:00:00.000Z",
          resetLabel: label,
        },
        options
      )
    ).not.toThrow();
    expect(
      displayResetLabel(
        {
          checkedAt: "2026-07-18T14:00:00.000Z",
          resetLabel: label,
        },
        options
      )
    ).toBe(label);
  });
});
