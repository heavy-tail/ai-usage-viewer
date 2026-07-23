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
const USAGE_USED_RE = /Usage:\s*(\d+(?:\.\d+)?)%/gi;
const MONTHLY_LEFT_RE = /Monthly limit left:\s*(\d+(?:\.\d+)?)%/gi;
const WEEKLY_LEFT_RE = /Weekly limit left:\s*(\d+(?:\.\d+)?)%/gi;
const CREDITS_RE = /Credits:\s*\$?\s*([\d,]+(?:\.\d+)?)/gi;
const AUTO_TOPUP_RE = /Auto topup:\s*(enabled|disabled|on|off|yes|no)/gi;
const MAX_MONTHLY_TOPUP_RE =
  /Max monthly topup:\s*\$?\s*([\d,]+(?:\.\d+)?)/gi;
const PAY_AS_YOU_GO_RE =
  /Pay-as-you-go:\s*\$?\s*([\d,]+(?:\.\d+)?)\s+used\s+of\s+\$?\s*([\d,]+(?:\.\d+)?)\s+limit/gi;
const BILLING_LABEL_RE =
  /(Credits|Auto topup|Max monthly topup|Pay-as-you-go):/gi;
const RESET_RE =
  /Next reset:\s*([A-Za-z]{3,9}\s+\d{1,2},\s*\d{1,2}:\d{2}(?:\s*[A-Za-z]{2,4})?)/i;
const LIMIT_PERCENT_RE =
  /((?:[A-Za-z][A-Za-z -]*limit(?:\s+left)?|Usage)):\s*(\d+(?:\.\d+)?)%/gi;

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
    "usage",
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

  const billing = parseBillingContinuation(text);
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
    const included = limitFromUsed({
      id: "grok:usage",
      provider: "grok",
      providerLabel: "Grok",
      scope: "Included usage",
      window: "usage",
      usedPercent: usageUsedPercent,
      resetLabel: reset?.label,
      resetAt: reset?.at,
      sourceText: `Usage: ${usageUsed[1]}%${reset ? ` · Next reset: ${reset.raw}` : ""}`,
      meta,
    });
    limits.push(
      included.status === "exhausted" && billing.hasContinuationCapacity
        ? {
            ...included,
            status: "warning",
            statusLabel: "Included usage exhausted; paid usage remains available",
          }
        : included
    );
  }

  limits.push(...billingRows(billing, meta));
  return limits;
}

type BillingContinuation = {
  credits?: number;
  autoTopup?: boolean;
  maxMonthlyTopup?: number;
  payAsYouGo?: { used: number; limit: number };
  hasContinuationCapacity: boolean;
};

function parseBillingContinuation(text: string): BillingContinuation {
  const labels = new Set(
    [...text.matchAll(BILLING_LABEL_RE)].map((match) =>
      normalizeLabel(match[1])
    )
  );
  BILLING_LABEL_RE.lastIndex = 0;

  const credits = consistentMoney(text, CREDITS_RE, "credits");
  const autoTopupText = consistentText(text, AUTO_TOPUP_RE, "auto topup");
  const maxMonthlyTopup = consistentMoney(
    text,
    MAX_MONTHLY_TOPUP_RE,
    "maximum monthly topup"
  );
  const payAsYouGo = consistentMoneyPair(
    text,
    PAY_AS_YOU_GO_RE,
    "pay-as-you-go"
  );
  const parsedLabels = new Set<string>();
  if (credits !== undefined) parsedLabels.add("credits");
  if (autoTopupText !== undefined) parsedLabels.add("auto topup");
  if (maxMonthlyTopup !== undefined) parsedLabels.add("max monthly topup");
  if (payAsYouGo !== undefined) parsedLabels.add("pay-as-you-go");
  if ([...labels].some((label) => !parsedLabels.has(label))) {
    throw new ParserDriftError(
      "Grok output contained an unrecognized billing-continuation value.",
      text
    );
  }

  const autoTopup =
    autoTopupText === undefined
      ? undefined
      : ["enabled", "on", "yes"].includes(autoTopupText);
  if (maxMonthlyTopup !== undefined && autoTopup === undefined) {
    throw new ParserDriftError(
      "Grok output reported a top-up maximum without an auto-topup state.",
      text
    );
  }
  if (
    payAsYouGo !== undefined &&
    (payAsYouGo.used > payAsYouGo.limit ||
      (payAsYouGo.limit === 0 && payAsYouGo.used !== 0))
  ) {
    throw new ParserDriftError(
      "Grok output reported inconsistent pay-as-you-go amounts.",
      text
    );
  }
  const payAsYouGoRemaining =
    payAsYouGo === undefined
      ? 0
      : Math.max(0, payAsYouGo.limit - payAsYouGo.used);
  const hasContinuationCapacity =
    (credits ?? 0) > 0 ||
    payAsYouGoRemaining > 0 ||
    (autoTopup === true && (maxMonthlyTopup === undefined || maxMonthlyTopup > 0));

  return {
    credits,
    autoTopup,
    maxMonthlyTopup,
    payAsYouGo,
    hasContinuationCapacity,
  };
}

function billingRows(
  billing: BillingContinuation,
  meta: ParserMeta
): UsageLimit[] {
  const rows: UsageLimit[] = [];
  if (billing.credits !== undefined) {
    rows.push({
      id: "grok:credits",
      provider: "grok",
      providerLabel: "Grok",
      planLabel: meta.planLabel,
      accountLabel: meta.accountLabel,
      scope: "Prepaid credits",
      window: "billing-credit",
      status: billing.credits > 0 ? "available" : "exhausted",
      statusLabel:
        billing.credits > 0
          ? `$${billing.credits.toFixed(2)} available`
          : "No prepaid credits",
      informational: true,
      sourceCommand: meta.sourceCommand,
      sourceText: `Credits: $${billing.credits.toFixed(2)}`,
      checkedAt: meta.checkedAt,
    });
  }
  if (billing.payAsYouGo !== undefined) {
    const { used, limit } = billing.payAsYouGo;
    if (limit > 0 && used <= limit) {
      rows.push(
        limitFromUsed({
          id: "grok:pay-as-you-go",
          provider: "grok",
          providerLabel: "Grok",
          scope: "Pay-as-you-go",
          window: "spend-control",
          usedPercent: (used / limit) * 100,
          statusLabel: `$${used.toFixed(2)} of $${limit.toFixed(2)}`,
          sourceText: `Pay-as-you-go: $${used.toFixed(2)} used of $${limit.toFixed(2)} limit`,
          meta,
        })
      );
    } else {
      rows.push({
        id: "grok:pay-as-you-go",
        provider: "grok",
        providerLabel: "Grok",
        planLabel: meta.planLabel,
        accountLabel: meta.accountLabel,
        scope: "Pay-as-you-go",
        window: "spend-control",
        status: "unknown",
        statusLabel: `$${used.toFixed(2)} used; no positive cap reported`,
        informational: true,
        sourceCommand: meta.sourceCommand,
        sourceText: `Pay-as-you-go: $${used.toFixed(2)} used of $${limit.toFixed(2)} limit`,
        checkedAt: meta.checkedAt,
      });
    }
  }
  if (billing.autoTopup !== undefined) {
    rows.push({
      id: "grok:auto-topup",
      provider: "grok",
      providerLabel: "Grok",
      planLabel: meta.planLabel,
      accountLabel: meta.accountLabel,
      scope: "Automatic top-up",
      window: "billing-continuation",
      status: billing.autoTopup ? "available" : "unknown",
      statusLabel: billing.autoTopup
        ? billing.maxMonthlyTopup === undefined
          ? "Enabled"
          : `Enabled · $${billing.maxMonthlyTopup.toFixed(2)} monthly maximum`
        : "Disabled",
      informational: true,
      sourceCommand: meta.sourceCommand,
      sourceText: [
        `Auto topup: ${billing.autoTopup ? "enabled" : "disabled"}`,
        billing.maxMonthlyTopup === undefined
          ? undefined
          : `Max monthly topup: $${billing.maxMonthlyTopup.toFixed(2)}`,
      ]
        .filter(Boolean)
        .join("\n"),
      checkedAt: meta.checkedAt,
    });
  }
  return rows;
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
    throw new ParserDriftError(
      `Grok output contained an invalid reset time (${JSON.stringify(raw)}).`,
      text
    );
  }
  const delta = instant.getTime() - checkedAt;
  if (delta < -5 * 60_000 || delta > maxFutureMs) {
    throw new ParserDriftError(
      `Grok output contained a reset outside the plausible quota horizon (${JSON.stringify(raw)}).`,
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

function consistentMoney(
  text: string,
  pattern: RegExp,
  label: string
): number | undefined {
  const match = consistentCaptures(text, pattern, label);
  if (!match) return undefined;
  const value = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(value) || value < 0) {
    throw new ParserDriftError(
      `Grok output contained an invalid ${label} amount.`,
      text
    );
  }
  return value;
}

function consistentMoneyPair(
  text: string,
  pattern: RegExp,
  label: string
): { used: number; limit: number } | undefined {
  const match = consistentCaptures(text, pattern, label);
  if (!match) return undefined;
  const used = Number(match[1].replace(/,/g, ""));
  const limit = Number(match[2].replace(/,/g, ""));
  if (
    !Number.isFinite(used) ||
    !Number.isFinite(limit) ||
    used < 0 ||
    limit < 0
  ) {
    throw new ParserDriftError(
      `Grok output contained invalid ${label} amounts.`,
      text
    );
  }
  return { used, limit };
}

function consistentText(
  text: string,
  pattern: RegExp,
  label: string
): string | undefined {
  return consistentCaptures(text, pattern, label)?.[1].toLowerCase();
}

function consistentCaptures(
  text: string,
  pattern: RegExp,
  label: string
): RegExpMatchArray | undefined {
  pattern.lastIndex = 0;
  const matches = [...text.matchAll(pattern)];
  pattern.lastIndex = 0;
  if (matches.length === 0) return undefined;
  const signatures = matches.map((match) =>
    match
      .slice(1)
      .map((value) => value.replace(/,/g, "").toLowerCase())
      .join("\u0000")
  );
  if (signatures.some((value) => value !== signatures[0])) {
    throw new ParserDriftError(
      `Grok output contained inconsistent ${label} values.`,
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
      /^.*\bx+\s+(?=(?:(?:monthly|weekly) limit(?: left)?|usage)$)/,
      ""
    );
  // The status bar can glue the trailing K/M suffix of a token counter (for
  // example "2.9K / 500KWeekly limit") to the quota heading. Strip that one
  // character only when the original match begins immediately after a digit;
  // semantic prefixes such as "Fast weekly limit" remain unknown and fail.
  return /\d/.test(preceding ?? "") &&
    /^[km](?:(?:monthly|weekly) limit(?: left)?|usage)$/.test(normalized)
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
    // ConPTY represents erased status-bar cells as trailing X characters. They
    // can be glued directly to the minute and look like a timezone token.
    .replace(/X{1,8}$/, "")
    .trim();
}
