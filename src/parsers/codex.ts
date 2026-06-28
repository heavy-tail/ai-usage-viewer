import type { UsageLimit } from "../types";
import { limitFromRemaining, slugifyId, type ParserMeta } from "./common";
import { ParserDriftError } from "./errors";

export type CodexLoginStatus = {
  loggedIn: boolean;
  planLabel?: string;
};

export type CodexStatusInfo = {
  accountLabel?: string;
  planLabel?: string;
  limits: CodexStatusLimit[];
};

type CodexStatusLimit = {
  group: "default" | string;
  window: "5h" | "weekly";
  remainingPercent: number;
  resetLabel?: string;
  sourceText: string;
};

const FOOTER_RE =
  /(.+?)\s*(?:·|\||-)\s*Context\s+(\d+(?:\.\d+)?)%\s+(?:left|l)\s*(?:·|\||-)\s*5h\s+(\d+(?:\.\d+)?)%\s+(?:left|l)\s*(?:·|\||-)\s*weekly\s+(\d+(?:\.\d+)?)%\s+(?:left|l)/i;

export function parseCodexFooter(text: string, meta: ParserMeta): UsageLimit[] {
  const footer = latestFooterLine(text);
  const match = footer?.match(FOOTER_RE);
  const status = parseCodexStatus(text);

  if (!footer || !match) {
    throw new ParserDriftError(
      "Codex output did not contain a recognized usage footer.",
      text
    );
  }

  const effectiveMeta = {
    ...meta,
    planLabel: status.planLabel ?? meta.planLabel,
    accountLabel: status.accountLabel ?? meta.accountLabel,
  };
  const modelLabel = match[1].trim();
  const defaultFiveHour = findStatusLimit(status, "default", "5h");
  const defaultWeekly = findStatusLimit(status, "default", "weekly");
  const limits = [
    limitFromRemaining({
      id: "codex:context",
      provider: "codex",
      providerLabel: "Codex",
      scope: "Context window",
      window: "context",
      remainingPercent: Number(match[2]),
      statusLabel: modelLabel,
      informational: true,
      sourceText: footer,
      meta: effectiveMeta,
    }),
    limitFromRemaining({
      id: "codex:5h",
      provider: "codex",
      providerLabel: "Codex",
      scope: "5h limit",
      window: "5h",
      remainingPercent: Number(match[3]),
      resetLabel: defaultFiveHour?.resetLabel,
      statusLabel: modelLabel,
      sourceText: combineSourceText(footer, defaultFiveHour?.sourceText),
      meta: effectiveMeta,
    }),
    limitFromRemaining({
      id: "codex:weekly",
      provider: "codex",
      providerLabel: "Codex",
      scope: "Weekly limit",
      window: "weekly",
      remainingPercent: Number(match[4]),
      resetLabel: defaultWeekly?.resetLabel,
      statusLabel: modelLabel,
      sourceText: combineSourceText(footer, defaultWeekly?.sourceText),
      meta: effectiveMeta,
    }),
  ];

  for (const statusLimit of status.limits.filter((item) => item.group !== "default")) {
    limits.push(
      limitFromRemaining({
        id: `codex:${slugifyId(statusLimit.group)}:${statusLimit.window}`,
        provider: "codex",
        providerLabel: "Codex",
        scope: `${statusLimit.group} ${statusLimit.window} limit`,
        window: statusLimit.window,
        remainingPercent: statusLimit.remainingPercent,
        resetLabel: statusLimit.resetLabel,
        statusLabel: statusLimit.group,
        sourceText: statusLimit.sourceText,
        meta: effectiveMeta,
      })
    );
  }

  return limits;
}

export function parseCodexLoginStatus(text: string): CodexLoginStatus {
  if (/not\s+logged\s+in|logged\s+out|no\s+login/i.test(text)) {
    return { loggedIn: false };
  }
  const planLabel = text.match(/Logged in using\s+(.+)/i)?.[1]?.trim();
  return {
    loggedIn: /logged\s+in/i.test(text),
    planLabel,
  };
}

export function parseCodexStatus(text: string): CodexStatusInfo {
  const limits: CodexStatusLimit[] = [];
  let accountLabel: string | undefined;
  let planLabel: string | undefined;
  let group = "default";

  for (const rawLine of text.split("\n")) {
    const line = normalizeStatusLine(rawLine);
    if (!line) continue;

    const account = line.match(/^Account:\s+(.+?)(?:\s+\(([^)]+)\))?$/i);
    if (account) {
      accountLabel = account[1].trim();
      planLabel = account[2]?.trim() ?? planLabel;
      group = "default";
      continue;
    }

    const limit = line.match(
      /^(5h|Weekly)\s+limit:\s+.*?(\d+(?:\.\d+)?)%\s+left(?:\s+\((resets[^)]*)\))?/i
    );
    if (limit) {
      limits.push({
        group,
        window: limit[1].toLowerCase() === "weekly" ? "weekly" : "5h",
        remainingPercent: Number(limit[2]),
        resetLabel: normalizeResetLabel(limit[3]),
        sourceText: line,
      });
      continue;
    }

    const groupHeader = line.match(/^(.+?)\s+limit:\s*$/i);
    if (groupHeader && !/^(5h|weekly)$/i.test(groupHeader[1])) {
      group = groupHeader[1].trim();
    }
  }

  return { accountLabel, planLabel, limits: dedupeStatusLimits(limits) };
}

function dedupeStatusLimits(limits: CodexStatusLimit[]): CodexStatusLimit[] {
  const byKey = new Map<string, CodexStatusLimit>();
  for (const limit of limits) {
    byKey.set(`${limit.group}:${limit.window}`, limit);
  }
  return Array.from(byKey.values());
}

function latestFooterLine(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        /Context\s+\d+(?:\.\d+)?%\s+left/i.test(line) &&
        /5h\s+\d+(?:\.\d+)?%\s+left/i.test(line) &&
        /weekly\s+\d+(?:\.\d+)?%\s+(?:left|l)/i.test(line)
    );
  return lines[lines.length - 1];
}

function findStatusLimit(
  status: CodexStatusInfo,
  group: string,
  window: "5h" | "weekly"
): CodexStatusLimit | undefined {
  return status.limits.find((item) => item.group === group && item.window === window);
}

function normalizeStatusLine(line: string): string {
  return line
    .replace(/[│╭╮╰╯]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeResetLabel(value?: string): string | undefined {
  if (!value) return undefined;
  return value
    .trim()
    .replace(/^resets/i, "Resets")
    .replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:AM|PM)\b)/gi, (_match, hour, minute) => {
      const hour24 = Number(hour);
      const meridiem = hour24 >= 12 ? "PM" : "AM";
      const hour12 = hour24 % 12 || 12;
      return `${hour12}:${minute} ${meridiem}`;
    });
}

function combineSourceText(primary: string, secondary?: string): string {
  if (!secondary || secondary === primary) return primary;
  return `${primary}\n${secondary}`;
}
