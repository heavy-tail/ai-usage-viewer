import { describe, expect, it } from "vitest";
import { displayResetLabel } from "../src/lib/resetTime";

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

  it("normalizes legacy Codex local reset labels", () => {
    expect(
      displayResetLabel(
        {
          checkedAt: "2026-06-03T12:00:00.000Z",
          resetLabel: "Resets 3:41 AM on 4 Jun",
        },
        options
      )
    ).toBe("Resets Jun 4, 3:41 AM");
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
});
