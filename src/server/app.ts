import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { PROVIDER_ORDER } from "../lib/usage";
import { emptyUsageSnapshot } from "../lib/snapshotView";
import {
  RefreshInProgressError,
  refreshService,
  type RefreshService,
} from "../refresh";
import { isRefreshLockHeld } from "../refreshLock";
import { readRawOutput, readSnapshot } from "../storage";
import { validateSnapshotShape } from "../snapshot";
import type { UsageProvider } from "../types";

export type UsageServerOptions = {
  rootDir: string;
  // The production entry passes the Vite build directory. Tests and custom
  // API-only embeddings can leave it unset.
  staticDir?: string;
  // Injectable so tests can drive the routes without running real collectors.
  refresh?: RefreshService;
  // The desktop launcher supplies this identity and uses it to distinguish a
  // managed viewer from an unrelated process that happens to own the port.
  identity?: UsageServerIdentity;
};

export const USAGE_SERVER_SERVICE = "ai-usage-viewer";
export const USAGE_SERVER_IDENTITY_VERSION = 1;

export type UsageServerIdentity = {
  service: typeof USAGE_SERVER_SERVICE;
  version: typeof USAGE_SERVER_IDENTITY_VERSION;
  sourceFingerprint: string | null;
  pid: number;
  processStartedAtUtc: string;
};

export function createUsageServer(options: UsageServerOptions): Server {
  const { rootDir, staticDir, identity } = options;
  const refresh = options.refresh ?? refreshService;

  return createServer(async (req, res) => {
    try {
      await route(req, res, rootDir, refresh, staticDir, identity);
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
  refresh: RefreshService,
  staticDir: string | undefined,
  identity: UsageServerIdentity | undefined
): Promise<void> {
  if (!isLocalRequest(req)) {
    json(res, 403, { error: "Forbidden: request must originate from the local app." });
    return;
  }

  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");

  if (method === "GET" && url.pathname === "/api/identity") {
    if (!identity) {
      json(res, 404, { error: "Server identity is not configured." });
      return;
    }
    json(res, 200, identity);
    return;
  }

  if (method === "GET" && url.pathname === "/api/snapshot") {
    const snapshot = (await readSnapshot(rootDir)) ?? emptyUsageSnapshot();
    if (!validateSnapshotShape(snapshot)) {
      json(res, 500, { error: "Stored snapshot has an invalid shape." });
      return;
    }
    json(res, 200, {
      snapshot,
      refreshing: refresh.isRunning() || (await isRefreshLockHeld(rootDir)),
    });
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

  if (
    staticDir &&
    (method === "GET" || method === "HEAD") &&
    !isApiPath(url.pathname) &&
    (await serveStatic(res, method, staticDir, url.pathname))
  ) {
    return;
  }

  json(res, 404, { error: "Not found." });
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

async function serveStatic(
  res: ServerResponse,
  method: string,
  staticDir: string,
  pathname: string
): Promise<boolean> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    text(res, 400, "Bad request.\n");
    return true;
  }

  if (decodedPath.includes("\0")) {
    text(res, 400, "Bad request.\n");
    return true;
  }

  const base = resolve(staticDir);
  const requested = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const filePath = resolve(base, requested);
  const relativePath = relative(base, filePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    text(res, 403, "Forbidden.\n");
    return true;
  }

  let body: Buffer;
  try {
    body = await readFile(filePath);
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }

  const extension = extname(filePath).toLowerCase();
  const headers: Record<string, string | number> = {
    "content-type": contentType(extension),
    "content-length": body.byteLength,
    "cache-control": cacheControl(relativePath, extension),
    "x-content-type-options": "nosniff",
  };
  res.writeHead(200, headers);
  res.end(method === "HEAD" ? undefined : body);
  return true;
}

function isMissingFile(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return ["ENOENT", "ENOTDIR", "EISDIR"].includes(String(error.code));
}

function contentType(extension: string): string {
  const types: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };
  return types[extension] ?? "application/octet-stream";
}

function cacheControl(relativePath: string, extension: string): string {
  if (extension === ".html") return "no-cache";
  if (relativePath.split(/[\\/]/)[0] === "assets") {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
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
