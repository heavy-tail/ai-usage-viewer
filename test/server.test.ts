import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { request as httpRequest, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { createUsageServer } from "../src/server/app";
import { RefreshInProgressError, type RefreshService } from "../src/refresh";
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
  opts: { rootDir: string; refresh?: RefreshService },
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

  it("GET /api/snapshot returns 500 for an invalid stored shape", async () => {
    const rootDir = await workspace();
    await writeFile(
      join(rootDir, "data", "usage-snapshot.json"),
      JSON.stringify({ generatedAt: 123 }),
      "utf8"
    );
    await withServer({ rootDir, refresh: okRefresh }, async (base) => {
      const res = await fetch(`${base}/api/snapshot`);
      expect(res.status).toBe(500);
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
});
