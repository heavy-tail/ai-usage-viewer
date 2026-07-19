// Thin typed client for the local collector API (see src/server.ts).
// All endpoints return { snapshot, refreshing }; failures carry an error string.
import type { UsageProvider, UsageSnapshot } from "./types";
import { validateSnapshotShape } from "./snapshot";

const SNAPSHOT_TIMEOUT_MS = 10_000;
const REFRESH_TIMEOUT_MS = 90_000;

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

async function request(
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number
): Promise<SnapshotResponse> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(init?.signal?.reason);
  if (init?.signal?.aborted) forwardAbort();
  else init?.signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("Local usage request timed out.")),
    timeoutMs
  );

  let res: Response;
  let body: {
    snapshot?: UsageSnapshot;
    refreshing?: boolean;
    error?: string;
  };
  try {
    res = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: { accept: "application/json", ...init?.headers },
    });
    body = (await res.json().catch(() => ({}))) as typeof body;
  } finally {
    clearTimeout(timer);
    init?.signal?.removeEventListener("abort", forwardAbort);
  }

  if (!res.ok || !validateSnapshotShape(body.snapshot)) {
    const message =
      typeof body.error === "string"
        ? body.error
        : `Request to ${path} failed (${res.status}).`;
    throw new ApiError(message, res.status, Boolean(body.refreshing));
  }

  return { snapshot: body.snapshot, refreshing: Boolean(body.refreshing) };
}

export function getSnapshot(signal?: AbortSignal): Promise<SnapshotResponse> {
  return request("/api/snapshot", { signal }, SNAPSHOT_TIMEOUT_MS);
}

export function refreshAll(signal?: AbortSignal): Promise<SnapshotResponse> {
  return request(
    "/api/refresh",
    { method: "POST", signal },
    REFRESH_TIMEOUT_MS
  );
}

export function refreshProvider(
  provider: UsageProvider,
  signal?: AbortSignal
): Promise<SnapshotResponse> {
  return request(
    `/api/refresh/${provider}`,
    { method: "POST", signal },
    REFRESH_TIMEOUT_MS
  );
}
