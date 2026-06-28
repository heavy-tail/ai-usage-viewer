import type {
  CollectorHealth,
  CollectorState,
  UsageLimit,
  UsageProvider,
  UsageSnapshot,
} from "./types";
import { PROVIDER_ORDER, deriveStatus } from "./lib/usage";
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
  readSnapshot,
  writeRawOutput,
  writeSnapshot,
} from "./storage";
import { buildStaleStatusLabel } from "./lib/staleLabel";

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
  const config = await loadConfig(rootDir);
  const previous = await readSnapshot(rootDir);
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
      await writeRawOutput(
        rootDir,
        result.rawFileName,
        result.cleanedText || result.error || "No collector output captured."
      );
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
      collectors.push(healthFromResult(result, previousRows.length > 0));
      limits.push(...rowsFromResult(result, previousRows));
      continue;
    }

    // During a refresh-all, a provider with no result is one that is disabled in
    // config. Surface it as unavailable (not its stale `ok` health) and drop its
    // old rows so it disappears from the dashboard instead of looking current.
    if (!options.provider && !enabled.has(provider)) {
      collectors.push(healthFromResult(disabledResult(provider), false));
      continue;
    }

    if (previousHealth) {
      collectors.push(previousHealth);
      limits.push(...previousRows);
      continue;
    }

    collectors.push({
      provider,
      ok: false,
      state: "stale",
      checkedAt: new Date().toISOString(),
      durationMs: 0,
      error: "No snapshot exists for this provider yet.",
    });
  }

  return writeSnapshot(rootDir, {
    generatedAt: new Date().toISOString(),
    collectors,
    limits,
  });
}

async function runProviderCollector(
  provider: UsageProvider,
  collector: ProviderCollector,
  context: CollectorContext
): Promise<ProviderCollectorResult> {
  try {
    return await collector(context);
  } catch (error) {
    return {
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
    };
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
  hasPreviousRows: boolean
): CollectorHealth {
  const state: CollectorState =
    result.ok || !hasPreviousRows ? result.state : "stale";
  return {
    provider: result.provider,
    ok: result.ok,
    state,
    checkedAt: result.checkedAt,
    durationMs: result.durationMs,
    error:
      state === "stale" && result.error
        ? `Last refresh ${result.state}: ${result.error}`
        : result.error,
  };
}

function rowsFromResult(
  result: ProviderCollectorResult,
  previousRows: UsageLimit[]
): UsageLimit[] {
  if (result.ok) return result.limits;
  if (previousRows.length === 0) return [];
  return previousRows.map((row) => markRowStale(row, result));
}

function markRowStale(
  row: UsageLimit,
  result: ProviderCollectorResult
): UsageLimit {
  return {
    ...row,
    status: deriveStatus(row.usedPercent, row.remainingPercent),
    statusLabel: buildStaleStatusLabel(row.statusLabel),
    error: result.error,
  };
}
