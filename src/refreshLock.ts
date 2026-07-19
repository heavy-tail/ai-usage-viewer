import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer, connect, type Server } from "node:net";
import { join } from "node:path";

const LOCK_FILE = join("data", "refresh.lock");
const PIPE_PROBE_TIMEOUT_MS = 1_000;

type LockRecord = {
  pid: number;
  token: string;
  startedAt: string;
};

export type ReleaseRefreshLock = () => Promise<void>;

/**
 * Reports whether the OS-owned workspace mutex is live. The JSON file is only
 * diagnostic metadata; it is deliberately not the source of truth because a
 * pathname cannot provide compare-and-delete semantics during stale cleanup.
 */
export async function isRefreshLockHeld(rootDir: string): Promise<boolean> {
  return canConnect(await lockPipeName(rootDir));
}

/**
 * Acquire a workspace-wide refresh mutex using a Windows named pipe. Named
 * pipe ownership is atomic, disappears automatically when its process exits,
 * and cannot suffer the stale-file read/unlink race of a lock-file protocol.
 * A small JSON record remains on disk only for local diagnostics.
 */
export async function tryAcquireRefreshLock(
  rootDir: string
): Promise<ReleaseRefreshLock | undefined> {
  const lockPath = join(rootDir, LOCK_FILE);
  await mkdir(join(rootDir, "data"), { recursive: true });

  const server = createServer((socket) => socket.end());
  server.unref();
  try {
    await listen(server, await lockPipeName(rootDir));
  } catch (error) {
    if (hasCode(error, "EADDRINUSE")) return undefined;
    throw error;
  }

  const record: LockRecord = {
    pid: process.pid,
    token: randomUUID(),
    startedAt: new Date().toISOString(),
  };

  try {
    await writeDiagnosticRecord(lockPath, record);
  } catch (error) {
    await closeServer(server);
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await releaseOwnedRecord(lockPath, record.token);
    } finally {
      await closeServer(server);
    }
  };
}

async function lockPipeName(rootDir: string): Promise<string> {
  // Hash the filesystem's canonical path, not a lexical spelling. Junctions,
  // symlinks, and 8.3 aliases must all compete for the same workspace lock.
  const workspace = (await realpath(rootDir)).toLowerCase();
  const digest = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
  // This application and its PTY collectors are Windows-only. A named pipe is
  // kernel-owned, so crashes cannot leave a stale mutex behind.
  return `\\\\.\\pipe\\ai-usage-viewer-refresh-${digest}`;
}

function listen(server: Server, pipeName: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(pipeName);
  });
}

function canConnect(pipeName: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = connect(pipeName);
    let settled = false;
    const finish = (held: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(held);
    };
    const timer = setTimeout(() => finish(true), PIPE_PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => {
      finish(!hasCode(error, "ENOENT") && !hasCode(error, "ECONNREFUSED"));
    });
  });
}

async function writeDiagnosticRecord(
  lockPath: string,
  record: LockRecord
): Promise<void> {
  const temporary = `${lockPath}.${record.token}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), "utf8");
    await unlink(lockPath).catch((error: unknown) => {
      if (!hasCode(error, "ENOENT")) throw error;
    });
    await rename(temporary, lockPath);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!hasCode(error, "ENOENT")) throw error;
    });
  }
}

async function releaseOwnedRecord(
  lockPath: string,
  token: string
): Promise<void> {
  try {
    const current = JSON.parse(await readFile(lockPath, "utf8")) as LockRecord;
    if (current.token === token) await unlink(lockPath);
  } catch (error) {
    if (!hasCode(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
