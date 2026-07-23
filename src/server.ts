import { resolve } from "node:path";
import { refreshService } from "./refresh";
import {
  createUsageServer,
  USAGE_SERVER_IDENTITY_VERSION,
  USAGE_SERVER_SERVICE,
} from "./server/app";
import {
  DEFAULT_COMPATIBILITY_INTERVAL_MS,
  startCompatibilityMonitor,
} from "./server/compatibilityMonitor";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 4317);
const rootDir = resolve(process.cwd());
const processStartedAtUtc = new Date(
  Date.now() - process.uptime() * 1_000
).toISOString();

const server = createUsageServer({
  rootDir,
  staticDir: resolve(rootDir, "dist"),
  identity: {
    service: USAGE_SERVER_SERVICE,
    version: USAGE_SERVER_IDENTITY_VERSION,
    sourceFingerprint: sourceFingerprint(
      process.env.USAGE_VIEWER_SOURCE_FINGERPRINT
    ),
    pid: process.pid,
    processStartedAtUtc,
  },
});
const monitor = startCompatibilityMonitor({
  rootDir,
  refresh: refreshService,
  intervalMs: compatibilityIntervalMs(
    process.env.COMPATIBILITY_CHECK_INTERVAL_MINUTES
  ),
  onError: (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Background compatibility check failed: ${message}`);
  },
});
server.once("close", monitor.stop);
server.listen(PORT, HOST, () => {
  console.log(`AI Usage Viewer listening on http://${HOST}:${PORT}`);
});

function compatibilityIntervalMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_COMPATIBILITY_INTERVAL_MS;
  }
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(
      "COMPATIBILITY_CHECK_INTERVAL_MINUTES must be a positive number."
    );
  }
  return minutes * 60_000;
}

function sourceFingerprint(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(
      "USAGE_VIEWER_SOURCE_FINGERPRINT must be a 64-character SHA-256 digest."
    );
  }
  return normalized;
}
