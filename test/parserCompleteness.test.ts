import { describe, expect, it } from "vitest";
import { parseAgyQuota } from "../src/parsers/agy";
import { parseGrokUsage } from "../src/parsers/grok";
import { ParserDriftError } from "../src/parsers/errors";

const meta = {
  checkedAt: "2026-07-18T00:00:00.000Z",
  sourceCommand: "fixture",
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

  it("uses the latest Grok redraw", () => {
    const rows = parseGrokUsage(
      [
        "Monthly limit: 10% Next reset: July 31, 16:00 PT",
        "Monthly limit: 30% Next reset: August 31, 16:00 PT",
      ].join("\n"),
      meta
    );

    expect(rows[0]).toMatchObject({
      usedPercent: 30,
      resetLabel: "Resets August 31, 16:00 PT",
    });
  });

  it("parses Grok's current weekly footer as remaining quota", () => {
    const rows = parseGrokUsage("[stable] Weekly limit left: 17%", meta);

    expect(rows[0]).toMatchObject({
      id: "grok:weekly",
      remainingPercent: 17,
      usedPercent: 83,
    });
  });

  it("publishes separate Grok weekly and monthly rows", () => {
    const rows = parseGrokUsage(
      [
        "Weekly limit left: 17%",
        "Monthly limit: 30% Next reset: August 31, 16:00 PT",
      ].join("\n"),
      meta
    );

    expect(rows.map((row) => row.id)).toEqual(["grok:weekly", "grok:monthly"]);
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
