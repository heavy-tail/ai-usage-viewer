import type { UsageSnapshot } from "../types";
import { EMAIL_PATTERN } from "./patterns";

const EMAIL_RE = new RegExp(EMAIL_PATTERN, "gi");
const ORG_KEY_RE =
  /\b(org(?:anization)?(?:[\s_-]?id)?\s*[:=]\s*)["']?[A-Za-z0-9][A-Za-z0-9_-]{3,}["']?/gi;
const ORG_VALUE_RE = /\borg[_-][A-Za-z0-9][A-Za-z0-9_-]{3,}\b/gi;
const ACCOUNT_KEY_RE =
  /\b((?:account|acct|user|team)(?:[\s_-]?id)?\s*[:=]\s*)["']?[A-Za-z0-9][A-Za-z0-9_-]{5,}["']?/gi;
const ACCOUNT_VALUE_RE =
  /\b(?:account|acct|user|team)[_-][A-Za-z0-9][A-Za-z0-9_-]{5,}\b/gi;
const SESSION_KEY_RE =
  /\b(session(?:[\s_-]?id)?\s*[:=]\s*)[0-9a-f]{8,}(?:-[0-9a-f]{4,}){2,}/gi;

export function redactSensitiveText(text: string): string {
  return text
    .replace(EMAIL_RE, "<redacted-email>")
    .replace(ORG_KEY_RE, "$1<redacted-org-id>")
    .replace(ORG_VALUE_RE, "<redacted-org-id>")
    .replace(ACCOUNT_KEY_RE, "$1<redacted-account-id>")
    .replace(ACCOUNT_VALUE_RE, "<redacted-account-id>")
    .replace(SESSION_KEY_RE, "$1<redacted-session-id>");
}

export function redactSnapshot(snapshot: UsageSnapshot): UsageSnapshot {
  return redactValue(snapshot) as UsageSnapshot;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactValue(nested)])
    );
  }
  return value;
}
