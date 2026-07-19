import type { UsageLimit } from "../types";
import {
  limitFromRemaining,
  limitFromUsed,
  slugifyId,
  type ParserMeta,
} from "./common";
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

type StructuredWindow = {
  usedPercent: number;
  windowDurationMins?: number;
  resetsAt?: number;
};

type StructuredIndividualLimit = {
  limit: string;
  used: string;
  remainingPercent: number;
  resetsAt: number;
};

type StructuredBucket = {
  limitId: string;
  limitName?: string;
  primary?: StructuredWindow;
  secondary?: StructuredWindow;
  individualLimit?: StructuredIndividualLimit;
  planType?: string;
  rateLimitReachedType?: CodexRateLimitReachedType;
};

type CodexRateLimitReachedType =
  | "rate_limit_reached"
  | "workspace_owner_credits_depleted"
  | "workspace_member_credits_depleted"
  | "workspace_owner_usage_limit_reached"
  | "workspace_member_usage_limit_reached";

type WindowDescriptor = {
  id: string;
  label: string;
  window: string;
};

const STRUCTURED_BUCKET_FIELDS = new Set([
  "limitId",
  "limitName",
  "primary",
  "secondary",
  "credits",
  "individualLimit",
  "planType",
  "rateLimitReachedType",
]);
const RATE_LIMIT_REACHED_TYPES = new Set<CodexRateLimitReachedType>([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);
const STRUCTURED_ROOT_FIELDS = new Set([
  "rateLimits",
  "rateLimitsByLimitId",
  "rateLimitResetCredits",
  "planType",
  "spendControlReached",
]);
const STRUCTURED_WINDOW_FIELDS = new Set([
  "usedPercent",
  "windowDurationMins",
  "resetsAt",
]);
const STRUCTURED_INDIVIDUAL_FIELDS = new Set([
  "limit",
  "used",
  "remainingPercent",
  "resetsAt",
]);
const STRUCTURED_CREDITS_FIELDS = new Set([
  "hasCredits",
  "unlimited",
  "balance",
]);
const MIN_PLAUSIBLE_EPOCH_SECONDS = 946_684_800; // 2000-01-01
const MAX_PLAUSIBLE_EPOCH_SECONDS = 4_102_444_800; // 2100-01-01

/** Parse the stable app-server account/rateLimits/read result. */
export function parseCodexAppServerRateLimits(
  payload: unknown,
  meta: ParserMeta
): UsageLimit[] {
  const source = stringifyUnknown(payload);
  const drift = (message: string): never => {
    throw new ParserDriftError(message, source);
  };
  const root = objectValue(payload);
  if (!root) {
    throw new ParserDriftError(
      "Codex app-server rate-limit result was not an object.",
      source
    );
  }
  rejectUnknownUsageFields(root, STRUCTURED_ROOT_FIELDS, "result", drift);
  if (containsUsagePercent(root.rateLimitResetCredits)) {
    drift("Codex app-server reset-credit metadata contained usage percentages.");
  }
  const spendControlReached = optionalBoolean(
    root.spendControlReached,
    "result spendControlReached",
    drift
  );

  const rawMultiBucket = root.rateLimitsByLimitId;
  const multiBucket = objectValue(rawMultiBucket);
  if (rawMultiBucket != null && !multiBucket) {
    drift("Codex app-server rateLimitsByLimitId was malformed.");
  }

  const multiBucketEntries = Object.entries(multiBucket ?? {});
  const rawSingleBucket = root.rateLimits;
  // The documented multi-bucket field is authoritative. Only parse the
  // backward-compatible single view when the multi-bucket view is absent or
  // empty, so stale legacy metadata cannot invalidate a complete new response.
  const singleBucket =
    multiBucketEntries.length === 0 && rawSingleBucket != null
      ? parseStructuredBucket(rawSingleBucket, "codex", drift)
      : undefined;
  const buckets = multiBucketEntries.length > 0
    ? multiBucketEntries.map(([mapKey, bucket]) =>
        parseStructuredBucket(bucket, mapKey, drift)
      )
    : singleBucket
      ? [singleBucket]
      : [];
  const limits: UsageLimit[] = [];
  const ids = new Set<string>();

  for (const bucket of buckets) {
    const limitId = bucket.limitId;
    const limitName = bucket.limitName;
    const defaultBucket = limitId.toLowerCase() === "codex";
    const groupLabel = bucketLabel(limitId, limitName);
    const bucketMeta = {
      ...meta,
      planLabel:
        formatPlanLabel(bucket.planType) ??
        formatPlanLabel(stringValue(root?.planType)) ??
        meta.planLabel,
    };

    for (const role of ["primary", "secondary"] as const) {
      const window = bucket[role];
      if (!window) continue;

      const descriptor = describeWindow(window.windowDurationMins, role);
      const groupSlug = slugifyId(limitId) || "bucket";
      const baseId = defaultBucket
        ? `codex:${descriptor.id}`
        : `codex:${groupSlug}:${descriptor.id}`;
      const id = uniqueId(baseId, role, ids);
      const sourceText = JSON.stringify(
        {
          limitId,
          limitName: limitName ?? null,
          role,
          ...window,
          rateLimitReachedType: bucket.rateLimitReachedType ?? null,
          spendControlReached: spendControlReached ?? null,
        },
        null,
        2
      );

      limits.push(
        applyHardStop(
          limitFromUsed({
            id,
            provider: "codex",
            providerLabel: "Codex",
            scope: defaultBucket
              ? `${descriptor.label} limit`
              : `${groupLabel} ${descriptor.label} limit`,
          window: descriptor.window,
          usedPercent: window.usedPercent,
          resetLabel: resetLabel(window.resetsAt),
          resetAt: resetAt(window.resetsAt),
            statusLabel: defaultBucket ? undefined : groupLabel,
            sourceText,
            meta: bucketMeta,
          }),
          bucket,
          spendControlReached
        )
      );
    }

    if (bucket.individualLimit) {
      const individual = bucket.individualLimit;
      const groupSlug = slugifyId(limitId) || "bucket";
      const baseId = defaultBucket
        ? "codex:individual"
        : `codex:${groupSlug}:individual`;
      const sourceText = JSON.stringify(
        {
          limitId,
          limitName: limitName ?? null,
          individualLimit: individual,
          rateLimitReachedType: bucket.rateLimitReachedType ?? null,
          spendControlReached: spendControlReached ?? null,
        },
        null,
        2
      );
      limits.push(
        applyHardStop(
          limitFromRemaining({
            id: uniqueId(baseId, "individual", ids),
            provider: "codex",
            providerLabel: "Codex",
            scope: defaultBucket
              ? "Individual usage limit"
              : `${groupLabel} individual usage limit`,
            window: "spend-control",
          remainingPercent: individual.remainingPercent,
          resetLabel: resetLabel(individual.resetsAt),
          resetAt: resetAt(individual.resetsAt),
            statusLabel: `${individual.used} of ${individual.limit}`,
            sourceText,
            meta: bucketMeta,
          }),
          bucket,
          spendControlReached
        )
      );
    }
  }

  if (limits.length === 0) {
    throw new ParserDriftError(
      "Codex app-server returned no recognized rate-limit windows.",
      source
    );
  }

  return limits;
}

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
  const contextRemaining = tuiPercent(match[2], "context footer", text);
  const fiveHourRemaining = tuiPercent(match[3], "5h footer", text);
  const weeklyRemaining = tuiPercent(match[4], "weekly footer", text);

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
      remainingPercent: contextRemaining,
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
      remainingPercent: fiveHourRemaining,
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
      remainingPercent: weeklyRemaining,
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
      const remainingPercent = tuiPercent(
        limit[2],
        `${group} ${limit[1]} status`,
        text
      );
      limits.push({
        group,
        window: limit[1].toLowerCase() === "weekly" ? "weekly" : "5h",
        remainingPercent,
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

function parseStructuredBucket(
  value: unknown,
  mapKey: string,
  drift: (message: string) => never
): StructuredBucket {
  const record = objectValue(value);
  if (!record) drift(`Codex app-server bucket "${mapKey}" was malformed.`);
  rejectUnknownUsageFields(
    record,
    STRUCTURED_BUCKET_FIELDS,
    `bucket "${mapKey}"`,
    drift
  );

  const limitId =
    record.limitId == null ? stringValue(mapKey) : stringValue(record.limitId);
  if (!limitId) {
    drift(`Codex app-server bucket "${mapKey}" had an invalid limitId.`);
  }
  const limitName = optionalString(
    record.limitName,
    `bucket "${mapKey}" limitName`,
    drift
  );
  const planType = optionalString(
    record.planType,
    `bucket "${mapKey}" planType`,
    drift
  );
  const rateLimitReachedType = optionalRateLimitReachedType(
    record.rateLimitReachedType,
    `bucket "${mapKey}" rateLimitReachedType`,
    drift
  );
  validateCredits(record.credits, mapKey, drift);

  return {
    limitId,
    limitName,
    primary: parseStructuredWindow(record.primary, `${mapKey}.primary`, drift),
    secondary: parseStructuredWindow(
      record.secondary,
      `${mapKey}.secondary`,
      drift
    ),
    individualLimit: parseStructuredIndividualLimit(
      record.individualLimit,
      `${mapKey}.individualLimit`,
      drift
    ),
    planType,
    rateLimitReachedType,
  };
}

function parseStructuredWindow(
  value: unknown,
  path: string,
  drift: (message: string) => never
): StructuredWindow | undefined {
  if (value == null) return undefined;
  const record = objectValue(value);
  if (!record) drift(`Codex app-server ${path} window was malformed.`);
  rejectUnknownUsageFields(record, STRUCTURED_WINDOW_FIELDS, path, drift);
  return {
    usedPercent: percentageValue(record.usedPercent, `${path}.usedPercent`, drift),
    windowDurationMins: optionalPositiveInteger(
      record.windowDurationMins,
      `${path}.windowDurationMins`,
      drift
    ),
    resetsAt: optionalEpochSeconds(record.resetsAt, `${path}.resetsAt`, drift),
  };
}

function parseStructuredIndividualLimit(
  value: unknown,
  path: string,
  drift: (message: string) => never
): StructuredIndividualLimit | undefined {
  if (value == null) return undefined;
  const record = objectValue(value);
  if (!record) drift(`Codex app-server ${path} was malformed.`);
  rejectUnknownUsageFields(record, STRUCTURED_INDIVIDUAL_FIELDS, path, drift);
  const limit = stringValue(record.limit);
  const used = stringValue(record.used);
  if (!limit || !used) {
    drift(`Codex app-server ${path} had invalid limit/used values.`);
  }
  const resetsAt = optionalEpochSeconds(record.resetsAt, `${path}.resetsAt`, drift);
  if (resetsAt == null) {
    drift(`Codex app-server ${path}.resetsAt was missing.`);
  }
  return {
    limit,
    used,
    remainingPercent: percentageValue(
      record.remainingPercent,
      `${path}.remainingPercent`,
      drift
    ),
    resetsAt,
  };
}

function validateCredits(
  value: unknown,
  mapKey: string,
  drift: (message: string) => never
): void {
  if (value == null) return;
  const record = objectValue(value);
  if (record) {
    rejectUnknownUsageFields(
      record,
      STRUCTURED_CREDITS_FIELDS,
      `bucket "${mapKey}" credits`,
      drift
    );
  }
  if (
    !record ||
    typeof record.hasCredits !== "boolean" ||
    typeof record.unlimited !== "boolean" ||
    (record.balance != null && typeof record.balance !== "string")
  ) {
    drift(`Codex app-server bucket "${mapKey}" credits were malformed.`);
  }
}

function percentageValue(
  value: unknown,
  path: string,
  drift: (message: string) => never
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100
  ) {
    drift(`Codex app-server ${path} was outside 0..100.`);
  }
  return value;
}

function optionalPositiveInteger(
  value: unknown,
  path: string,
  drift: (message: string) => never
): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    drift(`Codex app-server ${path} was not a positive integer.`);
  }
  return value;
}

function optionalEpochSeconds(
  value: unknown,
  path: string,
  drift: (message: string) => never
): number | undefined {
  const parsed = optionalPositiveInteger(value, path, drift);
  if (parsed == null) return undefined;
  if (
    parsed < MIN_PLAUSIBLE_EPOCH_SECONDS ||
    parsed > MAX_PLAUSIBLE_EPOCH_SECONDS
  ) {
    drift(`Codex app-server ${path} was not a plausible epoch-seconds value.`);
  }
  return parsed;
}

function optionalString(
  value: unknown,
  path: string,
  drift: (message: string) => never
): string | undefined {
  if (value == null) return undefined;
  const parsed = stringValue(value);
  if (!parsed) drift(`Codex app-server ${path} was not a non-empty string.`);
  return parsed;
}

function optionalRateLimitReachedType(
  value: unknown,
  path: string,
  drift: (message: string) => never
): CodexRateLimitReachedType | undefined {
  if (value == null) return undefined;
  const parsed = stringValue(value);
  if (!parsed || !RATE_LIMIT_REACHED_TYPES.has(parsed as CodexRateLimitReachedType)) {
    drift(`Codex app-server ${path} was not a recognized enum value.`);
  }
  return parsed as CodexRateLimitReachedType;
}

function optionalBoolean(
  value: unknown,
  path: string,
  drift: (message: string) => never
): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== "boolean") {
    drift(`Codex app-server ${path} was not a boolean.`);
  }
  return value;
}

function describeWindow(
  durationMins: number | undefined,
  fallback: "primary" | "secondary"
): WindowDescriptor {
  if (durationMins === 10_080) {
    return { id: "weekly", label: "Weekly", window: "weekly" };
  }
  if (durationMins != null && durationMins > 0) {
    if (durationMins % 1_440 === 0) {
      const days = durationMins / 1_440;
      return { id: `${days}d`, label: `${days}-day`, window: `${days}d` };
    }
    if (durationMins % 60 === 0) {
      const hours = durationMins / 60;
      return { id: `${hours}h`, label: `${hours}h`, window: `${hours}h` };
    }
    return {
      id: `${durationMins}m`,
      label: `${durationMins}m`,
      window: `${durationMins}m`,
    };
  }
  const label = fallback === "primary" ? "Primary" : "Secondary";
  return { id: fallback, label, window: fallback };
}

function bucketLabel(limitId: string, limitName?: string): string {
  if (limitName && limitName.toLowerCase() !== limitId.toLowerCase()) {
    return limitName;
  }
  return limitId
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatPlanLabel(value?: string): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function resetLabel(value?: number): string | undefined {
  const iso = resetAt(value);
  return iso ? `Resets ${iso}` : undefined;
}

function resetAt(value?: number): string | undefined {
  if (value == null || value <= 0) return undefined;
  const date = new Date(value * 1_000);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function applyHardStop(
  limit: UsageLimit,
  bucket: StructuredBucket,
  spendControlReached: boolean | undefined
): UsageLimit {
  const blockingReason = hardStopReason(
    bucket.rateLimitReachedType,
    spendControlReached
  );
  return blockingReason
    ? { ...limit, status: "exhausted", blockingReason }
    : limit;
}

function hardStopReason(
  rateLimitReachedType: CodexRateLimitReachedType | undefined,
  spendControlReached: boolean | undefined
): string | undefined {
  switch (rateLimitReachedType) {
    case "rate_limit_reached":
      return "Rate limit reached";
    case "workspace_owner_credits_depleted":
    case "workspace_member_credits_depleted":
      return "Workspace credits depleted";
    case "workspace_owner_usage_limit_reached":
    case "workspace_member_usage_limit_reached":
      return "Workspace usage limit reached";
    default:
      return spendControlReached
        ? "Workspace spending limit reached"
        : undefined;
  }
}

function uniqueId(
  baseId: string,
  role: "primary" | "secondary" | "individual",
  ids: Set<string>
): string {
  let id = baseId;
  let suffix = 1;
  while (ids.has(id)) {
    id = `${baseId}-${role}${suffix === 1 ? "" : `-${suffix}`}`;
    suffix += 1;
  }
  ids.add(id);
  return id;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function containsUsagePercent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsUsagePercent);
  const record = objectValue(value);
  if (!record) return false;
  return Object.entries(record).some(
    ([field, nested]) => /percent/i.test(field) || containsUsagePercent(nested)
  );
}

function rejectUnknownUsageFields(
  record: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
  drift: (message: string) => never
): void {
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) {
      drift(
        `Codex app-server ${path} contained an unrecognized usage field "${field}".`
      );
    }
  }
}

function tuiPercent(value: string, label: string, source: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new ParserDriftError(
      `Codex ${label} percentage was outside 0..100.`,
      source
    );
  }
  return parsed;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringifyUnknown(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function combineSourceText(primary: string, secondary?: string): string {
  if (!secondary || secondary === primary) return primary;
  return `${primary}\n${secondary}`;
}
