// Thin typed client for the local collector API (see src/server.ts).
// All endpoints return { snapshot, refreshing }; failures carry an error string.
import type { UsageProvider, UsageSnapshot } from "./types";

export type SnapshotResponse = {
  snapshot: UsageSnapshot;
  refreshing: boolean;
};

export class ApiError extends Error {
  readonly status: number;
  readonly refreshing: boolean;

  constructor(message: string, status: number, refreshing: boolean) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.refreshing = refreshing;
  }
}

async function request(path: string, init?: RequestInit): Promise<SnapshotResponse> {
  const res = await fetch(path, {
    ...init,
    headers: { accept: "application/json", ...init?.headers },
  });

  const body = (await res.json().catch(() => ({}))) as {
    snapshot?: UsageSnapshot;
    refreshing?: boolean;
    error?: string;
  };

  if (!res.ok || !body.snapshot) {
    const message =
      typeof body.error === "string"
        ? body.error
        : `Request to ${path} failed (${res.status}).`;
    throw new ApiError(message, res.status, Boolean(body.refreshing));
  }

  return { snapshot: body.snapshot, refreshing: Boolean(body.refreshing) };
}

export function getSnapshot(signal?: AbortSignal): Promise<SnapshotResponse> {
  return request("/api/snapshot", { signal });
}

export function refreshAll(signal?: AbortSignal): Promise<SnapshotResponse> {
  return request("/api/refresh", { method: "POST", signal });
}

export function refreshProvider(
  provider: UsageProvider,
  signal?: AbortSignal
): Promise<SnapshotResponse> {
  return request(`/api/refresh/${provider}`, { method: "POST", signal });
}
