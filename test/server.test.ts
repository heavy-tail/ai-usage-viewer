import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { request as httpRequest, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import {
  createUsageServer,
  USAGE_SERVER_IDENTITY_VERSION,
  USAGE_SERVER_SERVICE,
  type UsageServerIdentity,
} from "../src/server/app";
import { RefreshInProgressError, type RefreshService } from "../src/refresh";
import { tryAcquireRefreshLock } from "../src/refreshLock";
import type { UsageSnapshot } from "../src/types";

const validSnapshot: UsageSnapshot = {
  generatedAt: "2026-06-27T00:00:00.000Z",
  collectors: [
    {
      provider: "claude",
      ok: true,
      state: "ok",
      checkedAt: "2026-06-27T00:00:00.000Z",
      durationMs: 5,
    },
  ],
  limits: [],
};

const okRefresh: RefreshService = {
  refresh: async () => validSnapshot,
  isRunning: () => false,
};

async function workspace(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "usage-viewer-server-"));
  await mkdir(join(rootDir, "data", "raw"), { recursive: true });
  return rootDir;
}

async function withServer(
  opts: {
    rootDir: string;
    staticDir?: string;
    refresh?: RefreshService;
    identity?: UsageServerIdentity;
  },
  run: (base: string) => Promise<void>
): Promise<void> {
  const server: Server = createUsageServer(opts);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// Raw http client so tests can set Host/Origin headers that fetch() forbids.
function rawRequest(
  base: string,
  path: string,
  opts: { method?: string; headers?: Record<string, string> } = {}
): Promise<number> {
  const url = new URL(base + path);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: opts.method ?? "GET",
        headers: opts.headers,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("usage server routes", () => {
  it("GET /api/identity returns the launch-verification contract", async () => {
    const rootDir = await workspace();
    const identity: UsageServerIdentity = {
      service: USAGE_SERVER_SERVICE,
      version: USAGE_SERVER_IDENTITY_VERSION,
      sourceFingerprint: "a".repeat(64),
      pid: process.pid,
      processStartedAtUtc: "2026-06-27T00:00:00.000Z",
    };
    await withServer({ rootDir, refresh: okRefresh, identity }, async (base) => {
      const res = await fetch(`${base}/api/identity`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(identity);
      expect(res.headers.get("cache-control")).toBe("no-store");
    });
  });

  it("GET /api/identity is unavailable for intentionally API-only embeddings", async () => {
    const rootDir = await workspace();
    await withServer({ rootDir, refresh: okRefresh }, async (base) => {
      const res = await fetch(`${base}/api/identity`);
      expect(res.status).toBe(404);
    });
  });

  it("GET /api/snapshot returns the stored snapshot", async () => {
    const rootDir = await workspace();
    await writeFile(
      join(rootDir, "data", "usage-snapshot.json"),
      JSON.stringify(validSnapshot),
      "utf8"
    );
    await withServer({ rootDir, refresh: okRefresh }, async (base) => {
      const res = await fetch(`${base}/api/snapshot`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { snapshot: UsageSnapshot };
      expect(body.snapshot.generatedAt).toBe(validSnapshot.generatedAt);
    });
  });

  it("GET /api/snapshot reports a refresh held by another process", async () => {
    const rootDir = await workspace();
    const release = await tryAcquireRefreshLock(rootDir);
    expect(release).toBeTypeOf("function");
    try {
      await withServer({ rootDir, refresh: okRefresh }, async (base) => {
        const res = await fetch(`${base}/api/snapshot`);
        const body = (await res.json()) as { refreshing: boolean };
        expect(body.refreshing).toBe(true);
      });
    } finally {
      await release?.();
    }
  });

  it("GET /api/snapshot ignores a stale cross-process refresh lock", async () => {
    const rootDir = await workspace();
    await writeFile(
      join(rootDir, "data", "refresh.lock"),
      JSON.stringify({
        pid: 2_147_483_647,
        token: "stale-test",
        startedAt: "2026-06-27T00:00:00.000Z",
      }),
      "utf8"
    );
    await withServer({ rootDir, refresh: okRefresh }, async (base) => {
      const res = await fetch(`${base}/api/snapshot`);
      const body = (await res.json()) as { refreshing: boolean };
      expect(body.refreshing).toBe(false);
    });
  });

  it("GET /api/snapshot safely falls back when the stored shape is invalid", async () => {
    const rootDir = await workspace();
    await writeFile(
      join(rootDir, "data", "usage-snapshot.json"),
      JSON.stringify({ generatedAt: 123 }),
      "utf8"
    );
    await withServer({ rootDir, refresh: okRefresh }, async (base) => {
      const res = await fetch(`${base}/api/snapshot`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { snapshot: UsageSnapshot };
      expect(body.snapshot.collectors).toHaveLength(4);
      expect(body.snapshot.collectors.every((collector) => collector.state === "stale"))
        .toBe(true);
      expect(body.snapshot.limits).toEqual([]);
    });
  });

  it("returns 404 for an unknown provider", async () => {
    const rootDir = await workspace();
    await withServer({ rootDir, refresh: okRefresh }, async (base) => {
      const refresh = await fetch(`${base}/api/refresh/bogus`, { method: "POST" });
      expect(refresh.status).toBe(404);
      const raw = await fetch(`${base}/api/raw/bogus`);
      expect(raw.status).toBe(404);
    });
  });

  it("serves stored raw output and 404s when missing", async () => {
    const rootDir = await workspace();
    await writeFile(
      join(rootDir, "data", "raw", "claude.txt"),
      "hello raw",
      "utf8"
    );
    await withServer({ rootDir, refresh: okRefresh }, async (base) => {
      const present = await fetch(`${base}/api/raw/claude`);
      expect(present.status).toBe(200);
      expect(await present.text()).toContain("hello raw");

      const missing = await fetch(`${base}/api/raw/grok`);
      expect(missing.status).toBe(404);
    });
  });

  it("POST /api/refresh returns the new snapshot", async () => {
    const rootDir = await workspace();
    await withServer({ rootDir, refresh: okRefresh }, async (base) => {
      const res = await fetch(`${base}/api/refresh`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        snapshot: UsageSnapshot;
        refreshing: boolean;
      };
      expect(body.refreshing).toBe(false);
      expect(body.snapshot.generatedAt).toBe(validSnapshot.generatedAt);
    });
  });

  it("POST /api/refresh returns 409 when a refresh is already running", async () => {
    const rootDir = await workspace();
    const busy: RefreshService = {
      refresh: async () => {
        throw new RefreshInProgressError();
      },
      isRunning: () => true,
    };
    await withServer({ rootDir, refresh: busy }, async (base) => {
      const res = await fetch(`${base}/api/refresh`, { method: "POST" });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { refreshing: boolean };
      expect(body.refreshing).toBe(true);
    });
  });

  it("rejects a non-loopback Host header (DNS-rebinding guard)", async () => {
    const rootDir = await workspace();
    await withServer({ rootDir, refresh: okRefresh }, async (base) => {
      const status = await rawRequest(base, "/api/snapshot", {
        headers: { Host: "attacker.example" },
      });
      expect(status).toBe(403);
    });
  });

  it("rejects a cross-origin POST to refresh (CSRF guard)", async () => {
    const rootDir = await workspace();
    await withServer({ rootDir, refresh: okRefresh }, async (base) => {
      const status = await rawRequest(base, "/api/refresh", {
        method: "POST",
        headers: { Origin: "http://attacker.example" },
      });
      expect(status).toBe(403);
    });
  });

  it("allows requests from a loopback Origin", async () => {
    const rootDir = await workspace();
    await writeFile(
      join(rootDir, "data", "usage-snapshot.json"),
      JSON.stringify(validSnapshot),
      "utf8"
    );
    await withServer({ rootDir, refresh: okRefresh }, async (base) => {
      const status = await rawRequest(base, "/api/snapshot", {
        headers: { Origin: "http://localhost:5173" },
      });
      expect(status).toBe(200);
    });
  });

  it("serves the built dashboard and assets without changing API routing", async () => {
    const rootDir = await workspace();
    const staticDir = join(rootDir, "dist");
    await mkdir(join(staticDir, "assets"), { recursive: true });
    await writeFile(join(staticDir, "index.html"), '<main id="root">viewer</main>', "utf8");
    await writeFile(join(staticDir, "assets", "app.js"), "export {};", "utf8");

    await withServer({ rootDir, staticDir, refresh: okRefresh }, async (base) => {
      const dashboard = await fetch(`${base}/`);
      expect(dashboard.status).toBe(200);
      expect(dashboard.headers.get("content-type")).toContain("text/html");
      expect(dashboard.headers.get("cache-control")).toBe("no-cache");
      expect(await dashboard.text()).toContain('id="root"');

      const asset = await fetch(`${base}/assets/app.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("text/javascript");
      expect(asset.headers.get("cache-control")).toContain("immutable");

      const api = await fetch(`${base}/api/snapshot`);
      expect(api.status).toBe(200);
      expect(api.headers.get("content-type")).toContain("application/json");

      const unknownApi = await fetch(`${base}/api/not-a-route`);
      expect(unknownApi.status).toBe(404);
      expect(unknownApi.headers.get("content-type")).toContain("application/json");
    });
  });

  it("supports HEAD requests and does not expose files outside dist", async () => {
    const rootDir = await workspace();
    const staticDir = join(rootDir, "dist");
    await mkdir(staticDir, { recursive: true });
    await writeFile(join(staticDir, "index.html"), "dashboard", "utf8");
    await writeFile(join(rootDir, "private.txt"), "do not serve", "utf8");

    await withServer({ rootDir, staticDir, refresh: okRefresh }, async (base) => {
      const head = await fetch(`${base}/`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String("dashboard".length));
      expect(await head.text()).toBe("");

      const missing = await fetch(`${base}/private.txt`);
      expect(missing.status).toBe(404);

      const encodedTraversal = await fetch(`${base}/%2e%2e%5cprivate.txt`);
      expect([403, 404]).toContain(encodedTraversal.status);
      expect(await encodedTraversal.text()).not.toContain("do not serve");
    });
  });
});
