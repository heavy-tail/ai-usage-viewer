import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { promisify } from "node:util";
import packageMetadata from "../../package.json";

const INITIALIZE_REQUEST_ID = 1;
const RATE_LIMITS_REQUEST_ID = 2;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_TERMINATION_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const execFileAsync = promisify(execFile);

type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
};

export type CodexAppServerResult = {
  payload: unknown;
  rawText: string;
};

export type CodexAppServerSpawn = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio & {
    stdio: ["pipe", "pipe", "pipe"];
  }
) => ChildProcessWithoutNullStreams;

export type CodexAppServerReader = (input: {
  cwd: string;
  timeoutMs?: number;
  spawnProcess?: CodexAppServerSpawn;
  platform?: NodeJS.Platform;
  windowsCommandShell?: string;
  maxOutputBytes?: number;
  terminationTimeoutMs?: number;
  terminateProcess?: CodexAppServerTerminate;
}) => Promise<CodexAppServerResult>;

export type CodexAppServerTerminate = (
  child: ChildProcessWithoutNullStreams,
  platform: NodeJS.Platform,
  timeoutMs: number
) => Promise<void>;

export class CodexAppServerError extends Error {
  readonly diagnosticText: string;

  constructor(message: string, diagnosticText = "") {
    super(message);
    this.name = "CodexAppServerError";
    this.diagnosticText = diagnosticText;
  }
}

/**
 * Reads Codex quota data through app-server's newline-delimited JSON-RPC
 * transport. Transport and unsupported-method failures are recoverable so
 * older Codex versions can fall back to the TUI collector; payload drift is
 * detected by the structured parser and must fail closed.
 */
export const readCodexAppServerRateLimits: CodexAppServerReader = async ({
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnProcess = defaultSpawn,
  platform = process.platform,
  windowsCommandShell = process.env.ComSpec ?? "cmd.exe",
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  terminationTimeoutMs = DEFAULT_TERMINATION_TIMEOUT_MS,
  terminateProcess = terminateAppServerProcess,
}) => {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new CodexAppServerError(
      "Codex app-server maxOutputBytes must be a positive integer."
    );
  }
  if (!Number.isSafeInteger(terminationTimeoutMs) || terminationTimeoutMs <= 0) {
    throw new CodexAppServerError(
      "Codex app-server terminationTimeoutMs must be a positive integer."
    );
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    const launch = appServerLaunch(platform, windowsCommandShell);
    child = spawnProcess(launch.command, launch.args, {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new CodexAppServerError(
      `Unable to start Codex app-server: ${errorMessage(error)}`
    );
  }

  return new Promise<CodexAppServerResult>((resolve, reject) => {
    let finishing = false;
    let stdoutBuffer = "";
    let stderrText = "";
    let transcriptText = "";
    let outputBytes = 0;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const timer = setTimeout(() => {
      fail(`Codex app-server timed out after ${timeoutMs}ms.`);
    }, timeoutMs);

    const diagnosticText = () =>
      [transcriptText.trim(), stderrText.trim()].filter(Boolean).join("\n");

    const finish = async (
      outcome: { payload: unknown } | { error: CodexAppServerError }
    ): Promise<void> => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      child.stdin.end();
      try {
        await terminateProcess(child, platform, terminationTimeoutMs);
      } catch {
        reject(
          new CodexAppServerError(
            "Codex app-server could not be fully terminated.",
            diagnosticText()
          )
        );
        return;
      }

      if ("error" in outcome) {
        reject(outcome.error);
      } else {
        resolve({
          payload: outcome.payload,
          rawText: JSON.stringify(outcome.payload, null, 2),
        });
      }
    };

    const succeed = (payload: unknown) => {
      if (finishing) return;
      void finish({ payload });
    };

    function fail(message: string): void {
      if (finishing) return;
      void finish({
        error: new CodexAppServerError(message, diagnosticText()),
      });
    }

    const send = (message: JsonRpcMessage) => {
      if (finishing) return;
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        fail(`Unable to write to Codex app-server: ${errorMessage(error)}`);
      }
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || finishing) return;
      transcriptText = boundedTail(
        `${transcriptText}${trimmed}\n`,
        MAX_DIAGNOSTIC_BYTES
      );

      let message: JsonRpcMessage;
      try {
        message = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        fail("Codex app-server returned malformed JSON.");
        return;
      }

      // Notifications and server-initiated requests share the same stream.
      // Only messages without a method are responses to this client's ids.
      if (message.method != null) return;

      if (message.id === INITIALIZE_REQUEST_ID) {
        if (message.error) {
          fail(jsonRpcError("initialize", message.error));
          return;
        }
        if (!("result" in message)) {
          fail("Codex app-server initialize response had no result.");
          return;
        }
        send({ method: "initialized", params: {} });
        send({ method: "account/rateLimits/read", id: RATE_LIMITS_REQUEST_ID });
        return;
      }

      if (message.id === RATE_LIMITS_REQUEST_ID) {
        if (message.error) {
          fail(jsonRpcError("account/rateLimits/read", message.error));
          return;
        }
        if (!("result" in message)) {
          fail("Codex app-server rate-limit response had no result.");
          return;
        }
        succeed(message.result);
      }
    };

    child.stdout.on("data", (chunk: string) => {
      if (!acceptOutput(chunk)) return;
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });
    child.stdout.on("end", () => {
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      stdoutBuffer = "";
    });
    child.stderr.on("data", (chunk: string) => {
      if (!acceptOutput(chunk)) return;
      stderrText = boundedTail(
        stderrText + chunk,
        MAX_DIAGNOSTIC_BYTES
      );
    });
    child.stdin.on("error", (error) => {
      fail(`Codex app-server stdin failed: ${errorMessage(error)}`);
    });
    child.once("error", (error) => {
      fail(`Codex app-server process failed: ${errorMessage(error)}`);
    });
    child.once("exit", (code, signal) => {
      if (finishing) return;
      const detail = signal ? `signal ${signal}` : `exit code ${String(code)}`;
      fail(`Codex app-server exited before returning rate limits (${detail}).`);
    });

    function acceptOutput(chunk: string): boolean {
      if (finishing) return false;
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes <= maxOutputBytes) return true;
      fail(`Codex app-server output exceeded ${maxOutputBytes} bytes.`);
      return false;
    }

    send({
      method: "initialize",
      id: INITIALIZE_REQUEST_ID,
      params: {
        clientInfo: {
          name: "usage_viewer",
          title: "AI Usage Viewer",
          version: packageMetadata.version,
        },
      },
    });
  });
};

async function terminateAppServerProcess(
  child: ChildProcessWithoutNullStreams,
  platform: NodeJS.Platform,
  timeoutMs: number
): Promise<void> {
  if (hasExited(child)) return;

  // Closing stdin gives a cooperative app-server a brief chance to stop.
  if (await waitForChildExit(child, Math.min(150, timeoutMs))) return;

  if (platform === "win32" && Number.isInteger(child.pid) && child.pid! > 0) {
    try {
      await execFileAsync(
        "taskkill.exe",
        ["/pid", String(child.pid), "/T", "/F"],
        { windowsHide: true, timeout: timeoutMs }
      );
    } catch {
      // The process can exit between inspection and taskkill. The verified
      // exit wait below decides whether a fallback signal is still required.
    }
    if (await waitForChildExit(child, timeoutMs)) return;
  }

  if (!hasExited(child)) child.kill("SIGKILL");
  if (!(await waitForChildExit(child, timeoutMs))) {
    throw new Error("Codex app-server did not exit after termination.");
  }
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode != null || child.signalCode != null;
}

function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const done = () => {
      clearTimeout(timer);
      child.off("exit", done);
      child.off("close", done);
      resolveExit(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", done);
      child.off("close", done);
      resolveExit(hasExited(child));
    }, timeoutMs);
    child.once("exit", done);
    child.once("close", done);
  });
}

function boundedTail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  return bytes.byteLength <= maxBytes
    ? text
    : bytes.subarray(-maxBytes).toString("utf8");
}

const defaultSpawn: CodexAppServerSpawn = (command, args, options) =>
  spawn(command, args, options);

function appServerLaunch(
  platform: NodeJS.Platform,
  windowsCommandShell: string
): { command: string; args: string[] } {
  if (platform === "win32") {
    // npm-installed CLIs are commonly .cmd shims, which Node cannot execute
    // directly on current Windows releases. The command text is fixed (no
    // user-controlled interpolation), while cwd remains a structured option.
    return {
      command: windowsCommandShell,
      args: ["/d", "/s", "/c", "codex app-server"],
    };
  }
  return { command: "codex", args: ["app-server"] };
}

function jsonRpcError(
  method: string,
  error: NonNullable<JsonRpcMessage["error"]>
): string {
  const code = error.code == null ? "" : ` (${error.code})`;
  return `Codex app-server ${method} failed${code}: ${
    error.message ?? "Unknown JSON-RPC error"
  }`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
