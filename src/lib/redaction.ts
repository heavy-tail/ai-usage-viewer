import type { UsageSnapshot } from "../types";
import { EMAIL_PATTERN } from "./patterns";

const EMAIL_RE = new RegExp(EMAIL_PATTERN, "gi");
const CREDENTIAL_PREFIX_PATTERN = String.raw`(?:[A-Za-z][A-Za-z0-9_-]*?)?`;
const CREDENTIAL_KEY_PATTERN =
  String.raw`${CREDENTIAL_PREFIX_PATTERN}(?:api[\s_-]?key|access[\s_-]?key(?:[\s_-]?id)?|secret[\s_-]?access[\s_-]?key|secret[\s_-]?key|private[\s_-]?key|signing[\s_-]?key|access[\s_-]?token|auth[\s_-]?token|refresh[\s_-]?token|bearer[\s_-]?token|token|client[\s_-]?secret|secret|password|passwd|pwd)`;
const HEADER_SECRET_KEY_PATTERN =
  String.raw`${CREDENTIAL_PREFIX_PATTERN}(?:(?:proxy[\s_-]?)?authorization|cookie|set[\s_-]?cookie)`;
const CREDENTIAL_JSON_KEY_RE = new RegExp(
  `("(?:${CREDENTIAL_KEY_PATTERN}|${HEADER_SECRET_KEY_PATTERN})"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`,
  "gi"
);
const AUTH_HEADER_RE =
  /\b((?:proxy-)?authorization\s*:\s*)(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const COOKIE_HEADER_RE =
  /^([\t ]*(?:cookie|set-cookie)\s*:\s*)[^\r\n]*$/gim;
const PREFIXED_HEADER_LINE_RE =
  /^([\t ]*(?:(?!(?:proxy|set)[_-])[A-Za-z][A-Za-z0-9]*[_-])+(?:(?:proxy[_-]?)?authorization|cookie|set[_-]?cookie)\s*[:=]\s*)[^\r\n]*$/gim;
const CREDENTIAL_ASSIGNMENT_RE = new RegExp(
  `\\b(${CREDENTIAL_KEY_PATTERN}\\s*[:=]\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;}&]+)`,
  "gi"
);
const PROVIDER_TOKEN_RE =
  /\b(?:sk-(?:proj-|svcacct-|ant-api\d{2}-)?[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g;
const WINDOWS_USER_PROFILE_RE =
  /\b([A-Za-z]:(?:\\{1,2}|\/)(?:Users|Documents and Settings)(?:\\{1,2}|\/))([^\\/\r\n"]+)/gi;
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

type IdentityKind =
  | "organization"
  | "account"
  | "session"
  | "email"
  | "credential"
  | "cookie";

export function redactSensitiveText(text: string): string {
  return text
    .replace(CREDENTIAL_JSON_KEY_RE, '$1"<redacted-credential>"')
    .replace(AUTH_HEADER_RE, "$1$2 <redacted-credential>")
    .replace(COOKIE_HEADER_RE, "$1<redacted-cookie>")
    .replace(PREFIXED_HEADER_LINE_RE, "$1<redacted-credential>")
    .replace(CREDENTIAL_ASSIGNMENT_RE, "$1<redacted-credential>")
    .replace(PROVIDER_TOKEN_RE, "<redacted-provider-token>")
    .replace(WINDOWS_USER_PROFILE_RE, "$1<redacted-user>")
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

  if (
    /(?:apikey|accesskey(?:id)?|secretaccesskey|secretkey|privatekey|signingkey|token|clientsecret|secret|password|passwd|pwd)$/.test(
      normalized
    )
  ) {
    return "credential";
  }
  if (/(?:authorization|proxyauthorization)$/.test(normalized)) {
    return "credential";
  }
  if (/(?:cookie|setcookie)$/.test(normalized)) return "cookie";

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
  if (identity === "credential") return "<redacted-credential>";
  if (identity === "cookie") return "<redacted-cookie>";
  return "<redacted-account-id>";
}
