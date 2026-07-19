import type { UsageLimit, UsageProvider, UsageSnapshot } from "../types";
import { PROVIDER_ORDER, groupByProvider } from "./usage";

export function emptyUsageSnapshot(now = new Date().toISOString()): UsageSnapshot {
  return {
    generatedAt: now,
    collectors: PROVIDER_ORDER.map((provider) => ({
      provider,
      enabled: false,
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
    if (health?.enabled === false) return false;
    if (health?.enabled === true) return true;
    // Backward compatibility for snapshots written before `enabled` existed.
    return (
      rows.length > 0 ||
      (health?.ok && !hasOnlyInformationalRows(grouped[provider]))
    );
  });
}

export function actionableUsageLimits(limits: UsageLimit[]): UsageLimit[] {
  return limits.filter((limit) => !limit.informational);
}

function hasOnlyInformationalRows(limits: UsageLimit[]): boolean {
  return limits.length > 0 && actionableUsageLimits(limits).length === 0;
}
