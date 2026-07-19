import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeUsage } from "../src/parsers/claude";
import { ParserDriftError } from "../src/parsers/errors";
import type { UsageLimit } from "../src/types";

const meta = {
  checkedAt: "2026-07-18T12:00:00.000Z",
  sourceCommand: "fixture",
  planLabel: "Fixture Plan",
};

describe("Claude usage compatibility", () => {
  it("parses current model-specific and credits sections", async () => {
    const text = await readFile(
      join(import.meta.dirname, "fixtures", "claude-usage-current.txt"),
      "utf8"
    );
    const limits = parseClaudeUsage(text, meta);

    expect(limits).toHaveLength(4);
    expect(pick(limits, "claude:session")).toMatchObject({
      scope: "Current session",
      window: "session",
      usedPercent: 17,
      resetLabel: "Resets 1:23am (Fixture/UTC)",
    });
    expect(pick(limits, "claude:week-all")).toMatchObject({
      scope: "Current week (all models)",
      window: "weekly",
      usedPercent: 42,
    });
    expect(pick(limits, "claude:week-fixture-model")).toMatchObject({
      scope: "Current week (Fixture Model)",
      window: "weekly",
      usedPercent: 63,
    });
    expect(pick(limits, "claude:usage-credits")).toMatchObject({
      scope: "Usage credits",
      usedPercent: 8,
      remainingPercent: 92,
    });
  });

  it("derives stable ids for arbitrary weekly model buckets", () => {
    const limits = parseClaudeUsage(
      usageText([
        "Current week (Haiku Experimental)",
        "9% used",
      ]),
      meta
    );

    expect(pick(limits, "claude:week-haiku-experimental")).toMatchObject({
      scope: "Current week (Haiku Experimental)",
      window: "weekly",
      usedPercent: 9,
    });
  });

  it("accepts the current session row when Claude omits its reset", () => {
    const text = usageText([]).replace(
      "Resets 3:10am (Asia/Seoul)\n",
      ""
    );
    const limits = parseClaudeUsage(text, meta);

    expect(pick(limits, "claude:session")).toMatchObject({
      usedPercent: 3,
      resetLabel: undefined,
    });
  });

  it("still rejects an all-model weekly row without its reset", () => {
    const text = usageText([]).replace(
      "Resets Jul 20, 4pm (Asia/Seoul)",
      ""
    );

    expect(() => parseClaudeUsage(text, meta)).toThrow(ParserDriftError);
  });

  it("keeps the newest complete value when the terminal redraws", () => {
    const first = usageText([]).replace("3% used", "2% used");
    const second = usageText([]).replace("3% used", "7% used");
    const limits = parseClaudeUsage(`${first}\n${second}`, meta);

    expect(pick(limits, "claude:session").usedPercent).toBe(7);
  });

  it("accepts disabled usage credits and keeps the latest live redraw", () => {
    const first = usageText([]).replace("3% used", "9% used");
    const second = usageText([
      "Current week (Fable)",
      "49% used",
      "Resets Jul 21, 3:59pm (Asia/Seoul)",
      "",
      "Usage credits",
      "Usage credits are off · /usage-credits to turn them on",
    ])
      .replace("3% used", "10% used")
      .replace("20% used", "30% used");

    const limits = parseClaudeUsage(`${first}\n${second}`, meta);

    expect(limits.map((limit) => limit.id)).toEqual([
      "claude:session",
      "claude:week-all",
      "claude:week-fable",
    ]);
    expect(pick(limits, "claude:session").usedPercent).toBe(10);
    expect(pick(limits, "claude:week-all").usedPercent).toBe(30);
    expect(pick(limits, "claude:week-fable").usedPercent).toBe(49);
  });

  it("reports drift while usage credits are still loading", () => {
    const text = usageText(["Usage credits", "Loading usage credits..."]);

    expect(() => parseClaudeUsage(text, meta)).toThrow(ParserDriftError);
  });

  it("reports drift rather than silently dropping a new percentage section", () => {
    const text = usageText([
      "Current month (all models)",
      "12% used",
      "Resets Aug 1, 4pm (Asia/Seoul)",
    ]);

    expect(() => parseClaudeUsage(text, meta)).toThrow(ParserDriftError);
  });

  it("reports drift when a recognized section has no value", () => {
    const text = usageText(["Current week (Fable)", "Loading usage data..."]);

    expect(() => parseClaudeUsage(text, meta)).toThrow(ParserDriftError);
  });

  it("reports drift when distinct model labels collapse to the same id", () => {
    const text = usageText([
      "Current week (A+B)",
      "10% used",
      "Current week (A B)",
      "20% used",
    ]);

    expect(() => parseClaudeUsage(text, meta)).toThrow(ParserDriftError);
  });
});

function usageText(extra: string[]): string {
  return [
    "Current session",
    "3% used",
    "Resets 3:10am (Asia/Seoul)",
    "",
    "Current week (all models)",
    "20% used",
    "Resets Jul 20, 4pm (Asia/Seoul)",
    "",
    ...extra,
  ].join("\n");
}

function pick(limits: UsageLimit[], id: string): UsageLimit {
  const limit = limits.find((item) => item.id === id);
  if (!limit) throw new Error(`Missing limit ${id}`);
  return limit;
}
