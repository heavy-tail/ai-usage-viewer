import type { UsageLimit, UsageProvider, UsageSnapshot } from "../types";
import { PROVIDER_ORDER, groupByProvider } from "./usage";

export function emptyUsageSnapshot(now = new Date().toISOString()): UsageSnapshot {
  return {
    generatedAt: now,
    collectors: PROVIDER_ORDER.map((provider) => ({
      provider,
      ok: false,
      state: "stale",
      checkedAt: now,
      durationMs: 0,
      error: "No snapshot has been loaded yet.",
    })),
    limits: [],
  };
}

export function visibleProvidersForSnapshot(
  snapshot: UsageSnapshot
): UsageProvider[] {
  const grouped = groupByProvider(snapshot.limits);
  const healthByProvider = Object.fromEntries(
    snapshot.collectors.map((collector) => [collector.provider, collector])
  );

  return PROVIDER_ORDER.filter((provider) => {
    const rows = actionableUsageLimits(grouped[provider]);
    const health = healthByProvider[provider];
    return rows.length > 0 || (health?.ok && !hasOnlyInformationalRows(grouped[provider]));
  });
}

export function actionableUsageLimits(limits: UsageLimit[]): UsageLimit[] {
  return limits.filter((limit) => !limit.informational);
}

function hasOnlyInformationalRows(limits: UsageLimit[]): boolean {
  return limits.length > 0 && actionableUsageLimits(limits).length === 0;
}
