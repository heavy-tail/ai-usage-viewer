import type { UsageLimit } from "../types";
import { EMAIL_PATTERN } from "../lib/patterns";
import { limitFromUsed, slugifyId, type ParserMeta } from "./common";
import { ParserDriftError } from "./errors";

const EMAIL_RE = new RegExp(EMAIL_PATTERN, "i");
const CLAUDE_SECTION_RE =
  /^[\t ]*(?:Current session|Current week(?:\s*\(([^)\r\n]+)\))?|Usage credits)[\t ]*$/gim;
const USED_PERCENT_RE = /(\d+(?:\.\d+)?)%\s+used\b/gi;
const CREDITS_OFF_RE = /\bUsage credits are off\b/i;

export type ClaudeAuthStatus = {
  loggedIn: boolean;
  email?: string;
  orgId?: string;
  orgName?: string;
  subscriptionType?: string;
};

type ClaudeSection = {
  id: string;
  scope: string;
  window?: string;
  requiredReset: boolean;
  start: number;
};

type ParsedClaudeSection = ClaudeSection & {
  usedPercent: number;
  resetLabel?: string;
  sourceText: string;
};

type ClaudeSectionState =
  | { kind: "parsed"; value: ParsedClaudeSection }
  | { kind: "omitted" }
  | { kind: "incomplete" };

export function parseClaudeUsage(text: string, meta: ParserMeta): UsageLimit[] {
  const sections = findClaudeSections(text);
  const semanticLabelById = new Map<string, string>();
  for (const section of sections) {
    const semanticLabel = normalizeSemanticLabel(section.scope);
    const previousLabel = semanticLabelById.get(section.id);
    if (previousLabel !== undefined && previousLabel !== semanticLabel) {
      throw new ParserDriftError(
        `Claude usage sections produced a colliding row id "${section.id}".`,
        text
      );
    }
    semanticLabelById.set(section.id, semanticLabel);
  }
  const claimedPercentOffsets = new Set<number>();
  const latestById = new Map<string, ClaudeSectionState>();

  for (const [index, section] of sections.entries()) {
    const end = sections[index + 1]?.start ?? text.length;
    const block = text.slice(section.start, end);
    const percent = firstMatch(block, USED_PERCENT_RE);
    if (!percent) {
      latestById.set(
        section.id,
        section.id === "claude:usage-credits" && CREDITS_OFF_RE.test(block)
          ? { kind: "omitted" }
          : { kind: "incomplete" }
      );
      continue;
    }

    claimedPercentOffsets.add(section.start + percent.index);
    const usedPercent = Number(percent[1]);
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
      latestById.set(section.id, { kind: "incomplete" });
      continue;
    }
    const afterPercent = block.slice(percent.index + percent[0].length);
    const reset = afterPercent.match(/\bResets\s+([^\r\n]+)/i)?.[1]?.trim();

    // PTY output contains redraw history. Overwriting by id deliberately uses
    // the newest state, including an explicit disabled state or a still-loading
    // final frame, instead of silently retaining an older value.
    latestById.set(section.id, {
      kind: "parsed",
      value: {
        ...section,
        usedPercent,
        resetLabel: reset ? `Resets ${reset}` : undefined,
        sourceText: block.trim(),
      },
    });
  }

  const completeById = new Map<string, ParsedClaudeSection>();
  for (const [id, state] of latestById) {
    if (state.kind === "parsed") completeById.set(id, state.value);
  }

  const session = completeById.get("claude:session");
  const weekAll = completeById.get("claude:week-all");
  if (!session || !weekAll) {
    throw new ParserDriftError(
      "Claude usage output did not contain the required usage sections.",
      text
    );
  }

  const incomplete = [...latestById.values()].some(
    (state) => state.kind === "incomplete"
  );
  const unclaimedPercent = allMatches(text, USED_PERCENT_RE).find(
    (match) => !claimedPercentOffsets.has(match.index)
  );
  const missingReset = [session, weekAll].find(
    (section) => section.requiredReset && !section.resetLabel
  );
  if (incomplete || unclaimedPercent || missingReset) {
    throw new ParserDriftError(
      "Claude usage output contained an incomplete or unrecognized usage section.",
      text
    );
  }

  return [...completeById.values()].map((section) =>
    limitFromUsed({
      id: section.id,
      provider: "claude",
      providerLabel: "Claude Code",
      scope: section.scope,
      window: section.window,
      usedPercent: section.usedPercent,
      resetLabel: section.resetLabel,
      sourceText: section.sourceText,
      meta,
    })
  );
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

function findClaudeSections(text: string): ClaudeSection[] {
  return allMatches(text, CLAUDE_SECTION_RE).map((match) => {
    const heading = match[0].replace(/\s+/g, " ").trim();
    if (/^Current session$/i.test(heading)) {
      return {
        id: "claude:session",
        scope: "Current session",
        window: "session",
        // Current Claude builds no longer render a reset line for this row.
        // Weekly all-model usage still requires one below.
        requiredReset: false,
        start: match.index,
      };
    }

    if (/^Usage credits$/i.test(heading)) {
      return {
        id: "claude:usage-credits",
        scope: "Usage credits",
        requiredReset: false,
        start: match.index,
      };
    }

    const qualifier = match[1]?.trim();
    const normalizedQualifier = qualifier?.replace(/\s+only$/i, "").trim();
    const qualifierId = normalizedQualifier
      ? /^all models$/i.test(normalizedQualifier)
        ? "all"
        : slugifyId(normalizedQualifier)
      : "week";

    return {
      id: qualifierId === "week" ? "claude:week" : `claude:week-${qualifierId}`,
      scope: qualifier ? `Current week (${qualifier})` : "Current week",
      window: "weekly",
      requiredReset: /^all models$/i.test(normalizedQualifier ?? ""),
      start: match.index,
    };
  });
}

function firstMatch(text: string, pattern: RegExp): RegExpExecArray | undefined {
  pattern.lastIndex = 0;
  const match = pattern.exec(text) ?? undefined;
  pattern.lastIndex = 0;
  return match;
}

function allMatches(text: string, pattern: RegExp): RegExpExecArray[] {
  pattern.lastIndex = 0;
  const matches = [...text.matchAll(pattern)];
  pattern.lastIndex = 0;
  return matches;
}

function normalizeSemanticLabel(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}
