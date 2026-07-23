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
import {
  isApprovedRowInventoryMigration,
  isConditionallyReportedLimit,
  type RowInventoryMigrationInput,
  verifyCollectorResult,
} from "./compatibility";
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
  lastError?: () => string | undefined;
};

export type RefreshServiceDependencies = {
  isRowInventoryMigrationApproved?: (
    input: RowInventoryMigrationInput
  ) => boolean;
};

export function createRefreshService(
  dependencies: RefreshServiceDependencies = {}
): RefreshService {
  let inFlight: Promise<UsageSnapshot> | null = null;
  let latestError: string | undefined;
  const migrationApproved =
    dependencies.isRowInventoryMigrationApproved ??
    isApprovedRowInventoryMigration;

  return {
    isRunning: () => inFlight != null,
    lastError: () => latestError,
    refresh: async (options = {}) => {
      if (inFlight) throw new RefreshInProgressError();
      latestError = undefined;
      inFlight = runRefresh(options, migrationApproved);
      try {
        return await inFlight;
      } catch (error) {
        if (!(error instanceof RefreshInProgressError)) {
          latestError =
            error instanceof Error ? error.message : "Usage refresh failed.";
        }
        throw error;
      } finally {
        inFlight = null;
      }
    },
  };
}

export const refreshService = createRefreshService();

async function runRefresh(
  options: RefreshOptions,
  migrationApproved: (input: RowInventoryMigrationInput) => boolean
): Promise<UsageSnapshot> {
  const rootDir = options.rootDir ?? process.cwd();
  const releaseLock = await tryAcquireRefreshLock(rootDir);
  if (!releaseLock) throw new RefreshInProgressError();
  try {
    return await runLockedRefresh(options, rootDir, migrationApproved);
  } finally {
    await releaseLock();
  }
}

async function runLockedRefresh(
  options: RefreshOptions,
  rootDir: string,
  migrationApproved: (input: RowInventoryMigrationInput) => boolean
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

  const collectProvider = async (provider: UsageProvider) => {
    const result = enabled.has(provider)
      ? await runProviderCollector(provider, collectorMap[provider], context)
      : disabledResult(provider);
    return [provider, result] as const;
  };

  // AGY's local language service is sensitive to simultaneous cold starts of
  // the three terminal-based CLIs on Windows. Start its structured RPC service
  // first, then keep Claude/Codex/Grok concurrent. This adds only AGY's normal
  // few-second startup while avoiding a 45-second false timeout and stale row.
  const agyResult = providersToRun.includes("agy")
    ? [await collectProvider("agy")]
    : [];
  const otherResults = await Promise.all(
    providersToRun
      .filter((provider) => provider !== "agy")
      .map(collectProvider)
  );
  const collected = [...agyResult, ...otherResults];
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
      const health = healthFromResult(
        result,
        previousRows,
        previousHealth,
        enabled.has(provider),
        migrationApproved
      );
      collectors.push(health);
      limits.push(...rowsFromResult(result, previousRows, health));
      continue;
    }

    // During a refresh-all, a provider with no result is one that is disabled in
    // config. Surface it as unavailable (not its stale `ok` health) and drop its
    // old rows so it disappears from the dashboard instead of looking current.
    if (!options.provider && !enabled.has(provider)) {
      collectors.push(
        healthFromResult(
          disabledResult(provider),
          [],
          previousHealth,
          false,
          migrationApproved
        )
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
  enabled: boolean,
  migrationApproved: (input: RowInventoryMigrationInput) => boolean
): CollectorHealth {
  const hasPreviousRows = previousRows.length > 0;
  const previousRowIds = actionableRowIds(previousRows);
  const currentRowIds = actionableRowIds(result.limits);
  const formatChanged =
    result.ok &&
    previous?.formatFingerprint !== undefined &&
    result.formatFingerprint !== undefined &&
    previous.formatFingerprint !== result.formatFingerprint;
  const rowInventoryChanged =
    result.ok && previousRowIds.length > 0
      ? !sameStringArray(previousRowIds, currentRowIds)
      : undefined;
  // A format-only parser update is intentional when the shipped adapter
  // version changed. Actionable row additions/removals need a second, exact
  // migration declaration; a version bump alone cannot authorize a subset.
  const adapterUpdated =
    result.ok &&
    previous !== undefined &&
    previous.adapterVersion !== result.adapterVersion;
  const inventoryMigrationApproved =
    rowInventoryChanged === true &&
    adapterUpdated &&
    migrationApproved({
      provider: result.provider,
      fromAdapterVersion: previous?.adapterVersion,
      toAdapterVersion: result.adapterVersion,
      previousRowIds,
      currentRowIds,
    });
  const compatibilityDrift =
    (formatChanged && !adapterUpdated) ||
    (rowInventoryChanged === true && !inventoryMigrationApproved);
  const attemptState = compatibilityDrift ? "drift" : result.state;
  const accepted = result.ok && !compatibilityDrift;
  const state: CollectorState =
    accepted || !hasPreviousRows ? attemptState : "stale";
  const attemptError = compatibilityDrift
    ? compatibilityDriftMessage(formatChanged, rowInventoryChanged === true)
    : result.error;
  // A failed attempt has not established a new verified contract. Preserve
  // the last accepted adapter/fingerprint so a repaired release with a bumped
  // adapter can recover automatically on the next successful refresh. Storing
  // a failed attempt's adapter here would consume that bump and deadlock the
  // repaired result behind same-version drift quarantine.
  const preserveVerifiedContract = state === "stale" && previous !== undefined;
  return {
    provider: result.provider,
    enabled,
    ok: accepted,
    state,
    attemptState,
    checkedAt: result.checkedAt,
    durationMs: result.durationMs,
    adapterVersion: preserveVerifiedContract
      ? previous.adapterVersion
      : result.adapterVersion,
    formatFingerprint: preserveVerifiedContract
      ? previous.formatFingerprint
      : result.formatFingerprint,
    formatChanged,
    rowInventoryChanged,
    error:
      state === "stale" && attemptError
        ? `Last refresh ${attemptState}: ${attemptError}`
        : attemptError,
  };
}

function compatibilityDriftMessage(
  formatChanged: boolean,
  rowInventoryChanged: boolean
): string {
  if (formatChanged && rowInventoryChanged) {
    return "Adapter contract rejected an unexpected provider format and quota-row inventory change.";
  }
  if (formatChanged) {
    return "Adapter contract rejected an unexpected provider format change.";
  }
  return "Adapter contract rejected an unexpected quota-row inventory change.";
}

function actionableRowIds(rows: UsageLimit[]): string[] {
  return rows
    .filter(
      (row) => !row.informational && !isConditionallyReportedLimit(row)
    )
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
  previousRows: UsageLimit[],
  health: CollectorHealth
): UsageLimit[] {
  if (health.ok) {
    return result.limits.map((row) => ({
      ...row,
      freshness: "verified",
      error: undefined,
    }));
  }
  if (previousRows.length === 0) return [];
  return previousRows.map((row) => markRowStale(row, health.error));
}

function markRowStale(row: UsageLimit, error?: string): UsageLimit {
  return {
    ...row,
    freshness: "stale",
    statusLabel: buildStaleStatusLabel(row.statusLabel),
    error,
  };
}
