import { describe, expect, it } from "vitest";
import { parseAgyQuota } from "../src/parsers/agy";
import { parseGrokUsage } from "../src/parsers/grok";
import { ParserDriftError } from "../src/parsers/errors";

const meta = {
  checkedAt: "2026-07-18T00:00:00.000Z",
  sourceCommand: "fixture",
  sourceTimeZone: "Asia/Seoul",
};

describe("provider parser completeness", () => {
  it("rejects an unknown Agy quota window instead of publishing partial rows", () => {
    const text = [
      "GEMINI MODELS",
      "Weekly Limit",
      "[####################] 90%",
      "Quota available",
      "Monthly Limit",
      "[####################] 50%",
    ].join("\n");

    expect(() => parseAgyQuota(text, meta)).toThrow(ParserDriftError);
  });

  it("accepts an incomplete Agy redraw only when a later frame completes it", () => {
    const text = [
      "GEMINI MODELS",
      "Weekly Limit",
      "Loading...",
      "GEMINI MODELS",
      "Weekly Limit",
      "[####################] 90%",
      "Quota available",
    ].join("\n");

    expect(parseAgyQuota(text, meta)).toHaveLength(1);
  });

  it("rejects Agy when the latest redraw becomes incomplete", () => {
    const text = [
      "GEMINI MODELS",
      "Weekly Limit",
      "[####################] 90%",
      "Quota available",
      "GEMINI MODELS",
      "Weekly Limit",
      "Loading...",
    ].join("\n");

    expect(() => parseAgyQuota(text, meta)).toThrow(ParserDriftError);
  });

  it("rejects a new Agy group heading instead of assigning it to an old group", () => {
    const text = [
      "GEMINI MODELS",
      "Weekly Limit",
      "[####################] 90%",
      "Quota available",
      "IMAGE GENERATION",
      "Weekly Limit",
      "[####################] 80%",
      "Quota available",
    ].join("\n");

    expect(() => parseAgyQuota(text, meta)).toThrow(ParserDriftError);
  });

  it("keeps the newest complete Agy redraw", () => {
    const frame = (remaining: number) => [
      "GEMINI MODELS",
      "Weekly Limit",
      `[####################] ${remaining}%`,
      "Quota available",
    ];

    const rows = parseAgyQuota([...frame(90), ...frame(80)].join("\n"), meta);
    expect(rows[0]).toMatchObject({ remainingPercent: 80, usedPercent: 20 });
  });

  it("rejects an unknown Grok limit alongside a valid monthly value", () => {
    const text = [
      "Monthly limit: 20% Next reset: July 31, 16:00 PT",
      "Daily limit: 10% Next reset: July 19, 16:00 PT",
    ].join("\n");

    expect(() => parseGrokUsage(text, meta)).toThrow(ParserDriftError);
  });

  it("rejects conflicting Grok redraw values", () => {
    expect(() =>
      parseGrokUsage(
        [
          "Monthly limit: 10% Next reset: July 31, 16:00 PT",
          "Monthly limit: 30% Next reset: August 31, 16:00 PT",
        ].join("\n"),
        meta
      )
    ).toThrow(ParserDriftError);
  });

  it("does not publish Grok's conditional weekly footer by itself", () => {
    expect(() =>
      parseGrokUsage("[stable] Weekly limit left: 17%", meta)
    ).toThrow(ParserDriftError);
  });

  it("publishes separate Grok weekly and monthly rows", () => {
    const rows = parseGrokUsage(
      [
        "Weekly limit left: 17%",
        "Weekly limit: 83%",
        "Monthly limit: 30% Next reset: August 31, 16:00 PT",
      ].join("\n"),
      meta
    );

    expect(rows.map((row) => row.id)).toEqual(["grok:weekly", "grok:monthly"]);
  });

  it("does not borrow a reset time from the next Grok quota section", () => {
    const rows = parseGrokUsage(
      [
        "Weekly limit: 20%",
        "Monthly limit: 30% Next reset: August 31, 16:00 PT",
      ].join("\n"),
      meta
    );

    expect(rows.find((row) => row.id === "grok:weekly")?.resetLabel).toBeUndefined();
    expect(rows.find((row) => row.id === "grok:monthly")?.resetLabel).toBe(
      "Resets August 31, 16:00 PT"
    );
  });

  it("parses Grok 0.2.67 weekly usage detail and verifies its footer", () => {
    const rows = parseGrokUsage(
      [
        "[stable] Weekly limit left: 0%",
        "Weekly limit: 100% Next reset: July 17, 22:12 PT",
      ].join("\n"),
      meta
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "grok:weekly",
      usedPercent: 100,
      remainingPercent: 0,
      resetLabel: "Resets July 17, 22:12 PT",
    });
  });

  it("tolerates a status-bar fragment glued before Grok's known label", () => {
    const rows = parseGrokUsage(
      "shortcutsXX        Weekly limit: 100%XNext reset: July 17, 22:12 PT",
      meta
    );

    expect(rows[0]).toMatchObject({ id: "grok:weekly", usedPercent: 100 });
  });

  it("tolerates Grok's token counter glued to a known quota heading", () => {
    const rows = parseGrokUsage(
      "2.9K / 500KWeekly limit: 100% Next reset: July 25, 15:12",
      meta
    );

    expect(rows[0]).toMatchObject({ id: "grok:weekly", usedPercent: 100 });
  });

  it("parses current Grok billing labels even when ConPTY glues cells", () => {
    const rows = parseGrokUsage(
      "Usage: 100%Credits: $0Auto topup: disabledPay-as-you-go: $0 used of $10 limit",
      meta
    );

    expect(rows.find((row) => row.id === "grok:usage")).toMatchObject({
      status: "warning",
    });
    expect(rows.find((row) => row.id === "grok:pay-as-you-go")).toMatchObject({
      usedPercent: 0,
      remainingPercent: 100,
    });
  });

  it("does not mistake Grok erased-cell markers for a timezone", () => {
    const rows = parseGrokUsage(
      "Usage: 50% Next reset: July 25, 15:12XXX",
      meta
    );

    expect(rows[0]).toMatchObject({
      id: "grok:usage",
      resetLabel: "Resets July 25, 15:12",
    });
  });

  it("tolerates Grok's erased-cell marker before a known footer", () => {
    const rows = parseGrokUsage(
      "X Weekly limit left: 0%\nWeekly limit: 100%",
      meta
    );

    expect(rows[0]).toMatchObject({
      id: "grok:weekly",
      usedPercent: 100,
      remainingPercent: 0,
    });
  });

  it("tolerates a rotating Grok suggestion before its erased-cell marker", () => {
    const rows = parseGrokUsage(
      "/model menu                 X Weekly limit left: 0%\nWeekly limit: 100%",
      meta
    );

    expect(rows[0]).toMatchObject({
      id: "grok:weekly",
      usedPercent: 100,
      remainingPercent: 0,
    });
  });

  it("rejects a semantic prefix before a known Grok limit", () => {
    expect(() =>
      parseGrokUsage("Fast shortcuts weekly limit: 30%", meta)
    ).toThrow(ParserDriftError);
  });

  it("rejects inconsistent Grok footer and detail percentages", () => {
    expect(() =>
      parseGrokUsage(
        "Weekly limit left: 10%\nWeekly limit: 50%",
        meta
      )
    ).toThrow(ParserDriftError);
  });
});
