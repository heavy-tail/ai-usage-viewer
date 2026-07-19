import type { UsageLimit } from "../types";
import { resolveResetInstant } from "../lib/resetTime";
import { limitFromUsed, type ParserMeta } from "./common";
import { ParserDriftError } from "./errors";

// Grok moved quota out of the launch footer into the `/usage show` command
// (labelled "View credit usage" in the CLI). Its output, printed into the
// status area, reads:
//   Monthly limit: 5%   Next reset: July 31, 16:00
// The percentage is the amount USED — the command reports "credit usage", and
// Conditional remaining-style footers are cross-checks, never complete rows.
// (ConPTY may glue a stray cursor char between the two fields, e.g.
// "Monthly limit: 5%XNext reset: …", so each field is matched independently.)
const MONTHLY_RE = /Monthly limit:\s*(\d+(?:\.\d+)?)%/gi;
const WEEKLY_USED_RE = /Weekly limit:\s*(\d+(?:\.\d+)?)%/gi;
const USAGE_USED_RE = /Usage limit:\s*(\d+(?:\.\d+)?)%/gi;
const MONTHLY_LEFT_RE = /Monthly limit left:\s*(\d+(?:\.\d+)?)%/gi;
const WEEKLY_LEFT_RE = /Weekly limit left:\s*(\d+(?:\.\d+)?)%/gi;
const RESET_RE =
  /Next reset:\s*([A-Za-z]{3,9}\s+\d{1,2},\s*\d{1,2}:\d{2}(?:\s*[A-Za-z]{2,4})?)/i;
const LIMIT_PERCENT_RE =
  /([A-Za-z][A-Za-z -]*limit(?:\s+left)?):\s*(\d+(?:\.\d+)?)%/gi;

export function parseGrokUsage(text: string, meta: ParserMeta): UsageLimit[] {
  const monthly = consistentLatest(text, MONTHLY_RE, "monthly used");
  const weeklyUsed = consistentLatest(text, WEEKLY_USED_RE, "weekly used");
  const usageUsed = consistentLatest(text, USAGE_USED_RE, "usage used");
  const monthlyLeft = consistentLatest(text, MONTHLY_LEFT_RE, "monthly left");
  const weeklyLeft = consistentLatest(text, WEEKLY_LEFT_RE, "weekly left");
  if (!monthly && !weeklyUsed && !usageUsed) {
    throw new ParserDriftError(
      "Grok output did not contain a complete weekly, monthly, or usage limit.",
      text
    );
  }

  const knownLabels = new Set([
    "monthly limit",
    "monthly limit left",
    "weekly limit",
    "weekly limit left",
    "usage limit",
  ]);
  const unknown = [...text.matchAll(LIMIT_PERCENT_RE)].find(
    (candidate) => {
      const preceding =
        candidate.index && candidate.index > 0
          ? text[candidate.index - 1]
          : undefined;
      const label = normalizeLimitLabel(candidate[1], preceding);
      return !knownLabels.has(label);
    }
  );
  const usedPercent = monthly ? Number(monthly[1]) : undefined;
  const weeklyUsedPercent = weeklyUsed ? Number(weeklyUsed[1]) : undefined;
  const usageUsedPercent = usageUsed ? Number(usageUsed[1]) : undefined;
  const monthlyRemainingPercent = monthlyLeft
    ? Number(monthlyLeft[1])
    : undefined;
  const weeklyRemainingPercent = weeklyLeft ? Number(weeklyLeft[1]) : undefined;
  const invalidPercent = [
    usedPercent,
    monthlyRemainingPercent,
    weeklyRemainingPercent,
    weeklyUsedPercent,
    usageUsedPercent,
  ].some(
    (value) =>
      value !== undefined &&
      (!Number.isFinite(value) || value < 0 || value > 100)
  );
  const inconsistentCrossCheck =
    (weeklyUsedPercent !== undefined &&
      weeklyRemainingPercent !== undefined &&
      Math.abs(weeklyUsedPercent + weeklyRemainingPercent - 100) > 0.11) ||
    (usedPercent !== undefined &&
      monthlyRemainingPercent !== undefined &&
      Math.abs(usedPercent + monthlyRemainingPercent - 100) > 0.11);
  const footerWithoutDetail =
    (weeklyLeft !== undefined && weeklyUsed === undefined) ||
    (monthlyLeft !== undefined && monthly === undefined);
  if (unknown || invalidPercent || inconsistentCrossCheck || footerWithoutDetail) {
    const reason = unknown
      ? "unknown limit label"
      : invalidPercent
        ? "percentage outside 0-100"
        : inconsistentCrossCheck
          ? "footer/detail mismatch"
          : "conditional footer without detail";
    throw new ParserDriftError(
      `Grok output contained an unrecognized or invalid usage limit (${reason}).`,
      text
    );
  }

  const limits: UsageLimit[] = [];
  if (weeklyUsed && weeklyUsedPercent !== undefined) {
    const reset = parsedReset(text, weeklyUsed, meta, 8 * 24 * 60 * 60_000);
    limits.push(
      limitFromUsed({
        id: "grok:weekly",
        provider: "grok",
        providerLabel: "Grok",
        scope: "Weekly limit",
        window: "weekly",
        usedPercent: weeklyUsedPercent,
        resetLabel: reset?.label,
        resetAt: reset?.at,
        sourceText: [
          weeklyLeft ? `Weekly limit left: ${weeklyLeft[1]}%` : undefined,
          `Weekly limit: ${weeklyUsed[1]}%${reset ? ` · Next reset: ${reset.raw}` : ""}`,
        ]
          .filter(Boolean)
          .join("\n"),
        meta,
      })
    );
  }

  if (monthly && monthly.index !== undefined && usedPercent !== undefined) {
    const reset = parsedReset(text, monthly, meta, 62 * 24 * 60 * 60_000);
    limits.push(limitFromUsed({
      id: "grok:monthly",
      provider: "grok",
      providerLabel: "Grok",
      scope: "Monthly limit",
      window: "monthly",
      usedPercent,
      resetLabel: reset?.label,
      resetAt: reset?.at,
      sourceText: `Monthly limit: ${monthly[1]}%${reset ? ` · Next reset: ${reset.raw}` : ""}`,
      meta,
    }));
  }

  if (usageUsed && usageUsedPercent !== undefined) {
    const reset = parsedReset(text, usageUsed, meta, 370 * 24 * 60 * 60_000);
    limits.push(limitFromUsed({
      id: "grok:usage",
      provider: "grok",
      providerLabel: "Grok",
      scope: "Usage limit",
      window: "usage",
      usedPercent: usageUsedPercent,
      resetLabel: reset?.label,
      resetAt: reset?.at,
      sourceText: `Usage limit: ${usageUsed[1]}%${reset ? ` · Next reset: ${reset.raw}` : ""}`,
      meta,
    }));
  }

  return limits;
}

function parsedReset(
  text: string,
  match: RegExpMatchArray,
  meta: ParserMeta,
  maxFutureMs: number
): { raw: string; label: string; at: string } | undefined {
  const raw = resetAfter(text, match);
  if (!raw) return undefined;
  const label = `Resets ${raw}`;
  const instant = resolveResetInstant(
    { checkedAt: meta.checkedAt, resetLabel: label },
    meta.sourceTimeZone
  );
  const checkedAt = Date.parse(meta.checkedAt);
  if (!instant || !Number.isFinite(checkedAt)) {
    throw new ParserDriftError("Grok output contained an invalid reset time.", text);
  }
  const delta = instant.getTime() - checkedAt;
  if (delta < -5 * 60_000 || delta > maxFutureMs) {
    throw new ParserDriftError(
      "Grok output contained a reset outside the plausible quota horizon.",
      text
    );
  }
  return { raw, label, at: instant.toISOString() };
}

function consistentLatest(
  text: string,
  pattern: RegExp,
  label: string
): RegExpMatchArray | undefined {
  pattern.lastIndex = 0;
  const matches = [...text.matchAll(pattern)];
  pattern.lastIndex = 0;
  if (matches.length === 0) return undefined;
  const values = matches.map((match) => Number(match[1]));
  if (
    values.some((value) => !Number.isFinite(value) || value < 0 || value > 100) ||
    values.some((value) => Math.abs(value - values[0]) > 0.11)
  ) {
    throw new ParserDriftError(
      `Grok output contained inconsistent ${label} percentages.`,
      text
    );
  }
  return matches[matches.length - 1];
}

function normalizeLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeLimitLabel(value: string, preceding?: string): string {
  const normalized = normalizeLabel(value)
    .replace(/^\[stable\]\s+/, "")
    // Current ConPTY output can glue the known shortcuts status fragment to
    // the label. Strip only that observed artifact; arbitrary semantic
    // prefixes must remain visible to the fail-closed unknown-label check.
    .replace(/^shortcutsx*\s+/, "")
    // ConPTY's erased-cell placeholder can survive as a standalone X directly
    // before a known status-bar quota label.
    .replace(
      /^.*\bx+\s+(?=(?:monthly|weekly|usage) limit(?: left)?$)/,
      ""
    );
  // The status bar can glue the trailing K/M suffix of a token counter (for
  // example "2.9K / 500KWeekly limit") to the quota heading. Strip that one
  // character only when the original match begins immediately after a digit;
  // semantic prefixes such as "Fast weekly limit" remain unknown and fail.
  return /\d/.test(preceding ?? "") &&
    /^[km](?:monthly|weekly|usage) limit(?: left)?$/.test(normalized)
    ? normalized.slice(1)
    : normalized;
}

function resetAfter(text: string, match: RegExpMatchArray): string | undefined {
  if (match.index === undefined) return undefined;
  const trailing = text.slice(match.index + match[0].length);
  LIMIT_PERCENT_RE.lastIndex = 0;
  const nextLimit = LIMIT_PERCENT_RE.exec(trailing);
  LIMIT_PERCENT_RE.lastIndex = 0;
  const section = trailing.slice(0, nextLimit?.index ?? trailing.length);
  return section
    .match(RESET_RE)?.[1]
    ?.replace(/\s+/g, " ")
    .trim();
}
