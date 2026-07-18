import { afterEach, describe, expect, it, vi } from "vitest";
import { startCompatibilityMonitor } from "../src/server/compatibilityMonitor";
import type { RefreshService } from "../src/refresh";
import type { UsageSnapshot } from "../src/types";

afterEach(() => vi.useRealTimers());

describe("background compatibility monitor", () => {
  it("runs silently on schedule and stops cleanly", async () => {
    vi.useFakeTimers();
    const refresh = service();
    const monitor = startCompatibilityMonitor({
      rootDir: "C:\\viewer",
      refresh,
      intervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(2_500);
    expect(refresh.refresh).toHaveBeenCalledTimes(2);
    expect(refresh.refresh).toHaveBeenCalledWith({ rootDir: "C:\\viewer" });

    monitor.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(refresh.refresh).toHaveBeenCalledTimes(2);
  });

  it("does not overlap a user-initiated refresh", async () => {
    vi.useFakeTimers();
    const refresh = service(true);
    startCompatibilityMonitor({
      rootDir: "C:\\viewer",
      refresh,
      intervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh.refresh).not.toHaveBeenCalled();
  });
});

function service(running = false): RefreshService {
  return {
    refresh: vi.fn(async () => snapshot()),
    isRunning: () => running,
  };
}

function snapshot(): UsageSnapshot {
  return {
    generatedAt: "2026-07-18T00:00:00.000Z",
    collectors: [],
    limits: [],
  };
}
