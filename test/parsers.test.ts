import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanTerminalOutput } from "../src/lib/terminal";
import { parseAgyQuota } from "../src/parsers/agy";
import {
  claudePlanLabel,
  parseClaudeAuthStatus,
  parseClaudeUsage,
} from "../src/parsers/claude";
import { parseCodexFooter } from "../src/parsers/codex";
import { ParserDriftError } from "../src/parsers/errors";
import { parseGrokUsage } from "../src/parsers/grok";
import type { UsageLimit } from "../src/types";

const fixtureDir = join(import.meta.dirname, "fixtures");
const meta = {
  checkedAt: "2026-06-03T12:00:00.000Z",
  sourceCommand: "fixture",
  sourceTimeZone: "Asia/Seoul",
  planLabel: "Fixture Plan",
  accountLabel: "person@example.com",
};

describe("provider parsers", () => {
  it("parses Claude usage fixture", async () => {
    const limits = parseClaudeUsage(await fixture("claude-usage.txt"), meta);
    expect(pick(limits, "claude:session")).toMatchObject({
      usedPercent: 0,
      remainingPercent: 100,
      resetLabel: "Resets 1:29am (Asia/Seoul)",
      status: "available",
    });
    expect(pick(limits, "claude:week-all")).toMatchObject({
      usedPercent: 6,
      remainingPercent: 94,
    });
    expect(pick(limits, "claude:week-sonnet")).toMatchObject({
      usedPercent: 0,
      window: "weekly",
    });
  });

  it("parses Claude usage when the optional Sonnet-only line is absent", () => {
    const text = [
      "Current session",
      "3% used",
      "Resets 3:10am (Asia/Seoul)",
      "",
      "Current week (all models)",
      "20% used",
      "Resets Jun 7, 4pm (Asia/Seoul)",
      "",
      "What's contributing to your limits usage?",
    ].join("\n");
    const limits = parseClaudeUsage(text, meta);
    expect(limits).toHaveLength(2);
    expect(pick(limits, "claude:session")).toMatchObject({ usedPercent: 3 });
    expect(pick(limits, "claude:week-all")).toMatchObject({
      usedPercent: 20,
      sourceText: expect.not.stringContaining("What's contributing"),
    });
    expect(limits.find((l) => l.id === "claude:week-sonnet")).toBeUndefined();
  });

  it("uses configured Claude Max tier label when auth only reports max", () => {
    const auth = parseClaudeAuthStatus("loggedIn: true\nsubscriptionType: max\n");
    expect(claudePlanLabel(auth, "Max 200")).toBe("Max 200");
  });

  it("rejects an implausible required Claude reset and omits an invalid optional one", () => {
    expect(() =>
      parseClaudeUsage(
        [
          "Current session",
          "3% used",
          "Current week (all models)",
          "20% used",
          "Resets in 104000000d",
        ].join("\n"),
        meta
      )
    ).toThrow(ParserDriftError);

    const limits = parseClaudeUsage(
      [
        "Current session",
        "3% used",
        "Resets after billing review",
        "Current week (all models)",
        "20% used",
        "Resets Jun 7, 4pm (Asia/Seoul)",
      ].join("\n"),
      meta
    );
    expect(pick(limits, "claude:session").resetLabel).toBeUndefined();
  });

  it("parses the current JSON Claude auth status without skipping login", () => {
    const auth = parseClaudeAuthStatus(
      JSON.stringify({
        loggedIn: true,
        email: "person@example.com",
        orgId: "org_fixture",
        orgName: "Fixture Organization",
        subscriptionType: "max",
      })
    );

    expect(auth).toEqual({
      loggedIn: true,
      email: "person@example.com",
      orgId: "org_fixture",
      orgName: "Fixture Organization",
      subscriptionType: "max",
    });
  });

  it("parses Codex footer fixture", async () => {
    const limits = parseCodexFooter(await fixture("codex-footer.txt"), meta);
    expect(pick(limits, "codex:context")).toMatchObject({
      remainingPercent: 100,
      usedPercent: 0,
      informational: true,
      status: "available",
    });
    expect(pick(limits, "codex:5h")).toMatchObject({
      remainingPercent: 97,
      usedPercent: 3,
      resetLabel: "Resets 3:41 AM on 4 Jun",
      statusLabel: "gpt-5.5 xhigh fast",
      accountLabel: "person@example.com",
      planLabel: "Pro",
    });
    expect(pick(limits, "codex:weekly")).toMatchObject({
      remainingPercent: 76,
      usedPercent: 24,
      resetLabel: "Resets 12:23 AM on 8 Jun",
    });
    expect(pick(limits, "codex:gpt-5-3-codex-spark:5h")).toMatchObject({
      remainingPercent: 100,
      usedPercent: 0,
      resetLabel: "Resets 4:09 AM on 4 Jun",
      statusLabel: "GPT-5.3-Codex-Spark",
    });
    expect(pick(limits, "codex:gpt-5-3-codex-spark:weekly")).toMatchObject({
      remainingPercent: 100,
      usedPercent: 0,
      resetLabel: "Resets 11:09 PM on 10 Jun",
    });
  });

  it("adds AM/PM to Codex reset times without duplicating existing meridiem", () => {
    const limits = parseCodexFooter(
      [
        "gpt-5.5 xhigh fast · Context 100% left · 5h 80% left · weekly 60% left",
        "5h limit: [################....] 80% left (resets 19:00 on 4 Jun)",
        "Weekly limit: [############........] 60% left (resets 7:30 PM on 8 Jun)",
      ].join("\n"),
      meta
    );

    expect(pick(limits, "codex:5h")).toMatchObject({
      resetLabel: "Resets 7:00 PM on 4 Jun",
    });
    expect(pick(limits, "codex:weekly")).toMatchObject({
      resetLabel: "Resets 7:30 PM on 8 Jun",
    });
  });

  it("parses Codex footer when the final left label is clipped", () => {
    const limits = parseCodexFooter(
      "gpt-5.5 xhigh fast · Context 100% left · 5h 83% left · weekly 74% l",
      meta
    );

    expect(pick(limits, "codex:5h")).toMatchObject({
      remainingPercent: 83,
      usedPercent: 17,
    });
    expect(pick(limits, "codex:weekly")).toMatchObject({
      remainingPercent: 74,
      usedPercent: 26,
    });
  });

  it("rejects out-of-range Codex TUI percentages", () => {
    const footer =
      "gpt-5.5 - Context 100% left - 5h 120% left - weekly 76% left";
    expect(() => parseCodexFooter(footer, meta)).toThrow(ParserDriftError);

    const status = [
      "gpt-5.5 - Context 100% left - 5h 97% left - weekly 76% left",
      "Experimental limit:",
      "5h limit: 120% left (resets 19:00 on 4 Jun)",
    ].join("\n");
    expect(() => parseCodexFooter(status, meta)).toThrow(ParserDriftError);
  });

  it("deduplicates repeated Codex status blocks", () => {
    const limits = parseCodexFooter(
      [
        "gpt-5.5 xhigh fast · Context 100% left · 5h 99% left · weekly 100% left",
        "│  Account:                     person@example.com (Pro)                                   │",
        "│  5h limit:                    [####################] 99% left (resets 00:37 on 26 Jun)  │",
        "│  Weekly limit:                [####################] 100% left (resets 08:30 on 2 Jul)  │",
        "│  GPT-5.3-Codex-Spark limit:                                                             │",
        "│  5h limit:                    [####################] 100% left (resets 02:55 on 26 Jun) │",
        "│  Weekly limit:                [####################] 100% left (resets 21:55 on 2 Jul)  │",
        "gpt-5.5 xhigh fast · Context 100% left · 5h 99% left · weekly 100% left",
        "│  Account:                     person@example.com (Pro)                                   │",
        "│  5h limit:                    [####################] 99% left (resets 00:37 on 26 Jun)  │",
        "│  Weekly limit:                [####################] 100% left (resets 08:30 on 2 Jul)  │",
        "│  GPT-5.3-Codex-Spark limit:                                                             │",
        "│  5h limit:                    [####################] 100% left (resets 02:55 on 26 Jun) │",
        "│  Weekly limit:                [####################] 100% left (resets 21:55 on 2 Jul)  │",
      ].join("\n"),
      meta
    );

    expect(limits).toHaveLength(5);
    expect(limits.filter((l) => l.id === "codex:gpt-5-3-codex-spark:5h")).toHaveLength(1);
    expect(limits.filter((l) => l.id === "codex:gpt-5-3-codex-spark:weekly")).toHaveLength(1);
    expect(pick(limits, "codex:5h")).toMatchObject({
      resetLabel: "Resets 12:37 AM on 26 Jun",
    });
    expect(pick(limits, "codex:gpt-5-3-codex-spark:5h")).toMatchObject({
      resetLabel: "Resets 2:55 AM on 26 Jun",
    });
  });

  it("parses ANSI-heavy Codex footer after cleanup", async () => {
    const raw = (await fixture("codex-ansi.txt")).replaceAll("\\u001b", "\u001b");
    const limits = parseCodexFooter(cleanTerminalOutput(raw), meta);
    expect(pick(limits, "codex:5h")).toMatchObject({
      remainingPercent: 96,
      usedPercent: 4,
      status: "available",
    });
  });

  it("parses Agy grouped quota fixture", async () => {
    const limits = parseAgyQuota(await fixture("agy-quota.txt"), meta);
    expect(limits).toHaveLength(4);
    expect(pick(limits, "agy:gemini-models:weekly")).toMatchObject({
      scope: "Gemini Models",
      window: "weekly",
      remainingPercent: 99.19,
      status: "available",
      resetLabel: "Refreshes in 47h 3m",
    });
    expect(pick(limits, "agy:gemini-models:5h")).toMatchObject({
      scope: "Gemini Models",
      window: "5h",
      remainingPercent: 18,
      usedPercent: 82,
      status: "warning",
      resetLabel: "Refreshes in 5h 0m",
    });
    expect(pick(limits, "agy:claude-and-gpt-models:weekly")).toMatchObject({
      scope: "Claude and GPT Models",
      window: "weekly",
      remainingPercent: 100,
      usedPercent: 0,
      status: "available",
      statusLabel: "Quota available",
    });
    expect(pick(limits, "agy:claude-and-gpt-models:5h")).toMatchObject({
      scope: "Claude and GPT Models",
      window: "5h",
      remainingPercent: 0,
      usedPercent: 100,
      status: "exhausted",
      statusLabel: "Quota exhausted",
    });
  });

  it("does not surface the percent-remaining sentence as a status label", async () => {
    const limits = parseAgyQuota(await fixture("agy-quota.txt"), meta);
    // "99% remaining · Refreshes in 47h 3m" → reset only, no status label.
    expect(pick(limits, "agy:gemini-models:weekly").statusLabel).toBeUndefined();
  });

  it("ignores duplicate Agy redraw frames", () => {
    const group = [
      "GEMINI MODELS",
      "  Models within this group: Gemini Flash",
      "",
      "  Weekly Limit",
      "    [██████████████████████████████████████████████████] 100.00%",
      "    Quota available",
      "",
      "  Five Hour Limit",
      "    [██████████████████████████████████████████████████] 100.00%",
      "    Quota available",
    ];
    const limits = parseAgyQuota([...group, "", ...group].join("\n"), meta);

    expect(limits).toHaveLength(2);
    expect(limits.filter((l) => l.id === "agy:gemini-models:weekly")).toHaveLength(1);
    expect(pick(limits, "agy:gemini-models:5h")).toMatchObject({
      remainingPercent: 100,
      status: "available",
    });
  });

  it("does not show Agy pager text as a quota status", () => {
    const limits = parseAgyQuota(
      [
        "GEMINI MODELS",
        "  Models within this group: Gemini Flash",
        "",
        "  Weekly Limit",
        "    [██████████████████████████████████████████████████] 100.00%",
        "  ↑/↓ Scroll · pgup/pgdown Page · ctrl+end Bottom · esc Close",
      ].join("\n"),
      meta
    );

    expect(pick(limits, "agy:gemini-models:weekly")).toMatchObject({
      remainingPercent: 100,
      status: "available",
      statusLabel: "Quota available",
    });
  });

  it("parses Grok /usage show output", async () => {
    const limits = parseGrokUsage(await fixture("grok-usage.txt"), meta);
    expect(pick(limits, "grok:monthly")).toMatchObject({
      scope: "Monthly limit",
      window: "monthly",
      usedPercent: 44,
      remainingPercent: 56,
      status: "available",
      resetLabel: "Resets July 31, 16:00 PT",
    });
  });

  it("reads Grok /usage show through status-bar artifacts", () => {
    const limits = parseGrokUsage(
      "Ctrl+x:shortcutsX │ 458 / 200K │ Monthly limit: 100%XNext reset: Aug 1, 09:00 PT q",
      meta
    );

    expect(pick(limits, "grok:monthly")).toMatchObject({
      remainingPercent: 0,
      usedPercent: 100,
      status: "exhausted",
      resetLabel: "Resets Aug 1, 09:00 PT",
    });
  });

  it("accepts the current zone-less Grok reset and unknown-period fallback", () => {
    const limits = parseGrokUsage(
      "Usage: 50% · Next reset: Mar 31, 12:00",
      meta
    );

    expect(pick(limits, "grok:usage")).toMatchObject({
      usedPercent: 50,
      remainingPercent: 50,
      resetLabel: "Resets Mar 31, 12:00",
    });
  });

  it("keeps paid Grok continuation capacity visible after included usage", () => {
    const limits = parseGrokUsage(
      [
        "Usage: 100%",
        "Credits: $5.00",
        "Auto topup: disabled",
        "Pay-as-you-go: $2.00 used of $10.00 limit",
      ].join("\n"),
      meta
    );

    expect(pick(limits, "grok:usage")).toMatchObject({
      usedPercent: 100,
      remainingPercent: 0,
      status: "warning",
      statusLabel: "Included usage exhausted; paid usage remains available",
    });
    expect(pick(limits, "grok:credits")).toMatchObject({
      status: "available",
      informational: true,
      statusLabel: "$5.00 available",
    });
    expect(pick(limits, "grok:pay-as-you-go")).toMatchObject({
      usedPercent: 20,
      remainingPercent: 80,
      status: "available",
    });
    expect(pick(limits, "grok:auto-topup")).toMatchObject({
      informational: true,
      statusLabel: "Disabled",
    });
  });

  it("fails closed on malformed or contradictory Grok billing fields", () => {
    expect(() =>
      parseGrokUsage("Usage: 50%\nAuto topup: maybe", meta)
    ).toThrow(ParserDriftError);
    expect(() =>
      parseGrokUsage("Usage: 50%\nCredits: $1\nCredits: $2", meta)
    ).toThrow(ParserDriftError);
    expect(() =>
      parseGrokUsage(
        "Usage: 50%\nPay-as-you-go: $11 used of $10 limit",
        meta
      )
    ).toThrow(ParserDriftError);
  });

  it("rejects partial warning footers and inconsistent duplicate values", () => {
    expect(() =>
      parseGrokUsage("Weekly limit left: 9%", meta)
    ).toThrow(ParserDriftError);
    expect(() =>
      parseGrokUsage(
        "Weekly limit: 20%\nWeekly limit: 21%\nWeekly limit left: 80%",
        meta
      )
    ).toThrow(ParserDriftError);
  });

  it("throws drift when anchors are missing", async () => {
    const text = await fixture("drift.txt");
    expect(() => parseClaudeUsage(text, meta)).toThrow(ParserDriftError);
    expect(() => parseCodexFooter(text, meta)).toThrow(ParserDriftError);
    expect(() => parseAgyQuota(text, meta)).toThrow(ParserDriftError);
    expect(() => parseGrokUsage(text, meta)).toThrow(ParserDriftError);
  });
});

async function fixture(name: string): Promise<string> {
  return readFile(join(fixtureDir, name), "utf8");
}

function pick(limits: UsageLimit[], id: string): UsageLimit {
  const limit = limits.find((item) => item.id === id);
  if (!limit) throw new Error(`Missing limit ${id}`);
  return limit;
}
