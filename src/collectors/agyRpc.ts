import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export const AGY_QUOTA_RPC_PATH =
  "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_LOG_BYTES = 1024 * 1024;
const MAX_DISCOVERY_BYTES = 64 * 1024;
const AGY_JOB_HOST_PATH = fileURLToPath(
  new URL("../../.runtime/agy-job-host.exe", import.meta.url)
);

export type AgyRpcResult = {
  payload: unknown;
};

export type AgyRpcOptions = {
  command?: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  shutdownTimeoutMs?: number;
  maxResponseBytes?: number;
  maxLogBytes?: number;
  tempDir?: string;
};

export class AgyRpcError extends Error {
  readonly code:
    | "configuration"
    | "launch"
    | "process"
    | "timeout"
    | "response"
    | "cleanup";

  constructor(message: string, code: AgyRpcError["code"]) {
    super(message);
    this.name = "AgyRpcError";
    this.code = code;
  }
}

type LoopbackEndpoint = {
  host: "127.0.0.1" | "::1";
  port: number;
};

type CandidateState = LoopbackEndpoint & {
  nextAttemptAt: number;
  terminalStatus?: number;
};

type ProcessState = {
  exited: boolean;
  failedToLaunch: boolean;
  exitPromise: Promise<void>;
};

class RetryableRpcError extends Error {}

/**
 * Starts AGY as a hidden local service and reads its structured quota summary
 * over the CLI's loopback Connect endpoint. Child output is used only to find
 * the bound port; it is deliberately never attached to thrown errors.
 */
export async function readAgyQuotaRpc(
  options: AgyRpcOptions = {}
): Promise<AgyRpcResult> {
  const settings = normalizeOptions(options);
  const logPath = join(
    settings.tempDir,
    `usage-viewer-agy-${process.pid}-${randomUUID()}.log`
  );

  let child: ChildProcessWithoutNullStreams | undefined;
  let state: ProcessState | undefined;
  let operationResult: AgyRpcResult | undefined;
  let operationError: unknown;

  try {
    const privateLog = await open(logPath, "wx", 0o600);
    await privateLog.close();
    const launch = launchSpec(settings, logPath);
    child = spawn(
      launch.command,
      launch.args,
      {
        cwd: settings.cwd,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        // A separate process group lets Unix tear down the exact descendant
        // tree. Windows uses taskkill /T against the exact PID below.
        detached: process.platform !== "win32",
      }
    );
    state = observeProcess(child);

    // On Windows, the job host closes AGY's own stdin immediately while this
    // pipe remains open as a parent-liveness lease. Closing the lease during
    // cleanup (or an unexpected Node exit) tears down the whole Job Object.
    // On other platforms this is AGY's own stdin and is closed immediately.
    child.stdin.on("error", () => undefined);
    if (launch.closeStdinAfterSpawn) child.stdin.end();

    operationResult = await queryQuota(child, state, logPath, settings);
  } catch (error) {
    operationError = sanitizeOperationError(error);
  }

  const cleanupError = await cleanup(child, state, logPath, settings);
  if (cleanupError !== undefined) throw cleanupError;
  if (operationError !== undefined) throw operationError;
  if (!operationResult) {
    throw new AgyRpcError("AGY quota RPC returned no result.", "response");
  }
  return operationResult;
}

function launchSpec(
  settings: NormalizedOptions,
  logPath: string
): { command: string; args: string[]; closeStdinAfterSpawn: boolean } {
  const agyArgs = [...settings.args, "--log-file", logPath];
  if (process.platform !== "win32") {
    return {
      command: settings.command,
      args: agyArgs,
      closeStdinAfterSpawn: true,
    };
  }
  if (!isAbsolute(settings.command)) {
    throw new AgyRpcError(
      "AGY command must be an absolute path on Windows.",
      "configuration"
    );
  }
  return {
    command: AGY_JOB_HOST_PATH,
    args: [settings.command, settings.cwd, ...agyArgs],
    closeStdinAfterSpawn: false,
  };
}

type NormalizedOptions = Required<
  Pick<
    AgyRpcOptions,
    | "command"
    | "args"
    | "cwd"
    | "timeoutMs"
    | "requestTimeoutMs"
    | "pollIntervalMs"
    | "shutdownTimeoutMs"
    | "maxResponseBytes"
    | "maxLogBytes"
    | "tempDir"
  >
>;

function normalizeOptions(options: AgyRpcOptions): NormalizedOptions {
  const settings: NormalizedOptions = {
    command: options.command ?? "agy",
    args: [...(options.args ?? [])],
    cwd: options.cwd ?? process.cwd(),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    requestTimeoutMs:
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    shutdownTimeoutMs:
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    maxResponseBytes:
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    maxLogBytes: options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES,
    tempDir: options.tempDir ?? tmpdir(),
  };

  if (!settings.command.trim()) {
    throw new AgyRpcError("AGY command must not be empty.", "configuration");
  }
  if (
    settings.args.some(
      (argument) =>
        argument === "--log-file" || argument.startsWith("--log-file=")
    )
  ) {
    throw new AgyRpcError(
      "AGY arguments must not override the private log file.",
      "configuration"
    );
  }
  assertPositiveInteger(settings.timeoutMs, "timeoutMs");
  assertPositiveInteger(settings.requestTimeoutMs, "requestTimeoutMs");
  assertPositiveInteger(settings.pollIntervalMs, "pollIntervalMs");
  assertPositiveInteger(settings.shutdownTimeoutMs, "shutdownTimeoutMs");
  assertPositiveInteger(settings.maxResponseBytes, "maxResponseBytes");
  assertPositiveInteger(settings.maxLogBytes, "maxLogBytes");
  return settings;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AgyRpcError(
      `AGY ${label} must be a positive integer.`,
      "configuration"
    );
  }
}

function observeProcess(child: ChildProcessWithoutNullStreams): ProcessState {
  let resolveExit: () => void = () => undefined;
  const state: ProcessState = {
    exited: false,
    failedToLaunch: false,
    exitPromise: new Promise<void>((resolve) => {
      resolveExit = resolve;
    }),
  };

  child.once("error", () => {
    state.failedToLaunch = true;
    state.exited = true;
    resolveExit();
  });
  child.once("exit", () => {
    state.exited = true;
    resolveExit();
  });
  return state;
}

async function queryQuota(
  child: ChildProcessWithoutNullStreams,
  state: ProcessState,
  logPath: string,
  settings: NormalizedOptions
): Promise<AgyRpcResult> {
  let processOutput = "";
  const candidates = new Map<string, CandidateState>();
  let sawExitedProcess = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const appendOutput = (chunk: string) => {
    processOutput = boundedTail(processOutput + chunk, MAX_DISCOVERY_BYTES);
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);

  const deadline = Date.now() + settings.timeoutMs;
  while (Date.now() < deadline) {
    if (state.failedToLaunch) {
      throw new AgyRpcError("Unable to start AGY quota service.", "launch");
    }

    addCandidates(candidates, processOutput);
    addCandidates(
      candidates,
      await readLogSample(logPath, settings.maxLogBytes)
    );

    for (const candidate of candidates.values()) {
      if (candidate.terminalStatus !== undefined) continue;
      if (candidate.nextAttemptAt > Date.now()) continue;

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      try {
        return await requestQuota(candidate, {
          timeoutMs: Math.min(settings.requestTimeoutMs, remainingMs),
          maxResponseBytes: settings.maxResponseBytes,
        });
      } catch (error) {
        if (error instanceof RetryableRpcError) {
          candidate.nextAttemptAt = Date.now() + settings.pollIntervalMs;
          continue;
        }
        if (error instanceof HttpStatusError) {
          candidate.terminalStatus = error.status;
          continue;
        }
        throw error;
      }
    }

    const terminalCandidates = [...candidates.values()].filter(
      (candidate) => candidate.terminalStatus !== undefined
    );
    if (
      terminalCandidates.length > 0 &&
      terminalCandidates.length === candidates.size
    ) {
      throw new AgyRpcError(
        `AGY quota RPC rejected the request (HTTP ${terminalCandidates[0]?.terminalStatus}).`,
        "response"
      );
    }

    // Give the final buffered/logged port one pass after process exit. If no
    // endpoint survived, waiting longer cannot produce new trusted discovery.
    if (state.exited) {
      if (sawExitedProcess) break;
      sawExitedProcess = true;
    }
    await delay(
      Math.min(settings.pollIntervalMs, Math.max(1, deadline - Date.now()))
    );
  }

  const rejected = [...candidates.values()].find(
    (candidate) => candidate.terminalStatus !== undefined
  );
  if (rejected?.terminalStatus !== undefined) {
    throw new AgyRpcError(
      `AGY quota RPC rejected the request (HTTP ${rejected.terminalStatus}).`,
      "response"
    );
  }
  if (state.exited) {
    throw new AgyRpcError(
      "AGY exited before its quota service became available.",
      "process"
    );
  }
  throw new AgyRpcError(
    `AGY quota RPC timed out after ${settings.timeoutMs}ms.`,
    "timeout"
  );
}

function addCandidates(
  candidates: Map<string, CandidateState>,
  text: string
): void {
  for (const endpoint of findLoopbackEndpoints(text)) {
    const key = endpointKey(endpoint);
    if (!candidates.has(key)) {
      candidates.set(key, { ...endpoint, nextAttemptAt: 0 });
    }
  }
}

function findLoopbackEndpoints(text: string): LoopbackEndpoint[] {
  const endpoints = new Map<string, LoopbackEndpoint>();
  const add = (hostText: string, portText: string) => {
    const host = hostText === "[::1]" ? "::1" : "127.0.0.1";
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return;
    const endpoint = { host, port } as LoopbackEndpoint;
    endpoints.set(endpointKey(endpoint), endpoint);
  };

  // Current AGY builds write two adjacent announcements, one for HTTPS and one
  // for HTTP. The Connect handler is on the latter. Keep the whole message and
  // line ending anchored so an HTTPS port or unrelated number cannot win.
  const agyHttpPattern =
    /^(?:[IWEF]\d{4} \d{2}:\d{2}:\d{2}\.\d{6} \d+ server\.go:\d+\] )?[ \t]*Language server listening on random port at (\d{1,5}) for HTTP[ \t]*\r?$/gm;
  let match: RegExpExecArray | null;
  while ((match = agyHttpPattern.exec(text)) !== null) {
    if (match[1]) add("127.0.0.1", match[1]);
  }

  return [...endpoints.values()];
}

function endpointKey(endpoint: LoopbackEndpoint): string {
  return `${endpoint.host}:${endpoint.port}`;
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super("AGY quota RPC returned a non-transient HTTP status.");
  }
}

async function requestQuota(
  endpoint: LoopbackEndpoint,
  options: { timeoutMs: number; maxResponseBytes: number }
): Promise<AgyRpcResult> {
  const host = endpoint.host === "::1" ? "[::1]" : endpoint.host;
  const url = `http://${host}:${endpoint.port}${AGY_QUOTA_RPC_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "connect-protocol-version": "1",
        "content-type": "application/json",
      },
      body: "{}",
      redirect: "error",
      signal: controller.signal,
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (isTransientStatus(response.status)) throw new RetryableRpcError();
      throw new HttpStatusError(response.status);
    }

    const mediaType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (
      mediaType !== "application/json" &&
      !(mediaType?.startsWith("application/") && mediaType.endsWith("+json"))
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new AgyRpcError(
        "AGY quota RPC returned a non-JSON response.",
        "response"
      );
    }

    const rawText = await readBoundedBody(
      response,
      options.maxResponseBytes,
      controller.signal
    );
    if (controller.signal.aborted) throw new RetryableRpcError();
    try {
      return { payload: JSON.parse(rawText) as unknown };
    } catch {
      throw new AgyRpcError(
        "AGY quota RPC returned malformed JSON.",
        "response"
      );
    }
  } catch (error) {
    if (
      error instanceof AgyRpcError ||
      error instanceof HttpStatusError ||
      error instanceof RetryableRpcError
    ) {
      throw error;
    }
    // Network failures and an AbortController firing during either headers or
    // body consumption are transient until the outer bounded deadline.
    throw new RetryableRpcError();
  } finally {
    clearTimeout(timer);
  }
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function readBoundedBody(
  response: Response,
  maxResponseBytes: number,
  signal?: AbortSignal
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxResponseBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw responseTooLarge(maxResponseBytes);
    }
  }
  if (!response.body) {
    throw new AgyRpcError("AGY quota RPC returned an empty body.", "response");
  }

  const reader = response.body.getReader();
  // Node's fetch aborts the request, but an already-open body reader has not
  // always settled promptly under concurrent Windows test/process load. Tie
  // cancellation directly to the reader so the per-request deadline remains
  // authoritative after response headers arrive.
  const cancelForAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal?.aborted) cancelForAbort();
  else signal?.addEventListener("abort", cancelForAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw responseTooLarge(maxResponseBytes);
      }
      chunks.push(part.value);
    }
    if (signal?.aborted) throw new RetryableRpcError();
  } finally {
    signal?.removeEventListener("abort", cancelForAbort);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function responseTooLarge(maxResponseBytes: number): AgyRpcError {
  return new AgyRpcError(
    `AGY quota RPC response exceeded ${maxResponseBytes} bytes.`,
    "response"
  );
}

async function readLogSample(
  path: string,
  maxLogBytes: number
): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const stat = await handle.stat();
    if (stat.size > maxLogBytes) {
      throw new AgyRpcError(
        `AGY private log exceeded ${maxLogBytes} bytes.`,
        "response"
      );
    }
    if (stat.size <= 0) return "";

    const firstSize = Math.min(stat.size, MAX_DISCOVERY_BYTES / 2);
    const lastSize = Math.min(
      Math.max(0, stat.size - firstSize),
      MAX_DISCOVERY_BYTES - firstSize
    );
    const first = Buffer.alloc(firstSize);
    const last = Buffer.alloc(lastSize);
    const firstRead = await handle.read(first, 0, first.length, 0);
    const lastRead =
      last.length > 0
        ? await handle.read(last, 0, last.length, stat.size - last.length)
        : { bytesRead: 0 };
    return Buffer.concat([
      first.subarray(0, firstRead.bytesRead),
      Buffer.from("\n"),
      last.subarray(0, lastRead.bytesRead),
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof AgyRpcError) throw error;
    if (isNodeError(error) && error.code === "ENOENT") return "";
    // Log readability must not expose paths or log contents. Treat a temporary
    // sharing/read race as an unavailable sample and continue polling streams.
    return "";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function cleanup(
  child: ChildProcessWithoutNullStreams | undefined,
  state: ProcessState | undefined,
  logPath: string,
  settings: NormalizedOptions
): Promise<AgyRpcError | undefined> {
  let cleanupFailed = false;
  try {
    if (child && state) {
      await terminateProcessTree(child, state, settings.shutdownTimeoutMs);
    }
  } catch {
    cleanupFailed = true;
  } finally {
    child?.stdin.destroy();
    child?.stdout.destroy();
    child?.stderr.destroy();
  }

  try {
    await removePrivateLog(logPath, settings.pollIntervalMs);
  } catch {
    cleanupFailed = true;
  }
  return cleanupFailed
    ? new AgyRpcError("Unable to fully clean up AGY quota service.", "cleanup")
    : undefined;
}

async function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  state: ProcessState,
  timeoutMs: number
): Promise<void> {
  if (process.platform === "win32") {
    // The child here is the scoped Job Object host, not AGY. Its stdin is a
    // liveness lease; EOF terminates the job. If the host has already exited,
    // Windows has already closed its sole job handle and killed descendants.
    if (state.exited) return;
    child.stdin.end();
    if (await waitForExit(state, timeoutMs)) return;

    // Killing the host closes the sole job handle in the kernel, so this still
    // tears down AGY and every non-breakaway descendant without a numeric-PID
    // tree walk or PID-reuse race.
    child.kill("SIGKILL");
    if (await waitForExit(state, timeoutMs)) return;
    throw new Error("AGY Job Object host did not exit.");
  }

  if (child.pid === undefined) {
    if (await waitForExit(state, timeoutMs)) return;
    throw new Error("AGY process did not expose a process group.");
  }
  signalProcessGroup(child.pid, "SIGTERM");
  if (await waitForProcessGroupExit(child.pid, timeoutMs)) return;
  signalProcessGroup(child.pid, "SIGKILL");
  if (!(await waitForProcessGroupExit(child.pid, timeoutMs))) {
    throw new Error("AGY process group did not exit.");
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(
  pid: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(pid)) return true;
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  return !isProcessGroupAlive(pid);
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") return false;
    return true;
  }
}

async function waitForExit(
  state: ProcessState,
  timeoutMs: number
): Promise<boolean> {
  if (state.exited) return true;
  await Promise.race([state.exitPromise, delay(timeoutMs)]);
  return state.exited;
}

async function removePrivateLog(path: string, retryDelayMs: number): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(path, { force: true });
      return;
    } catch (error) {
      lastError = error;
      await delay(retryDelayMs);
    }
  }
  throw lastError;
}

function sanitizeOperationError(error: unknown): AgyRpcError {
  if (error instanceof AgyRpcError) return error;
  return new AgyRpcError("AGY quota RPC failed.", "process");
}

function boundedTail(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return Buffer.from(text, "utf8").subarray(-maxBytes).toString("utf8");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
