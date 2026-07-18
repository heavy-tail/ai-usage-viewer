import type { UsageLimit } from "../types";
import { limitFromRemaining, slugifyId, type ParserMeta } from "./common";
import { ParserDriftError } from "./errors";

const SOURCE_COMMAND = "agy local quota API";
const REDACTED_SOURCE = "Antigravity local quota API response (redacted)";
const MAX_GROUPS = 64;
const MAX_BUCKETS_PER_GROUP = 64;
const MAX_TOTAL_BUCKETS = 512;
const MAX_LABEL_LENGTH = 256;
const MAX_WINDOW_LENGTH = 128;
const MAX_ID_LENGTH = 512;
const MAX_DESCRIPTION_LENGTH = 4_096;
const GROUP_FIELDS = new Set(["displayName", "description", "buckets"]);
const BUCKET_FIELDS = new Set([
  "bucketId",
  "displayName",
  "description",
  "window",
  "remainingFraction",
  "resetTime",
  "disabled",
  "remainingAmount",
]);

type CanonicalBucket = {
  group: string;
  window: string;
  remainingPercent: number;
  resetAt?: string;
};

export type ParsedAgyRpcQuota = {
  limits: UsageLimit[];
  sourceText: string;
};

/**
 * Parse Antigravity's local Connect RPC quota response without retaining the
 * raw response. Descriptions and bucket identifiers are deliberately omitted
 * from source text because they are not needed to explain a quota row and may
 * contain account- or project-specific data.
 */
export function parseAgyRpcQuota(
  payload: unknown,
  meta: ParserMeta,
  pinnedGroups: string[] = []
): ParsedAgyRpcQuota {
  const root = objectValue(payload);
  const response = objectValue(root?.response);
  if (!root || !response) {
    throwDrift("Agy local quota API response did not contain a response object.");
  }

  const groups = response.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    throwDrift("Agy local quota API response contained no quota groups.");
  }
  if (groups.length > MAX_GROUPS) {
    throwDrift(`Agy local quota API response exceeded ${MAX_GROUPS} groups.`);
  }
  optionalString(
    response.description,
    "local quota API response description",
    MAX_DESCRIPTION_LENGTH,
    throwDrift
  );
  if (hasOwn(response, "buckets")) {
    if (!Array.isArray(response.buckets)) {
      throwDrift("Agy local quota API response buckets was not an array.");
    }
    if (response.buckets.length > 0) {
      throwDrift(
        "Agy local quota API returned unsupported ungrouped quota buckets."
      );
    }
  }

  const pins = new Set(
    pinnedGroups.map((group) => normalizedComparison(group)).filter(Boolean)
  );
  const seenRows = new Set<string>();
  const seenIds = new Set<string>();
  const parsed: Array<{ canonical: CanonicalBucket; limit: UsageLimit }> = [];
  let totalBuckets = 0;

  for (const [groupIndex, groupValue] of groups.entries()) {
    const group = objectValue(groupValue);
    if (!group) {
      throwDrift(`Agy quota group ${groupIndex + 1} was not an object.`);
    }
    rejectUnknownUsageFields(group, GROUP_FIELDS, "quota group", throwDrift);
    const groupName = requiredString(
      group.displayName,
      `quota group ${groupIndex + 1} displayName`,
      MAX_LABEL_LENGTH,
      throwDrift
    );
    optionalString(
      group.description,
      `quota group "${groupName}" description`,
      MAX_DESCRIPTION_LENGTH,
      throwDrift
    );

    const buckets = group.buckets;
    if (!Array.isArray(buckets) || buckets.length === 0) {
      throwDrift(`Agy quota group "${groupName}" contained no buckets.`);
    }
    if (buckets.length > MAX_BUCKETS_PER_GROUP) {
      throwDrift(
        `Agy quota group "${groupName}" exceeded ${MAX_BUCKETS_PER_GROUP} buckets.`
      );
    }
    totalBuckets += buckets.length;
    if (totalBuckets > MAX_TOTAL_BUCKETS) {
      throwDrift(
        `Agy local quota API response exceeded ${MAX_TOTAL_BUCKETS} buckets.`
      );
    }

    for (const [bucketIndex, bucketValue] of buckets.entries()) {
      const bucket = objectValue(bucketValue);
      if (!bucket) {
        throwDrift(
          `Agy quota bucket ${bucketIndex + 1} in "${groupName}" was not an object.`
        );
      }
      rejectUnknownUsageFields(
        bucket,
        BUCKET_FIELDS,
        `quota bucket ${bucketIndex + 1}`,
        throwDrift
      );
      optionalString(
        bucket.displayName,
        `quota bucket ${bucketIndex + 1} displayName`,
        MAX_LABEL_LENGTH,
        throwDrift
      );
      optionalString(
        bucket.bucketId,
        `quota bucket ${bucketIndex + 1} bucketId`,
        MAX_ID_LENGTH,
        throwDrift
      );
      optionalString(
        bucket.description,
        `quota bucket ${bucketIndex + 1} description`,
        MAX_DESCRIPTION_LENGTH,
        throwDrift
      );
      if (hasOwn(bucket, "remainingAmount")) {
        throwDrift(
          `Agy quota bucket ${bucketIndex + 1} used unsupported remainingAmount.`
        );
      }
      if (
        hasOwn(bucket, "disabled") &&
        typeof bucket.disabled !== "boolean"
      ) {
        throwDrift(`Agy quota bucket ${bucketIndex + 1} disabled was not boolean.`);
      }
      if (bucket.disabled === true) continue;
      const rawWindow = requiredString(
        bucket.window,
        `quota bucket ${bucketIndex + 1} window`,
        MAX_WINDOW_LENGTH,
        throwDrift
      );
      const window = normalizeWindow(rawWindow);
      const remainingFraction = bucket.remainingFraction;
      if (
        typeof remainingFraction !== "number" ||
        !Number.isFinite(remainingFraction) ||
        remainingFraction < 0 ||
        remainingFraction > 1
      ) {
        throwDrift(
          `Agy quota fraction for "${groupName}" / "${window}" was outside 0..1.`
        );
      }

      const duplicateKey = `${normalizedComparison(groupName)}\u0000${normalizedComparison(window)}`;
      if (seenRows.has(duplicateKey)) {
        throwDrift(
          `Agy local quota API response repeated "${groupName}" / "${window}".`
        );
      }
      seenRows.add(duplicateKey);

      const resetAt = optionalResetTime(
        bucket.resetTime,
        `quota bucket "${groupName}" / "${window}" resetTime`,
        throwDrift
      );
      const remainingPercent = roundPercent(remainingFraction * 100);
      const canonical: CanonicalBucket = {
        group: groupName,
        window,
        remainingPercent,
        ...(resetAt ? { resetAt } : {}),
      };

      if (pins.size > 0 && !pins.has(normalizedComparison(groupName))) {
        continue;
      }

      const rowSourceText = canonicalText([canonical]);
      const baseId = `agy:${idPart(groupName, "group")}:${idPart(window, "window")}`;
      const id = uniqueRowId(baseId, duplicateKey, seenIds);
      const limit = limitFromRemaining({
        id,
        provider: "agy",
        providerLabel: "Antigravity",
        scope: groupName,
        window,
        remainingPercent,
        resetLabel: resetAt ? relativeResetLabel(resetAt, meta.checkedAt) : undefined,
        resetAt,
        // Status must be a function of the structured fraction. Do not let a
        // display label containing words such as "exhausted" override it.
        sourceText: `${remainingPercent}% remaining`,
        meta: { ...meta, sourceCommand: SOURCE_COMMAND },
      });
      parsed.push({
        canonical,
        limit: { ...limit, sourceText: rowSourceText },
      });
    }
  }

  if (parsed.length === 0) {
    throwDrift("Agy local quota API response contained no selected quota groups.");
  }

  return {
    limits: parsed.map((item) => item.limit),
    sourceText: canonicalText(parsed.map((item) => item.canonical)),
  };
}

function throwDrift(message: string): never {
  throw new ParserDriftError(message, REDACTED_SOURCE);
}

function rejectUnknownUsageFields(
  record: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
  drift: (message: string) => never
): void {
  for (const field of Object.keys(record)) {
    if (
      !allowed.has(field) &&
      /(?:fraction|percent|amount|reset|window|disabled|quota|limit)/i.test(field)
    ) {
      drift(`Agy ${path} contained an unrecognized usage field "${field}".`);
    }
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
  drift: (message: string) => never
): string {
  if (typeof value !== "string" || !value.trim()) {
    drift(`Agy ${field} was not a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    drift(`Agy ${field} exceeded ${maxLength} characters.`);
  }
  return trimmed;
}

function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
  drift: (message: string) => never
): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field, maxLength, drift);
}

function normalizeWindow(rawWindow: string): string {
  const aliases = rawWindow.toLowerCase().replace(/[_-]+/g, " ");
  if (/\b(?:weekly|week|1\s*w|7\s*days?|168\s*h(?:ours?)?)\b/.test(aliases)) {
    return "weekly";
  }
  if (/\b(?:five|5)\s*(?:hours?|h)\b/.test(aliases)) {
    return "5h";
  }
  return rawWindow.trim().toLowerCase().replace(/[\s_-]+/g, "-");
}

function optionalResetTime(
  value: unknown,
  field: string,
  drift: (message: string) => never
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isRfc3339(value)) {
    drift(`Agy ${field} was not a valid RFC3339 timestamp.`);
  }
  return new Date(value).toISOString();
}

function isRfc3339(value: string): boolean {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/
  );
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[8] ?? 0);
  const offsetMinute = Number(match[9] ?? 0);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function relativeResetLabel(resetAt: string, checkedAt: string): string {
  const resetMs = Date.parse(resetAt);
  const checkedMs = Date.parse(checkedAt);
  const totalMinutes = Number.isFinite(checkedMs)
    ? Math.max(0, Math.ceil((resetMs - checkedMs) / 60_000))
    : 0;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `Refreshes in ${hours}h ${minutes}m`;
}

function roundPercent(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizedComparison(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function idPart(value: string, fallback: string): string {
  return slugifyId(value) || `${fallback}-${fnv1a(value)}`;
}

function uniqueRowId(
  baseId: string,
  semanticKey: string,
  ids: Set<string>
): string {
  let id = baseId;
  if (ids.has(id)) id = `${baseId}-${fnv1a(semanticKey)}`;
  let suffix = 2;
  while (ids.has(id)) {
    id = `${baseId}-${fnv1a(semanticKey)}-${suffix}`;
    suffix += 1;
  }
  ids.add(id);
  return id;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function canonicalText(buckets: CanonicalBucket[]): string {
  const ordered = [...buckets].sort(compareCanonicalBuckets);
  return JSON.stringify(
    {
      provider: "agy",
      source: SOURCE_COMMAND,
      quotas: ordered,
    },
    null,
    2
  );
}

function compareCanonicalBuckets(
  left: CanonicalBucket,
  right: CanonicalBucket
): number {
  return (
    compareCodeUnits(left.group, right.group) ||
    compareCodeUnits(left.window, right.window)
  );
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function hasOwn(record: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}
