import {
  RefreshInProgressError,
  type RefreshService,
} from "../refresh";

export const DEFAULT_COMPATIBILITY_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export type CompatibilityMonitor = {
  runNow: () => Promise<void>;
  stop: () => void;
};

export function startCompatibilityMonitor(input: {
  rootDir: string;
  refresh: RefreshService;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}): CompatibilityMonitor {
  const intervalMs = input.intervalMs ?? DEFAULT_COMPATIBILITY_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("Compatibility monitor interval must be greater than zero.");
  }

  let stopped = false;
  const runNow = async () => {
    if (stopped || input.refresh.isRunning()) return;
    try {
      await input.refresh.refresh({ rootDir: input.rootDir });
    } catch (error) {
      // A browser refresh can win the small race between isRunning() and
      // refresh(). That is normal and should not produce a background alert.
      if (!(error instanceof RefreshInProgressError)) input.onError?.(error);
    }
  };

  const timer = setInterval(() => void runNow(), intervalMs);
  timer.unref();

  return {
    runNow,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
