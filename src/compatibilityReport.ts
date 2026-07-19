import type {
  CollectorState,
  UsageProvider,
  UsageSnapshot,
} from "./types";

export type ProviderCompatibility = {
  provider: UsageProvider;
  passed: boolean;
  state: CollectorState;
  attemptState: Exclude<CollectorState, "stale">;
  checkedAt: string;
  rowCount: number;
  adapterVersion?: string;
  formatFingerprint?: string;
  formatChanged?: boolean;
  rowInventoryChanged?: boolean;
  error?: string;
};

export type CompatibilityReport = {
  schemaVersion: 1;
  generatedAt: string;
  passed: boolean;
  providers: ProviderCompatibility[];
};

export function buildCompatibilityReport(
  snapshot: UsageSnapshot,
  enabledProviders: UsageProvider[]
): CompatibilityReport {
  const enabled = new Set(enabledProviders);
  const providers = snapshot.collectors
    .filter((health) => enabled.has(health.provider))
    .map((health): ProviderCompatibility => {
      const rowCount = snapshot.limits.filter(
        (limit) =>
          limit.provider === health.provider && !limit.informational
      ).length;
      return {
        provider: health.provider,
        passed:
          health.ok &&
          health.state === "ok" &&
          rowCount > 0 &&
          health.formatChanged !== true &&
          health.rowInventoryChanged !== true,
        state: health.state,
        attemptState:
          health.attemptState ??
          (health.state === "stale" ? "error" : health.state),
        checkedAt: health.checkedAt,
        rowCount,
        adapterVersion: health.adapterVersion,
        formatFingerprint: health.formatFingerprint,
        formatChanged: health.formatChanged,
        rowInventoryChanged: health.rowInventoryChanged,
        error: health.error,
      };
    });
  const providerCounts = new Map<UsageProvider, number>();
  for (const provider of providers) {
    providerCounts.set(
      provider.provider,
      (providerCounts.get(provider.provider) ?? 0) + 1
    );
  }
  const hasExactlyOneResultPerEnabledProvider = [...enabled].every(
    (provider) => providerCounts.get(provider) === 1
  );

  return {
    schemaVersion: 1,
    generatedAt: snapshot.generatedAt,
    passed:
      enabled.size > 0 &&
      hasExactlyOneResultPerEnabledProvider &&
      providers.length === enabled.size &&
      providers.every((provider) => provider.passed),
    providers,
  };
}
