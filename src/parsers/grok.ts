import type { UsageLimit } from "../types";
import { limitFromRemaining, limitFromUsed, type ParserMeta } from "./common";
import { ParserDriftError } from "./errors";

// Grok moved quota out of the launch footer into the `/usage show` command
// (labelled "View credit usage" in the CLI). Its output, printed into the
// status area, reads:
//   Monthly limit: 5%   Next reset: July 31, 16:00 PT
// The percentage is the amount USED — the command reports "credit usage", and
// the old remaining-style "Monthly limit left: N%" footer no longer exists.
// (ConPTY may glue a stray cursor char between the two fields, e.g.
// "Monthly limit: 5%XNext reset: …", so each field is matched independently.)
const MONTHLY_RE = /Monthly limit:\s*(\d+(?:\.\d+)?)%/gi;
const WEEKLY_USED_RE = /Weekly limit:\s*(\d+(?:\.\d+)?)%/gi;
const WEEKLY_LEFT_RE = /Weekly limit left:\s*(\d+(?:\.\d+)?)%/gi;
const RESET_RE =
  /Next reset:\s*([A-Za-z]+\s+\d{1,2},\s*\d{1,2}:\d{2}\s*[A-Za-z]{2,4})/i;
const LIMIT_PERCENT_RE =
  /([A-Za-z][A-Za-z -]*limit(?:\s+left)?):\s*(\d+(?:\.\d+)?)%/gi;

export function parseGrokUsage(text: string, meta: ParserMeta): UsageLimit[] {
  const matches = [...text.matchAll(MONTHLY_RE)];
  const monthly = matches[matches.length - 1];
  const weeklyUsedMatches = [...text.matchAll(WEEKLY_USED_RE)];
  const weeklyUsed = weeklyUsedMatches[weeklyUsedMatches.length - 1];
  const weeklyMatches = [...text.matchAll(WEEKLY_LEFT_RE)];
  const weekly = weeklyMatches[weeklyMatches.length - 1];
  if (!monthly && !weeklyUsed && !weekly) {
    throw new ParserDriftError(
      "Grok output did not contain a recognized weekly or monthly limit.",
      text
    );
  }

  const knownLabels = new Set([
    "monthly limit",
    "weekly limit",
    "weekly limit left",
  ]);
  const unknown = [...text.matchAll(LIMIT_PERCENT_RE)].find(
    (candidate) => {
      const label = normalizeLimitLabel(candidate[1]);
      return !knownLabels.has(label);
    }
  );
  const usedPercent = monthly ? Number(monthly[1]) : undefined;
  const weeklyUsedPercent = weeklyUsed ? Number(weeklyUsed[1]) : undefined;
  const remainingPercent = weekly ? Number(weekly[1]) : undefined;
  if (
    unknown ||
    (usedPercent !== undefined &&
      (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100)) ||
    (remainingPercent !== undefined &&
      (!Number.isFinite(remainingPercent) ||
        remainingPercent < 0 ||
        remainingPercent > 100)) ||
    (weeklyUsedPercent !== undefined &&
      (!Number.isFinite(weeklyUsedPercent) ||
        weeklyUsedPercent < 0 ||
        weeklyUsedPercent > 100)) ||
    (weeklyUsedPercent !== undefined &&
      remainingPercent !== undefined &&
      Math.abs(weeklyUsedPercent + remainingPercent - 100) > 0.11)
  ) {
    throw new ParserDriftError(
      "Grok output contained an unrecognized or invalid usage limit.",
      text
    );
  }

  const limits: UsageLimit[] = [];
  if (weeklyUsed && weeklyUsedPercent !== undefined) {
    const reset = resetAfter(text, weeklyUsed);
    limits.push(
      limitFromUsed({
        id: "grok:weekly",
        provider: "grok",
        providerLabel: "Grok",
        scope: "Weekly limit",
        window: "weekly",
        usedPercent: weeklyUsedPercent,
        resetLabel: reset ? `Resets ${reset}` : undefined,
        sourceText: [
          weekly ? `Weekly limit left: ${weekly[1]}%` : undefined,
          `Weekly limit: ${weeklyUsed[1]}%${reset ? ` · Next reset: ${reset}` : ""}`,
        ]
          .filter(Boolean)
          .join("\n"),
        meta,
      })
    );
  } else if (weekly && remainingPercent !== undefined) {
    limits.push(
      limitFromRemaining({
        id: "grok:weekly",
        provider: "grok",
        providerLabel: "Grok",
        scope: "Weekly limit",
        window: "weekly",
        remainingPercent,
        sourceText: `Weekly limit left: ${weekly[1]}%`,
        meta,
      })
    );
  }

  if (monthly && monthly.index !== undefined && usedPercent !== undefined) {
    const reset = resetAfter(text, monthly);
    limits.push(limitFromUsed({
      id: "grok:monthly",
      provider: "grok",
      providerLabel: "Grok",
      scope: "Monthly limit",
      window: "monthly",
      usedPercent,
      resetLabel: reset ? `Resets ${reset}` : undefined,
      sourceText: `Monthly limit: ${monthly[1]}%${reset ? ` · Next reset: ${reset}` : ""}`,
      meta,
    }));
  }

  return limits;
}

function normalizeLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeLimitLabel(value: string): string {
  return normalizeLabel(value)
    .replace(/^\[stable\]\s+/, "")
    // Current ConPTY output can glue the known shortcuts status fragment to
    // the label. Strip only that observed artifact; arbitrary semantic
    // prefixes must remain visible to the fail-closed unknown-label check.
    .replace(/^shortcutsx*\s+/, "");
}

function resetAfter(text: string, match: RegExpMatchArray): string | undefined {
  if (match.index === undefined) return undefined;
  return text
    .slice(match.index + match[0].length)
    .match(RESET_RE)?.[1]
    ?.replace(/\s+/g, " ")
    .trim();
}
