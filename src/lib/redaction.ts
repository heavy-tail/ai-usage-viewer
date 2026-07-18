import type { UsageSnapshot } from "../types";
import { EMAIL_PATTERN } from "./patterns";

const EMAIL_RE = new RegExp(EMAIL_PATTERN, "gi");
const ORG_LINE_RE =
  /^[\t ]*((?:org(?:anization)?)(?:[\s_-]?(?:id|name|label))?\s*[:=]\s*)[^\r\n]+$/gim;
const ORG_KEY_RE =
  /\b(org(?:anization)?(?:[\s_-]?(?:id|name|label))?\s*[:=]\s*)["']?[A-Za-z0-9][A-Za-z0-9_-]{3,}["']?/gi;
const ORG_VALUE_RE = /\borg[_-][A-Za-z0-9][A-Za-z0-9_-]{3,}\b/gi;
const ACCOUNT_KEY_RE =
  /\b((?:account|acct|user|team)(?:[\s_-]?(?:id|name|label|email))?\s*[:=]\s*)["']?[A-Za-z0-9][A-Za-z0-9_-]{5,}["']?/gi;
const ACCOUNT_VALUE_RE =
  /\b(?:account|acct|user|team)[_-][A-Za-z0-9][A-Za-z0-9_-]{5,}\b/gi;
const SESSION_KEY_RE =
  /\b(session(?:[\s_-]?id)?\s*[:=]\s*)[0-9a-f]{8,}(?:-[0-9a-f]{4,}){2,}/gi;
const ORG_JSON_KEY_RE =
  /("org(?:anization)?(?:[_-]?(?:id|name|label))?"\s*:\s*)"(?:\\.|[^"\\])*"/gi;
const ACCOUNT_JSON_KEY_RE =
  /("(?:account|acct|user|team)(?:[_-]?(?:id|name|label|email))?"\s*:\s*)"(?:\\.|[^"\\])*"/gi;
const SESSION_JSON_KEY_RE =
  /("session(?:[_-]?id)?"\s*:\s*)"(?:\\.|[^"\\])*"/gi;
const ACCOUNT_LINE_RE = /\b(Account\s*:\s*)[^\r\n]+/gi;
const RESET_CREDIT_ID_RE = /\bRateLimitResetCredit_[0-9a-f]+\b/gi;
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const REDACTION_MARKER_RE = /<redacted-[a-z-]+>/i;

type IdentityKind = "organization" | "account" | "session" | "email";

export function redactSensitiveText(text: string): string {
  return text
    .replace(EMAIL_RE, "<redacted-email>")
    .replace(ORG_LINE_RE, "$1<redacted-org-id>")
    .replace(ORG_KEY_RE, "$1<redacted-org-id>")
    .replace(ORG_VALUE_RE, "<redacted-org-id>")
    .replace(ACCOUNT_KEY_RE, "$1<redacted-account-id>")
    .replace(ACCOUNT_VALUE_RE, "<redacted-account-id>")
    .replace(SESSION_KEY_RE, "$1<redacted-session-id>")
    .replace(ORG_JSON_KEY_RE, '$1"<redacted-org-id>"')
    .replace(ACCOUNT_JSON_KEY_RE, '$1"<redacted-account-id>"')
    .replace(SESSION_JSON_KEY_RE, '$1"<redacted-session-id>"')
    .replace(ACCOUNT_LINE_RE, "$1<redacted-account-id>")
    .replace(RESET_CREDIT_ID_RE, "<redacted-reset-credit-id>")
    .replace(UUID_RE, "<redacted-id>");
}

export function redactSnapshot(snapshot: UsageSnapshot): UsageSnapshot {
  return redactSensitiveValue(snapshot);
}

/**
 * Redact an arbitrary JSON-shaped value before it is serialized.
 *
 * Running text substitutions over a completed JSON document is unsafe: a
 * pattern that consumes the rest of a line can also consume JSON punctuation.
 * Walking the value first both preserves valid JSON and lets field names such
 * as `orgName` and `accountLabel` protect otherwise-unstructured labels.
 */
export function redactSensitiveValue<T>(value: T): T {
  return redactValue(value) as T;
}

function redactValue(
  value: unknown,
  key?: string,
  inheritedIdentity?: IdentityKind
): unknown {
  const identity = identityKindForKey(key, inheritedIdentity);

  if (typeof value === "string") {
    const redacted = redactSensitiveText(value);
    if (!identity || redacted !== value || REDACTION_MARKER_RE.test(value)) {
      return redacted;
    }
    return markerForIdentity(identity);
  }
  if (
    identity &&
    (typeof value === "number" || typeof value === "bigint")
  ) {
    return markerForIdentity(identity);
  }
  if (Array.isArray(value)) {
    return value.map((nested) => redactValue(nested, undefined, identity));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nested]) => [
        nestedKey,
        redactValue(nested, nestedKey, identity),
      ])
    );
  }
  return value;
}

function identityKindForKey(
  key: string | undefined,
  inheritedIdentity: IdentityKind | undefined
): IdentityKind | undefined {
  if (!key) return inheritedIdentity;
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();

  if (/^(?:org|organization)(?:id|name|label)?$/.test(normalized)) {
    return "organization";
  }
  if (/^(?:account|acct|user|team)(?:id|name|label|email)?$/.test(normalized)) {
    return "account";
  }
  if (/^session(?:id|name|label)?$/.test(normalized)) return "session";
  if (/^(?:email|emailaddress)$/.test(normalized)) return "email";

  // When an identity is represented as an object (for example,
  // `{ organization: { name: "Private org" } }`), only redact its explicit
  // identity leaves. Do not inherit into unrelated descriptive/UI fields.
  if (
    inheritedIdentity &&
    /^(?:id|name|label|email|value)$/.test(normalized)
  ) {
    return inheritedIdentity;
  }
  return undefined;
}

function markerForIdentity(identity: IdentityKind): string {
  if (identity === "organization") return "<redacted-org-id>";
  if (identity === "session") return "<redacted-session-id>";
  if (identity === "email") return "<redacted-email>";
  return "<redacted-account-id>";
}
