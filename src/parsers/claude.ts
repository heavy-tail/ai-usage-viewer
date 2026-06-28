import type { UsageLimit } from "../types";
import { EMAIL_PATTERN } from "../lib/patterns";
import { limitFromUsed, type ParserMeta } from "./common";
import { ParserDriftError } from "./errors";

const EMAIL_RE = new RegExp(EMAIL_PATTERN, "i");

export type ClaudeAuthStatus = {
  loggedIn: boolean;
  email?: string;
  orgId?: string;
  orgName?: string;
  subscriptionType?: string;
};

export function parseClaudeUsage(text: string, meta: ParserMeta): UsageLimit[] {
  const session = text.match(
    /Current session[\s\S]*?(\d+(?:\.\d+)?)%\s+used[\s\S]*?Resets\s+([^\n]+)/i
  );
  const weekAll = text.match(
    /Current week\s*\(all models\)[\s\S]*?(\d+(?:\.\d+)?)%\s+used[\s\S]*?Resets\s+([^\n]+)/i
  );
  const weekSonnet = text.match(
    /Current week\s*\(Sonnet only\)[\s\S]*?(\d+(?:\.\d+)?)%\s+used/i
  );

  if (!session || !weekAll || !weekSonnet) {
    throw new ParserDriftError(
      "Claude usage output did not contain the required usage sections.",
      text
    );
  }

  return [
    limitFromUsed({
      id: "claude:session",
      provider: "claude",
      providerLabel: "Claude Code",
      scope: "Current session",
      window: "session",
      usedPercent: Number(session[1]),
      resetLabel: `Resets ${session[2].trim()}`,
      sourceText: sectionText(text, "Current session"),
      meta,
    }),
    limitFromUsed({
      id: "claude:week-all",
      provider: "claude",
      providerLabel: "Claude Code",
      scope: "Current week (all models)",
      window: "weekly",
      usedPercent: Number(weekAll[1]),
      resetLabel: `Resets ${weekAll[2].trim()}`,
      sourceText: sectionText(text, "Current week (all models)"),
      meta,
    }),
    limitFromUsed({
      id: "claude:week-sonnet",
      provider: "claude",
      providerLabel: "Claude Code",
      scope: "Current week (Sonnet only)",
      window: "weekly",
      usedPercent: Number(weekSonnet[1]),
      sourceText: sectionText(text, "Current week (Sonnet only)"),
      meta,
    }),
  ];
}

export function parseClaudeAuthStatus(text: string): ClaudeAuthStatus {
  const loggedInFalse = /loggedIn\s*[:=]\s*false|not\s+logged\s+in/i.test(text);
  const loggedInTrue = /loggedIn\s*[:=]\s*true|logged\s+in/i.test(text);
  const email = text.match(EMAIL_RE)?.[0];
  const orgId = text.match(/\borgId\s*[:=]\s*['"]?([A-Za-z0-9_-]+)/i)?.[1];
  const orgName = text.match(/\borgName\s*[:=]\s*['"]?([^\n'"]+)/i)?.[1]?.trim();
  const subscriptionType = text
    .match(/\bsubscriptionType\s*[:=]\s*['"]?([A-Za-z0-9_-]+)/i)?.[1]
    ?.trim();

  return {
    loggedIn: loggedInTrue && !loggedInFalse,
    email,
    orgId,
    orgName,
    subscriptionType,
  };
}

export function claudePlanLabel(
  auth: ClaudeAuthStatus,
  fallback?: string
): string | undefined {
  if (!auth.subscriptionType) return fallback;
  if (auth.subscriptionType.toLowerCase() === "max" && fallback) return fallback;
  return auth.subscriptionType.charAt(0).toUpperCase() + auth.subscriptionType.slice(1);
}

function sectionText(text: string, header: string): string {
  const start = text.indexOf(header);
  if (start < 0) return text;
  const next = text
    .slice(start + header.length)
    .search(/\nCurrent (?:session|week)/);
  if (next < 0) return text.slice(start).trim();
  return text.slice(start, start + header.length + next).trim();
}
