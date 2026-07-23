import { useCallback, useEffect, useMemo, useState } from "react";
import type { UsageProvider, UsageSnapshot } from "./types";
import {
  ApiError,
  getSnapshot,
  refreshAll as apiRefreshAll,
  refreshProvider as apiRefreshProvider,
} from "./api";
import { groupByProvider, snapshotPlanLabel } from "./lib/usage";
import {
  actionableUsageLimits,
  emptyUsageSnapshot,
  visibleProvidersForSnapshot,
} from "./lib/snapshotView";
import { Header } from "./components/Header";
import { ProviderCard } from "./components/ProviderCard";

type Connection = "loading" | "live" | "offline";

export function App() {
  const [snapshot, setSnapshot] = useState<UsageSnapshot>(() =>
    emptyUsageSnapshot()
  );
  const [connection, setConnection] = useState<Connection>("loading");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<"all" | UsageProvider | null>(null);
  const [queuedProviders, setQueuedProviders] = useState<UsageProvider[]>([]);

  // Refresh initiation is asynchronous. Follow the server-owned operation
  // until its cross-process lock clears, including legitimate cold starts that
  // exceed an individual HTTP request budget.
  const pollUntilIdle = useCallback(async (signal?: AbortSignal) => {
    for (let i = 0; i < 150; i += 1) {
      await sleep(2_000);
      if (signal?.aborted) return;
      let poll;
      try {
        poll = await getSnapshot(signal);
      } catch {
        // A transient failure while the refresh lock is held is expected;
        // keep polling until it clears or we hit the attempt cap.
        continue;
      }
      if (signal?.aborted) return;
      setSnapshot(poll.snapshot);
      setConnection("live");
      if (!poll.refreshing) {
        if (poll.error) throw new Error(poll.error);
        return;
      }
    }
    throw new Error("Refresh verification timed out.");
  }, []);

  const refreshAll = useCallback(async () => {
    setRefreshing("all");
    setQueuedProviders([]);
    setError(null);
    try {
      const result = await apiRefreshAll();
      setSnapshot(result.snapshot);
      setConnection("live");
      if (result.refreshing) await pollUntilIdle();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Another browser, the background monitor, or a command-line canary is
        // already refreshing. Follow that run quietly and show its verified
        // result when the shared lock clears.
        try {
          await pollUntilIdle();
        } catch (pollError) {
          setError(messageOf(pollError));
          setConnection((current) =>
            current === "live" ? current : "offline"
          );
        }
      } else {
        setError(messageOf(err));
        setConnection((c) => (c === "live" ? c : "offline"));
      }
    } finally {
      setRefreshing(null);
    }
  }, [pollUntilIdle]);

  // On open: show the last stored snapshot instantly, then auto-refresh so the
  // numbers are current without the user clicking "Refresh all". If a refresh is
  // already running server-side, follow that one instead of starting another.
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const first = await getSnapshot(controller.signal);
        if (controller.signal.aborted) return;
        setSnapshot(first.snapshot);
        setConnection("live");
        setError(null);
        if (first.refreshing) {
          setRefreshing("all");
          await pollUntilIdle(controller.signal);
          if (!controller.signal.aborted) setRefreshing(null);
        } else if (!controller.signal.aborted) {
          void refreshAll();
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setSnapshot(emptyUsageSnapshot());
        setConnection("offline");
        setError(messageOf(err));
      }
    })();
    return () => controller.abort();
  }, [pollUntilIdle, refreshAll]);

  const runProviderRefresh = useCallback(
    async (provider: UsageProvider) => {
      setRefreshing(provider);
      setError(null);
      try {
        const result = await apiRefreshProvider(provider);
        setSnapshot(result.snapshot);
        setConnection("live");
        if (result.refreshing) await pollUntilIdle();
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          try {
            await pollUntilIdle();
          } catch (pollError) {
            setError(messageOf(pollError));
            setConnection((current) =>
              current === "live" ? current : "offline"
            );
          }
        } else {
          setError(messageOf(err));
          setConnection((c) => (c === "live" ? c : "offline"));
        }
      } finally {
        setRefreshing(null);
      }
    },
    [pollUntilIdle]
  );

  const refreshProvider = useCallback(
    (provider: UsageProvider) => {
      if (refreshing != null) {
        if (refreshing === "all" || refreshing === provider) return;
        setQueuedProviders((providers) =>
          providers.includes(provider) ? providers : [...providers, provider]
        );
        return;
      }

      void runProviderRefresh(provider);
    },
    [refreshing, runProviderRefresh]
  );

  useEffect(() => {
    if (refreshing != null || queuedProviders.length === 0) return;
    const [nextProvider, ...rest] = queuedProviders;
    setQueuedProviders(rest);
    void runProviderRefresh(nextProvider);
  }, [queuedProviders, refreshing, runProviderRefresh]);

  const grouped = useMemo(() => groupByProvider(snapshot.limits), [snapshot]);
  const healthByProvider = useMemo(
    () => Object.fromEntries(snapshot.collectors.map((c) => [c.provider, c])),
    [snapshot]
  );
  const visibleProviders = useMemo(
    () => visibleProvidersForSnapshot(snapshot),
    [snapshot]
  );

  return (
    <div className="app">
      <Header
        refreshing={refreshing != null || queuedProviders.length > 0}
        onRefresh={refreshAll}
      />

      <main className="container">
        <ConnectionNotice connection={connection} error={error} />

        {/* Provider usage cards are the first thing on screen. */}
        <div className="grid grid-2">
          {visibleProviders.map((p) => (
            <ProviderCard
              key={p}
              provider={p}
              limits={actionableUsageLimits(grouped[p])}
              health={healthByProvider[p]}
              plan={snapshotPlanLabel(snapshot, p)}
              refreshing={refreshing === p}
              queued={queuedProviders.includes(p)}
              refreshDisabled={
                refreshing === "all" ||
                refreshing === p ||
                queuedProviders.includes(p)
              }
              onRefresh={() => refreshProvider(p)}
              timeZone={snapshot.timezone}
            />
          ))}
        </div>
        {visibleProviders.length === 0 &&
          connection === "live" &&
          refreshing != null && (
            <div className="notice">Checking enabled providers…</div>
          )}
        {visibleProviders.length === 0 &&
          connection === "live" &&
          refreshing == null && (
          <div className="notice">
            No usage providers are enabled.
          </div>
        )}
      </main>
    </div>
  );
}

function ConnectionNotice({
  connection,
  error,
}: {
  connection: Connection;
  error: string | null;
}) {
  if (connection === "loading") {
    return <div className="notice">Connecting to the local collector API…</div>;
  }
  if (connection === "offline") {
    return (
      <div className="notice notice-warn">
        Usage is temporarily unavailable because the local service could not be
        reached. No sample values are being shown.
      </div>
    );
  }
  if (error) {
    return (
      <div className="notice notice-warn">
        Couldn&apos;t update usage. Any displayed values are the last verified
        ones.
      </div>
    );
  }
  return null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
