import type { UsageLimit, UsageProvider } from "../types";
import { fromRemainingPercent, fromUsedPercent, statusFromPercent } from "../lib/percent";

export type ParserMeta = {
  checkedAt: string;
  sourceCommand: string;
  // Timezone used by the provider process when output omits an offset. This is
  // intentionally independent from the user's display timezone.
  sourceTimeZone?: string;
  planLabel?: string;
  accountLabel?: string;
};

export function localSourceTimeZone(): string | undefined {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timeZone) return undefined;
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return timeZone;
  } catch {
    return undefined;
  }
}

export function limitFromUsed(input: {
  id: string;
  provider: UsageProvider;
  providerLabel: string;
  scope: string;
  usedPercent: number;
  sourceText: string;
  meta: ParserMeta;
  window?: string;
  resetLabel?: string;
  resetAt?: string;
  statusLabel?: string;
  informational?: boolean;
}): UsageLimit {
  const percent = fromUsedPercent(input.usedPercent);
  return {
    id: input.id,
    provider: input.provider,
    providerLabel: input.providerLabel,
    planLabel: input.meta.planLabel,
    accountLabel: input.meta.accountLabel,
    scope: input.scope,
    window: input.window,
    ...percent,
    resetLabel: input.resetLabel,
    resetAt: input.resetAt,
    status: statusFromPercent(percent, input.sourceText, input.informational),
    statusLabel: input.statusLabel,
    informational: input.informational,
    sourceCommand: input.meta.sourceCommand,
    sourceText: input.sourceText,
    checkedAt: input.meta.checkedAt,
  };
}

export function limitFromRemaining(input: {
  id: string;
  provider: UsageProvider;
  providerLabel: string;
  scope: string;
  remainingPercent: number;
  sourceText: string;
  meta: ParserMeta;
  window?: string;
  resetLabel?: string;
  resetAt?: string;
  statusLabel?: string;
  informational?: boolean;
}): UsageLimit {
  const percent = fromRemainingPercent(input.remainingPercent);
  return {
    id: input.id,
    provider: input.provider,
    providerLabel: input.providerLabel,
    planLabel: input.meta.planLabel,
    accountLabel: input.meta.accountLabel,
    scope: input.scope,
    window: input.window,
    ...percent,
    resetLabel: input.resetLabel,
    resetAt: input.resetAt,
    status: statusFromPercent(percent, input.sourceText, input.informational),
    statusLabel: input.statusLabel,
    informational: input.informational,
    sourceCommand: input.meta.sourceCommand,
    sourceText: input.sourceText,
    checkedAt: input.meta.checkedAt,
  };
}

export function slugifyId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
