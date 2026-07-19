import type {
  CollectorHealth,
  CollectorState,
  UsageLimit,
  UsageProvider,
  UsageSnapshot,
} from "./types";
import { PROVIDER_ORDER } from "./lib/usage";
import { loadConfig } from "./config";
import { PROVIDER_COLLECTORS } from "./collectors";
import { runPty } from "./collectors/pty";
import { runCommand } from "./collectors/command";
import type {
  CollectorContext,
  ProviderCollector,
  ProviderCollectorResult,
} from "./collectors/types";
import {
  rawFileNameForProvider,
  purgeRawOutputs,
  readSnapshot,
  writeCompatibilityReport,
  writeSnapshot,
} from "./storage";
import { buildStaleStatusLabel } from "./lib/staleLabel";
import { verifyCollectorResult } from "./compatibility";
import { buildCompatibilityReport } from "./compatibilityReport";
import { tryAcquireRefreshLock } from "./refreshLock";

export class RefreshInProgressError extends Error {
  constructor() {
    super("A refresh is already running.");
    this.name = "RefreshInProgressError";
  }
}

export type RefreshOptions = {
  rootDir?: string;
  provider?: UsageProvider;
  collectors?: Partial<Record<UsageProvider, ProviderCollector>>;
};

export type RefreshService = {
  refresh: (options?: RefreshOptions) => Promise<UsageSnapshot>;
  isRunning: () => boolean;
};

export function createRefreshService(): RefreshService {
  let inFlight: Promise<UsageSnapshot> | null = null;

  return {
    isRunning: () => inFlight != null,
    refresh: async (options = {}) => {
      if (inFlight) throw new RefreshInProgressError();
      inFlight = runRefresh(options);
      try {
        return await inFlight;
      } finally {
        inFlight = null;
      }
    },
  };
}

export const refreshService = createRefreshService();

async function runRefresh(options: RefreshOptions): Promise<UsageSnapshot> {
  const rootDir = options.rootDir ?? process.cwd();
  const releaseLock = await tryAcquireRefreshLock(rootDir);
  if (!releaseLock) throw new RefreshInProgressError();
  try {
    return await runLockedRefresh(options, rootDir);
  } finally {
    await releaseLock();
  }
}

async function runLockedRefresh(
  options: RefreshOptions,
  rootDir: string
): Promise<UsageSnapshot> {
  const config = await loadConfig(rootDir);
  const previous = await readSnapshot(rootDir);
  // Older builds persisted broad CLI transcripts for diagnostics. Remove them
  // before collecting and keep all new compatibility evidence in memory or in
  // the narrowly redacted compatibility report.
  await purgeRawOutputs(rootDir);
  const enabled = new Set(config.enabledProviders);
  const providersToRun = options.provider
    ? [options.provider]
    : PROVIDER_ORDER.filter((provider) => enabled.has(provider));
  const collectorMap = { ...PROVIDER_COLLECTORS, ...options.collectors };
  const context: CollectorContext = {
    rootDir,
    config,
    ptyRunner: runPty,
    commandRunner: runCommand,
  };

  // Collectors are independent (each drives its own CLI / PTY), so run them
  // concurrently: total refresh time then tracks the slowest provider instead of
  // the sum of all four. Each provider still fails in isolation
  // (runProviderCollector never throws), and health/rows are merged below in
  // deterministic PROVIDER_ORDER, so output ordering is unaffected.
  const collected = await Promise.all(
    providersToRun.map(async (provider) => {
      const result = enabled.has(provider)
        ? await runProviderCollector(provider, collectorMap[provider], context)
        : disabledResult(provider);
      return [provider, result] as const;
    })
  );
  const results = new Map<UsageProvider, ProviderCollectorResult>(collected);

  const collectors: CollectorHealth[] = [];
  const limits: UsageLimit[] = [];

  for (const provider of PROVIDER_ORDER) {
    const result = results.get(provider);
    const previousRows =
      previous?.limits.filter((limit) => limit.provider === provider) ?? [];
    const previousHealth = previous?.collectors.find(
      (collector) => collector.provider === provider
    );

    if (result) {
      collectors.push(
        healthFromResult(
          result,
          previousRows,
          previousHealth,
          enabled.has(provider)
        )
      );
      limits.push(...rowsFromResult(result, previousRows));
      continue;
    }

    // During a refresh-all, a provider with no result is one that is disabled in
    // config. Surface it as unavailable (not its stale `ok` health) and drop its
    // old rows so it disappears from the dashboard instead of looking current.
    if (!options.provider && !enabled.has(provider)) {
      collectors.push(
        healthFromResult(disabledResult(provider), [], previousHealth, false)
      );
      continue;
    }

    if (previousHealth) {
      collectors.push({ ...previousHealth, enabled: enabled.has(provider) });
      limits.push(...previousRows);
      continue;
    }

    collectors.push({
      provider,
      enabled: enabled.has(provider),
      ok: false,
      state: "stale",
      checkedAt: new Date().toISOString(),
      durationMs: 0,
      error: "No snapshot exists for this provider yet.",
    });
  }

  const snapshot = await writeSnapshot(rootDir, {
    generatedAt: new Date().toISOString(),
    timezone: config.timezone,
    collectors,
    limits,
  });
  // The compatibility report is a global canary result: it is authoritative
  // only when every enabled provider was attempted in the same run. A
  // provider-only UI refresh still updates the snapshot, but must not replace a
  // previously green full-run report with a mixed-generation result.
  if (!options.provider) {
    await writeCompatibilityReport(
      rootDir,
      buildCompatibilityReport(snapshot, config.enabledProviders)
    );
  }
  return snapshot;
}

async function runProviderCollector(
  provider: UsageProvider,
  collector: ProviderCollector,
  context: CollectorContext
): Promise<ProviderCollectorResult> {
  try {
    const result = await collector(context);
    if (result.provider !== provider) {
      return verifyCollectorResult({
        ...result,
        provider,
        ok: false,
        state: "drift",
        limits: [],
        rawFileName: rawFileNameForProvider(provider),
        error: `Adapter contract rejected the refresh: collector routed for ${JSON.stringify(
          provider
        )} returned provider ${JSON.stringify(result.provider)}`,
      });
    }
    return verifyCollectorResult(result);
  } catch (error) {
    return verifyCollectorResult({
      provider,
      ok: false,
      state: "error",
      checkedAt: new Date().toISOString(),
      durationMs: 0,
      limits: [],
      rawText: "",
      cleanedText: "",
      rawFileName: rawFileNameForProvider(provider),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function disabledResult(provider: UsageProvider): ProviderCollectorResult {
  const checkedAt = new Date().toISOString();
  return {
    provider,
    ok: false,
    state: "unavailable",
    checkedAt,
    durationMs: 0,
    limits: [],
    rawText: "",
    cleanedText: `Provider "${provider}" is disabled in config.json.`,
    rawFileName: rawFileNameForProvider(provider),
    error: `Provider "${provider}" is disabled in config.json.`,
  };
}

function healthFromResult(
  result: ProviderCollectorResult,
  previousRows: UsageLimit[],
  previous: CollectorHealth | undefined,
  enabled: boolean
): CollectorHealth {
  const hasPreviousRows = previousRows.length > 0;
  const state: CollectorState =
    result.ok || !hasPreviousRows ? result.state : "stale";
  const previousRowIds = actionableRowIds(previousRows);
  const currentRowIds = actionableRowIds(result.limits);
  return {
    provider: result.provider,
    enabled,
    ok: result.ok,
    state,
    attemptState: result.state,
    checkedAt: result.checkedAt,
    durationMs: result.durationMs,
    adapterVersion: result.adapterVersion,
    formatFingerprint: result.formatFingerprint,
    formatChanged:
      previous?.formatFingerprint !== undefined &&
      result.formatFingerprint !== undefined &&
      previous.formatFingerprint !== result.formatFingerprint,
    rowInventoryChanged:
      result.ok && previousRowIds.length > 0
        ? !sameStringArray(previousRowIds, currentRowIds)
        : undefined,
    error:
      state === "stale" && result.error
        ? `Last refresh ${result.state}: ${result.error}`
        : result.error,
  };
}

function actionableRowIds(rows: UsageLimit[]): string[] {
  return rows
    .filter((row) => !row.informational)
    .map((row) => row.id)
    .sort();
}

function sameStringArray(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function rowsFromResult(
  result: ProviderCollectorResult,
  previousRows: UsageLimit[]
): UsageLimit[] {
  if (result.ok) {
    return result.limits.map((row) => ({
      ...row,
      freshness: "verified",
      error: undefined,
    }));
  }
  if (previousRows.length === 0) return [];
  return previousRows.map((row) => markRowStale(row, result));
}

function markRowStale(
  row: UsageLimit,
  result: ProviderCollectorResult
): UsageLimit {
  return {
    ...row,
    freshness: "stale",
    statusLabel: buildStaleStatusLabel(row.statusLabel),
    error: result.error,
  };
}
