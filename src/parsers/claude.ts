import type { UsageLimit } from "../types";
import { EMAIL_PATTERN } from "../lib/patterns";
import { resolveResetInstant } from "../lib/resetTime";
import { limitFromUsed, slugifyId, type ParserMeta } from "./common";
import { ParserDriftError } from "./errors";

const EMAIL_RE = new RegExp(EMAIL_PATTERN, "i");
const CLAUDE_SECTION_RE =
  /^[\t ]*(?:Current session|Current week(?:\s*\(([^)\r\n]+)\))?|Usage credits)[\t ]*$/gim;
const CLAUDE_FRAME_START_RE = /^[\t ]*Current session[\t ]*$/gim;
const CLAUDE_CREDITS_HEADING_RE = /^[\t ]*Usage credits[\t ]*$/gim;
const CLAUDE_COMPLETE_CREDITS_RE =
  /^[\t ]*Usage credits[\t ]*\r?\n[^\r\n]*(?:Usage credits are off|\d+(?:\.\d+)?%\s+used)[^\r\n]*$/gim;
const USED_PERCENT_RE = /(\d+(?:\.\d+)?)%\s+used\b/gi;
const CREDITS_OFF_RE = /\bUsage credits are off\b/i;
const MAX_RESET_LABEL_LENGTH = 128;
const RESET_PAST_TOLERANCE_MS = 5 * 60_000;

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
  resetAt?: string;
  sourceText: string;
};

type ClaudeSectionState =
  | { kind: "parsed"; value: ParsedClaudeSection }
  | { kind: "omitted" }
  | { kind: "incomplete" };

export function parseClaudeUsage(text: string, meta: ParserMeta): UsageLimit[] {
  // ConPTY retains redraw history, including briefly glued headings from an
  // older in-progress frame. Validate only the newest complete screen frame;
  // unknown percentages in that newest frame still fail closed below.
  const frameText = latestClaudeFrame(normalizeClaudeRedraw(text));
  const sections = findClaudeSections(frameText);
  const semanticLabelById = new Map<string, string>();
  for (const section of sections) {
    const semanticLabel = normalizeSemanticLabel(section.scope);
    const previousLabel = semanticLabelById.get(section.id);
    if (previousLabel !== undefined && previousLabel !== semanticLabel) {
      throw new ParserDriftError(
        `Claude usage sections produced a colliding row id "${section.id}".`,
        frameText
      );
    }
    semanticLabelById.set(section.id, semanticLabel);
  }
  const claimedPercentOffsets = new Set<number>();
  const latestById = new Map<string, ClaudeSectionState>();

  for (const [index, section] of sections.entries()) {
    const end = sections[index + 1]?.start ?? frameText.length;
    const block = frameText.slice(section.start, end);
    if (
      section.id === "claude:usage-credits" &&
      CREDITS_OFF_RE.test(block)
    ) {
      latestById.set(section.id, { kind: "omitted" });
      continue;
    }
    const percent = firstMatch(block, USED_PERCENT_RE);
    if (!percent) {
      latestById.set(
        section.id,
        { kind: "incomplete" }
      );
      continue;
    }

    claimedPercentOffsets.add(section.start + percent.index);
    const usedPercent = Number(percent[1]);
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
      latestById.set(section.id, { kind: "incomplete" });
      continue;
    }
    const percentEnd = percent.index + percent[0].length;
    const afterPercent = block.slice(percentEnd);
    const resetMatch = /\bResets\s+([^\r\n]+)/i.exec(afterPercent);
    const rawReset = resetMatch?.[1]?.trim();
    const reset = rawReset
      ? validatedResetLabel(rawReset, section, meta)
      : undefined;

    // PTY output contains redraw history. Overwriting by id deliberately uses
    // the newest state, including an explicit disabled state or a still-loading
    // final frame, instead of silently retaining an older value.
    latestById.set(section.id, {
      kind: "parsed",
      value: {
        ...section,
        usedPercent,
        resetLabel: reset?.label,
        resetAt: reset?.at,
        // Persist the exact semantic fragments the parser accepted, not TUI
        // progress bars or duplicated redraw cells around them. This keeps the
        // structural fingerprint stable while the strict heading/percentage
        // checks above still reject unknown content in the newest frame.
        sourceText: [
          section.scope,
          `${usedPercent}% used`,
        ]
          .filter(Boolean)
          .join("\n"),
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
      frameText
    );
  }

  const incomplete = [...latestById.values()].some(
    (state) => state.kind === "incomplete"
  );
  const unclaimedPercent = allMatches(frameText, USED_PERCENT_RE).find(
    (match) => !claimedPercentOffsets.has(match.index)
  );
  const missingReset = [session, weekAll].find(
    (section) => section.requiredReset && !section.resetLabel
  );
  if (incomplete || unclaimedPercent || missingReset) {
    throw new ParserDriftError(
      "Claude usage output contained an incomplete or unrecognized usage section.",
      frameText
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
      resetAt: section.resetAt,
      sourceText: section.sourceText,
      meta,
    })
  );
}

function normalizeClaudeRedraw(text: string): string {
  // Claude updates the first row in-place while its local-session scan runs.
  // ConPTY can preserve the new percentage/reset but omit the overwritten
  // "Current session" heading, leaving the stable cancellation label glued to
  // the value. Reconstruct only this fully observed three-line sequence; an
  // arbitrary orphan percentage still reaches the fail-closed check below.
  return text.replace(
    /^[^\r\n]*Esc to cancel([\d.%\t ]+used)[\t ]*\r?\n[\t ]*(Resets [^\r\n]+)\r?\n(?=[\t ]*Current week\s*\(all models\))/gim,
    (_match, usage: string, reset: string) =>
      `Current session\n${usage.trim()}\n${reset.trim()}\n`
  );
}

function latestClaudeFrame(text: string): string {
  const starts = allMatches(text, CLAUDE_FRAME_START_RE);
  if (starts.length === 0) return text;
  const frames = starts.map((start, index) =>
    text.slice(start.index, starts[index + 1]?.index ?? text.length)
  );
  const latest = frames[frames.length - 1];

  // A real newest frame that reached the credits section is authoritative,
  // including a loading/incomplete credits state that must fail closed.
  if (allMatches(latest, CLAUDE_CREDITS_HEADING_RE).length > 0) {
    return completeClaudeFramePrefix(latest) ?? latest;
  }

  // Sending Esc/exit makes Claude paint a final partial screen without credits.
  // Prefer the newest preceding frame that reached the semantic credits end
  // marker; older builds that never render credits still use the latest frame.
  for (let index = frames.length - 2; index >= 0; index -= 1) {
    const complete = completeClaudeFramePrefix(frames[index]);
    if (complete !== undefined) return complete;
  }
  return latest;
}

function completeClaudeFramePrefix(frame: string): string | undefined {
  const complete = allMatches(frame, CLAUDE_COMPLETE_CREDITS_RE)[0];
  if (!complete || complete.index === undefined) return undefined;
  const end = complete.index + complete[0].length;
  const trailing = frame.slice(end);
  const hasUnknownTrailingPercent = allMatches(trailing, USED_PERCENT_RE).some(
    (match) => {
      const lineStart = trailing.lastIndexOf("\n", match.index) + 1;
      const nextBreak = trailing.indexOf("\n", match.index);
      const lineEnd = nextBreak === -1 ? trailing.length : nextBreak;
      return !/Esc to cancel/i.test(trailing.slice(lineStart, lineEnd));
    }
  );
  // Do not let the semantic end marker hide a newly added percentage section.
  // Only known cancellation redraw debris may be discarded.
  return hasUnknownTrailingPercent ? frame : frame.slice(0, end);
}

function validatedResetLabel(
  raw: string,
  section: ClaudeSection,
  meta: ParserMeta
): { label: string; at: string } | undefined {
  if (!raw || raw.length > MAX_RESET_LABEL_LENGTH) return undefined;
  const resetLabel = `Resets ${raw}`;
  const reset = resolveResetInstant(
    { checkedAt: meta.checkedAt, resetLabel },
    meta.sourceTimeZone
  );
  const checkedAt = Date.parse(meta.checkedAt);
  if (!reset || !Number.isFinite(checkedAt)) return undefined;
  const delta = reset.getTime() - checkedAt;
  const maxFutureMs =
    section.window === "session"
      ? 6 * 60 * 60_000
      : section.window === "weekly"
        ? 8 * 24 * 60 * 60_000
        : 370 * 24 * 60 * 60_000;
  return delta >= -RESET_PAST_TOLERANCE_MS && delta <= maxFutureMs
    ? { label: resetLabel, at: reset.toISOString() }
    : undefined;
}

export function parseClaudeAuthStatus(text: string): ClaudeAuthStatus {
  const structured = parseClaudeAuthJson(text);
  if (structured) return structured;

  const loggedInFalse =
    /["']?loggedIn["']?\s*[:=]\s*["']?false\b|not\s+logged\s+in/i.test(
      text
    );
  const loggedInTrue =
    /["']?loggedIn["']?\s*[:=]\s*["']?true\b|logged\s+in/i.test(text);
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

function parseClaudeAuthJson(text: string): ClaudeAuthStatus | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text.trim()) as unknown;
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { loggedIn: false };
  }

  const record = value as Record<string, unknown>;
  return {
    loggedIn: record.loggedIn === true,
    email: stringField(record.email),
    orgId: stringField(record.orgId),
    orgName: stringField(record.orgName),
    subscriptionType: stringField(record.subscriptionType),
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
