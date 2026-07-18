import { createHash } from "node:crypto";
import type { UsageLimit, UsageProvider } from "./types";
import type { ProviderCollectorResult } from "./collectors/types";

// Adapter versions are independent of the application version. Bump the
// relevant value whenever a provider contract changes so snapshots and canary
// reports identify exactly which compatibility code produced them.
export const ADAPTER_VERSIONS: Record<UsageProvider, string> = {
  claude: "2.1.0",
  codex: "2.1.0",
  agy: "2.0.0",
  grok: "2.0.0",
};

/**
 * Enforce the normalized provider contract before a successful collector result
 * can replace the last verified snapshot. This is deliberately independent of
 * provider parsing: even an overly-permissive parser cannot publish malformed,
 * duplicate, cross-provider, or arithmetically impossible rows.
 */
export function verifyCollectorResult(
  result: ProviderCollectorResult
): ProviderCollectorResult {
  const enriched: ProviderCollectorResult = {
    ...result,
    adapterVersion: ADAPTER_VERSIONS[result.provider],
    formatFingerprint: fingerprintFormat(result.cleanedText),
  };

  if (!result.ok) return enriched;

  const issues = validateLimits(result.provider, result.limits);
  if (result.state !== "ok") {
    issues.unshift(`successful result has state ${JSON.stringify(result.state)}`);
  }
  if (issues.length === 0) return enriched;

  return {
    ...enriched,
    ok: false,
    state: "drift",
    limits: [],
    error: `Adapter contract rejected the refresh: ${issues.join("; ")}`,
  };
}

export function validateLimits(
  provider: UsageProvider,
  limits: UsageLimit[]
): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();

  if (limits.length === 0) {
    issues.push("no usage rows were recognized");
    return issues;
  }

  for (const limit of limits) {
    if (limit.provider !== provider) {
      issues.push(`${limit.id || "<missing-id>"} belongs to ${limit.provider}`);
    }
    if (!limit.id.startsWith(`${provider}:`)) {
      issues.push(`${limit.id || "<missing-id>"} has the wrong id namespace`);
    }
    if (ids.has(limit.id)) issues.push(`${limit.id} is duplicated`);
    ids.add(limit.id);

    if (!limit.scope.trim()) issues.push(`${limit.id} has no scope`);
    if (!limit.sourceCommand.trim()) {
      issues.push(`${limit.id} has no source command`);
    }
    if (!limit.sourceText.trim()) issues.push(`${limit.id} has no source text`);
    if (Number.isNaN(Date.parse(limit.checkedAt))) {
      issues.push(`${limit.id} has an invalid checkedAt timestamp`);
    }

    validatePercent(limit, "usedPercent", issues);
    validatePercent(limit, "remainingPercent", issues);

    if (
      !limit.informational &&
      limit.usedPercent === undefined &&
      limit.remainingPercent === undefined
    ) {
      issues.push(`${limit.id} has no usage percentage`);
    }

    if (
      limit.usedPercent !== undefined &&
      limit.remainingPercent !== undefined &&
      Math.abs(limit.usedPercent + limit.remainingPercent - 100) > 0.11
    ) {
      issues.push(`${limit.id} percentages do not add up to 100`);
    }
  }

  if (!limits.some((limit) => !limit.informational)) {
    issues.push("no actionable quota row was recognized");
  }

  return issues;
}

/**
 * Hash a privacy-safe structural form of terminal output. Dynamic percentages,
 * dates, identifiers, paths and whitespace are removed before hashing, making
 * the value useful for noticing layout drift without storing account content.
 */
export function fingerprintFormat(text: string): string | undefined {
  const normalized = normalizeFormat(text);
  if (!normalized) return undefined;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function validatePercent(
  limit: UsageLimit,
  field: "usedPercent" | "remainingPercent",
  issues: string[]
): void {
  const value = limit[field];
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    issues.push(`${limit.id} has an invalid ${field}`);
  }
}

function normalizeFormat(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "<email>")
    .replace(/\baccount\s*:\s*[^\r\n]+/gi, "account: <id>")
    .replace(
      /"(?:org(?:anization)?|account|acct|user|team|session)(?:[_-]?(?:id|name|label|email))?"\s*:\s*"(?:\\.|[^"\\])*"/gi,
      '"identity":"<id>"'
    )
    .replace(
      /\b(?:org(?:anization)?|account|acct|user|team|session)(?:[\s_-]?(?:id|name|label|email))?\s*[:=]\s*[^\r\n]+/gi,
      "identity: <id>"
    )
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){2,}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\bratelimitresetcredit_[0-9a-f]+\b/gi, "<id>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<id>")
    .replace(/\b(?:org|account|session|user|team)[_-][a-z0-9_-]+\b/gi, "<id>")
    .replace(/[a-z]:\\[^\r\n]+/gi, "<path>")
    .replace(/\b\d+(?:\.\d+)?%/g, "<percent>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<number>")
    .replace(/\s+/g, " ")
    .trim();
}
