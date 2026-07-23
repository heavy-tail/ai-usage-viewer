import { validateLimits } from "./compatibility";
import { buildCompatibilityReport } from "./compatibilityReport";
import { validateSnapshotShape } from "./snapshot";
import type {
  AppConfig,
  UsageLimit,
  UsageProvider,
  UsageSnapshot,
} from "./types";

export function compatibilityBaselineIssues(
  value: unknown,
  config: Pick<AppConfig, "enabledProviders" | "timezone">
): string[] {
  if (!validateSnapshotShape(value)) {
    return ["snapshot schema is invalid"];
  }

  const issues: string[] = [];
  if (Number.isNaN(Date.parse(value.generatedAt))) {
    issues.push("generatedAt is invalid");
  }
  if (value.timezone !== config.timezone) {
    issues.push("snapshot timezone does not match the canary configuration");
  }

  const report = buildCompatibilityReport(value, config.enabledProviders);
  if (!report.passed) issues.push("compatibility report is not passing");

  for (const provider of config.enabledProviders) {
    const health = value.collectors.filter(
      (collector) => collector.provider === provider
    );
    if (health.length !== 1) continue;
    if (health[0].enabled === false) {
      issues.push(`${provider} is marked disabled`);
    }
    if (!health[0].adapterVersion || !health[0].formatFingerprint) {
      issues.push(`${provider} lacks adapter provenance`);
    }
    if (Number.isNaN(Date.parse(health[0].checkedAt))) {
      issues.push(`${provider} collector timestamp is invalid`);
    }

    const rows = value.limits.filter((limit) => limit.provider === provider);
    const rowIssues = validateLimits(provider, rows);
    if (rowIssues.length > 0) {
      issues.push(`${provider} rows violate the adapter contract`);
    }
    if (rows.some((row) => row.freshness !== "verified")) {
      issues.push(`${provider} contains unverified rows`);
    }
  }

  const enabled = new Set<UsageProvider>(config.enabledProviders);
  if (value.limits.some((row) => !enabled.has(row.provider))) {
    issues.push("snapshot contains rows for a disabled provider");
  }
  return [...new Set(issues)];
}

/**
 * The protected canary needs only the last accepted structural contract:
 * collector fingerprints and semantic row IDs. Never promote account labels,
 * quota values, reset times, or provider-rendered text into the trust anchor.
 */
export function redactedCompatibilityBaseline(
  snapshot: UsageSnapshot
): UsageSnapshot {
  return {
    generatedAt: snapshot.generatedAt,
    timezone: snapshot.timezone,
    collectors: snapshot.collectors.map((collector) => ({
      provider: collector.provider,
      enabled: collector.enabled,
      ok: true,
      state: "ok",
      attemptState: "ok",
      checkedAt: snapshot.generatedAt,
      durationMs: 0,
      adapterVersion: collector.adapterVersion,
      formatFingerprint: collector.formatFingerprint,
      formatChanged: false,
      rowInventoryChanged: false,
    })),
    limits: snapshot.limits.map((row) =>
      redactedBaselineRow(row, snapshot.generatedAt)
    ),
  };
}

function redactedBaselineRow(
  row: UsageLimit,
  generatedAt: string
): UsageLimit {
  return {
    id: row.id,
    provider: row.provider,
    providerLabel: baselineProviderLabel(row.provider),
    scope: row.id,
    window: row.window ?? "structural",
    usedPercent: 0,
    remainingPercent: 100,
    status: "available",
    freshness: "verified",
    informational: row.informational === true,
    sourceCommand: "protected compatibility baseline",
    sourceText: `${row.id} structural contract`,
    checkedAt: generatedAt,
  };
}

function baselineProviderLabel(provider: UsageProvider): string {
  switch (provider) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "agy":
      return "Antigravity";
    case "grok":
      return "Grok";
  }
}
