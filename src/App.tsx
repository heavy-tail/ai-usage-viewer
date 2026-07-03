import { useCallback, useEffect, useMemo, useState } from "react";
import type { UsageProvider, UsageSnapshot } from "./types";
import { mockSnapshot } from "./mockData";
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

  // Poll the snapshot until an in-progress refresh finishes (collectors can
  // take 20-30s). Used both on mount and when a refresh returns 409.
  const pollUntilIdle = useCallback(async (signal?: AbortSignal) => {
    for (let i = 0; i < 60; i += 1) {
      await sleep(2_000);
      if (signal?.aborted) return;
      try {
        const poll = await getSnapshot(signal);
        if (signal?.aborted) return;
        setSnapshot(poll.snapshot);
        setConnection("live");
        if (!poll.refreshing) {
          return;
        }
      } catch {
        // A transient failure while the refresh lock is held is expected;
        // keep polling until it clears or we hit the attempt cap.
      }
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setRefreshing("all");
    setQueuedProviders([]);
    setError(null);
    try {
      const result = await apiRefreshAll();
      setSnapshot(result.snapshot);
      setConnection("live");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // The API server's in-process refresh lock is held by a concurrent
        // request (e.g. another browser tab) — wait it out. Note: `npm run
        // collect` runs in a separate process and does NOT share this lock, so
        // cross-process refreshes are last-writer-wins, not serialized.
        await pollUntilIdle();
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
        setSnapshot(mockSnapshot);
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
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          await pollUntilIdle();
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
            />
          ))}
        </div>
        {visibleProviders.length === 0 && connection === "live" && (
          <div className="notice">
            No logged-in CLI usage was detected on this machine yet.
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
        Showing <strong>mock data</strong> — couldn't reach the collector API
        {error ? ` (${error})` : ""}. Start it with <code>npm run api</code>.
      </div>
    );
  }
  if (error) {
    return <div className="notice notice-warn">Refresh failed: {error}</div>;
  }
  return null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
