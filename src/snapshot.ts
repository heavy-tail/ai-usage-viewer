import type { CollectorState, UsageProvider, UsageSnapshot, UsageStatus } from "./types";

const PROVIDERS: UsageProvider[] = ["claude", "codex", "agy", "grok"];
const COLLECTOR_STATES: CollectorState[] = [
  "ok",
  "unavailable",
  "error",
  "drift",
  "stale",
];
const LIMIT_STATUSES: UsageStatus[] = [
  "available",
  "warning",
  "exhausted",
  "unknown",
  "unavailable",
  "error",
  "drift",
];

export function validateSnapshotShape(value: unknown): value is UsageSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as UsageSnapshot;
  if (typeof snapshot.generatedAt !== "string") return false;
  if (!Array.isArray(snapshot.collectors) || !Array.isArray(snapshot.limits)) {
    return false;
  }

  return (
    snapshot.collectors.every((collector) => {
      return (
        PROVIDERS.includes(collector.provider) &&
        typeof collector.ok === "boolean" &&
        COLLECTOR_STATES.includes(collector.state) &&
        typeof collector.checkedAt === "string" &&
        typeof collector.durationMs === "number"
      );
    }) &&
    snapshot.limits.every((limit) => {
      return (
        typeof limit.id === "string" &&
        PROVIDERS.includes(limit.provider) &&
        typeof limit.providerLabel === "string" &&
        typeof limit.scope === "string" &&
        LIMIT_STATUSES.includes(limit.status) &&
        typeof limit.sourceCommand === "string" &&
        typeof limit.sourceText === "string" &&
        typeof limit.checkedAt === "string"
      );
    })
  );
}
