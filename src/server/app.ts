import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { UsageProvider } from "../types";
import { PROVIDER_ORDER } from "../lib/usage";
import { emptyUsageSnapshot } from "../lib/snapshotView";
import {
  RefreshInProgressError,
  refreshService,
  type RefreshService,
} from "../refresh";
import { readRawOutput, readSnapshot } from "../storage";
import { validateSnapshotShape } from "../snapshot";

export type UsageServerOptions = {
  rootDir: string;
  // Injectable so tests can drive the routes without running real collectors.
  refresh?: RefreshService;
};

export function createUsageServer(options: UsageServerOptions): Server {
  const { rootDir } = options;
  const refresh = options.refresh ?? refreshService;

  return createServer(async (req, res) => {
    try {
      await route(req, res, rootDir, refresh);
    } catch (error) {
      if (error instanceof RefreshInProgressError) {
        json(res, 409, { error: error.message, refreshing: true });
        return;
      }
      json(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  rootDir: string,
  refresh: RefreshService
): Promise<void> {
  if (!isLocalRequest(req)) {
    json(res, 403, { error: "Forbidden: request must originate from the local app." });
    return;
  }

  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");

  if (method === "GET" && url.pathname === "/api/snapshot") {
    const snapshot = (await readSnapshot(rootDir)) ?? emptyUsageSnapshot();
    if (!validateSnapshotShape(snapshot)) {
      json(res, 500, { error: "Stored snapshot has an invalid shape." });
      return;
    }
    json(res, 200, { snapshot, refreshing: refresh.isRunning() });
    return;
  }

  if (method === "POST" && url.pathname === "/api/refresh") {
    const snapshot = await refresh.refresh({ rootDir });
    json(res, 200, { snapshot, refreshing: false });
    return;
  }

  const providerRefresh = url.pathname.match(/^\/api\/refresh\/([^/]+)$/);
  if (method === "POST" && providerRefresh) {
    const provider = parseProvider(providerRefresh[1]);
    if (!provider) {
      json(res, 404, { error: "Unknown provider." });
      return;
    }
    const snapshot = await refresh.refresh({ rootDir, provider });
    json(res, 200, { snapshot, refreshing: false });
    return;
  }

  const rawRoute = url.pathname.match(/^\/api\/raw\/([^/]+)$/);
  if (method === "GET" && rawRoute) {
    const provider = parseProvider(rawRoute[1]);
    if (!provider) {
      json(res, 404, { error: "Unknown provider." });
      return;
    }
    const raw = await readRawOutput(rootDir, provider);
    if (raw == null) {
      json(res, 404, { error: "No raw output stored for provider." });
      return;
    }
    text(res, 200, raw);
    return;
  }

  json(res, 404, { error: "Not found." });
}

function parseProvider(value: string): UsageProvider | undefined {
  return PROVIDER_ORDER.find((provider) => provider === value);
}

// Loopback binding is not a trust boundary on its own: a malicious web page can
// still send requests to 127.0.0.1, and DNS rebinding can forge a non-loopback
// Host. Require a loopback Host and reject any cross-origin browser request
// before a route reads local data or triggers a refresh. Requests with no Origin
// (the local launch-refresh script, curl, tests) are allowed.
function isLocalRequest(req: IncomingMessage): boolean {
  if (!isLoopbackHost(req.headers.host)) return false;
  const origin = req.headers.origin;
  return origin === undefined || isLoopbackOrigin(origin);
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).host);
  } catch {
    return false;
  }
}

function json(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(`${JSON.stringify(body)}\n`);
}

function text(res: ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}
