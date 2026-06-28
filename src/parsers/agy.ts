import type { UsageLimit } from "../types";
import { EMAIL_PATTERN } from "../lib/patterns";
import { limitFromRemaining, slugifyId, type ParserMeta } from "./common";
import { ParserDriftError } from "./errors";

const EMAIL_RE = new RegExp(EMAIL_PATTERN, "i");

export type AgyAccountInfo = {
  email?: string;
  planLabel?: string;
};

// The Antigravity `/usage` (quota) screen groups models and reports a Weekly
// and a Five Hour limit per group, e.g.:
//
//   GEMINI MODELS
//     Models within this group: Gemini Flash, Gemini Pro
//
//     Weekly Limit
//       [██████████████████████████████████████████████████] 99.19%
//       99% remaining · Refreshes in 47h 3m
//
//     Five Hour Limit
//       [██████████████████████████████████████████████████] 99.71%
//       100% remaining · Refreshes in 4h 55m
//
// The bar percentage is the amount REMAINING (99.19% bar ↔ "99% remaining").
//
// Group headers are ALL-CAPS and always end in "MODELS", e.g. "GEMINI MODELS",
// "CLAUDE AND GPT MODELS". We match the header as the TRAILING all-caps phrase
// so it is still recognized when a ConPTY redraw glues a status-bar fragment in
// front of it, e.g. "esc to cancel  GEMINI MODELS". Missing this prefix case
// causes that frame's limits to be mis-attributed to a separate group.
const GROUP_MEMBERS_RE = /^Models within this group:/i;
const GROUP_HEADER_RE = /([A-Z][A-Z0-9 &/+.-]*\bMODELS?)\s*$/;
const WEEKLY_RE = /^Weekly\s+Limit\b/i;
const FIVE_HOUR_RE = /^(?:Five|5)[\s-]?Hour\s+Limit\b/i;
const BAR_PERCENT_RE = /(\d+(?:\.\d+)?)%\s*$/;
const REFRESH_RE = /Refreshes?\s+in\s+(.+?)\s*$/i;
const QUOTA_STATUS_RE = /\bQuota\s+\w+/i;
const PAGER_RE = /Scroll|pgup|pgdown|ctrl\+(?:end|home)|esc Close|Navigate|Select|Complete/i;

type AgyWindow = "weekly" | "5h";

export function parseAgyQuota(
  text: string,
  meta: ParserMeta,
  pinnedGroups: string[] = []
): UsageLimit[] {
  const lines = text.split("\n").map((line) => line.trim());
  const pinned = new Set(pinnedGroups.map((group) => group.toLowerCase()));
  const seen = new Set<string>();
  const rows: UsageLimit[] = [];
  let group: string | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || GROUP_MEMBERS_RE.test(line)) continue;

    const window: AgyWindow | undefined = WEEKLY_RE.test(line)
      ? "weekly"
      : FIVE_HOUR_RE.test(line)
        ? "5h"
        : undefined;

    if (window) {
      const bar = findBarLine(lines, i + 1);
      if (!bar) continue; // incomplete section (redraw fragment) — skip
      const statusLine = statusLineAfter(lines, bar.index);
      i = statusLine ? bar.index + 1 : bar.index;

      const remainingPercent = Number(bar.percent);
      const groupName = group ?? "Antigravity";
      const id = `agy:${slugifyId(groupName)}:${window}`;
      if (seen.has(id)) continue; // ignore duplicate redraw frames
      seen.add(id);
      if (pinned.size > 0 && !pinned.has(groupName.toLowerCase())) continue;

      const { statusLabel, resetLabel } = parseStatusLine(statusLine, remainingPercent);
      rows.push(
        limitFromRemaining({
          id,
          provider: "agy",
          providerLabel: "Antigravity",
          scope: groupName,
          window,
          remainingPercent,
          resetLabel,
          statusLabel,
          sourceText: [groupName, line, bar.text, statusLine]
            .filter(Boolean)
            .join("\n"),
          meta,
        })
      );
      continue;
    }

    const header = extractGroupName(line);
    if (header) group = header;
  }

  if (rows.length === 0) {
    throw new ParserDriftError(
      "Agy output contained no recognized quota groups.",
      text
    );
  }

  return rows;
}

function findBarLine(
  lines: string[],
  start: number
): { index: number; text: string; percent: string } | undefined {
  for (let j = start; j < Math.min(lines.length, start + 3); j += 1) {
    const line = lines[j];
    if (!line) continue;
    const match = line.match(BAR_PERCENT_RE);
    if (match) return { index: j, text: line, percent: match[1] };
    // Stop if a new section/group starts before any bar appears.
    if (WEEKLY_RE.test(line) || FIVE_HOUR_RE.test(line) || GROUP_HEADER_RE.test(line)) {
      return undefined;
    }
  }
  return undefined;
}

function statusLineAfter(lines: string[], barIndex: number): string | undefined {
  const candidate = lines[barIndex + 1];
  if (!candidate || PAGER_RE.test(candidate)) return undefined;
  if (
    WEEKLY_RE.test(candidate) ||
    FIVE_HOUR_RE.test(candidate) ||
    BAR_PERCENT_RE.test(candidate) ||
    GROUP_HEADER_RE.test(candidate)
  ) {
    return undefined;
  }
  return candidate;
}

function parseStatusLine(
  line: string | undefined,
  remainingPercent: number
): { statusLabel?: string; resetLabel?: string } {
  const reset = line?.match(REFRESH_RE);
  const resetLabel = reset ? `Refreshes in ${reset[1].trim()}` : undefined;
  const quota = line?.match(QUOTA_STATUS_RE)?.[0];
  const statusLabel =
    quota ??
    (resetLabel ? undefined : remainingPercent >= 100 ? "Quota available" : undefined);
  return { statusLabel, resetLabel };
}

function extractGroupName(line: string): string | undefined {
  const match = line.match(GROUP_HEADER_RE);
  return match ? normalizeGroupName(match[1]) : undefined;
}

const ACRONYMS = new Set(["GPT", "OSS", "AI", "API", "CLI", "GPU"]);
const SMALL_WORDS = new Set(["and", "or", "of", "the", "for"]);

function normalizeGroupName(raw: string): string {
  const cleaned = raw.trim();
  if (!cleaned) return "Antigravity";
  return cleaned
    .split(/\s+/)
    .map((word, index) => {
      const upper = word.toUpperCase();
      if (ACRONYMS.has(upper)) return upper;
      const lower = word.toLowerCase();
      if (index > 0 && SMALL_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

export function parseAgyAccountInfo(text: string): AgyAccountInfo {
  const email = text.match(EMAIL_RE)?.[0];
  const explicitPlan = text.match(/\bPlan\s*[:=]\s*([^\n]+)/i)?.[1]?.trim();
  const knownPlan = text.match(/\bGoogle AI Pro\b/i)?.[0];
  return {
    email,
    planLabel: explicitPlan ?? knownPlan,
  };
}
