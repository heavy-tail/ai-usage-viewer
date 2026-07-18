import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import packageMetadata from "../../package.json";

const INITIALIZE_REQUEST_ID = 1;
const RATE_LIMITS_REQUEST_ID = 2;
const DEFAULT_TIMEOUT_MS = 8_000;

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
}) => Promise<CodexAppServerResult>;

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
}) => {
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
    let settled = false;
    let stdoutBuffer = "";
    let stderrText = "";
    const transcript: string[] = [];

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const timer = setTimeout(() => {
      fail(`Codex app-server timed out after ${timeoutMs}ms.`);
    }, timeoutMs);

    const diagnosticText = () =>
      [...transcript, stderrText.trim()].filter(Boolean).join("\n");

    const stop = () => {
      clearTimeout(timer);
      child.stdin.end();
      if (child.exitCode == null && !child.killed) child.kill();
    };

    const succeed = (payload: unknown) => {
      if (settled) return;
      settled = true;
      stop();
      resolve({ payload, rawText: JSON.stringify(payload, null, 2) });
    };

    function fail(message: string): void {
      if (settled) return;
      settled = true;
      stop();
      reject(new CodexAppServerError(message, diagnosticText()));
    }

    const send = (message: JsonRpcMessage) => {
      if (settled) return;
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        fail(`Unable to write to Codex app-server: ${errorMessage(error)}`);
      }
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || settled) return;
      transcript.push(trimmed);

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
      stderrText += chunk;
    });
    child.stdin.on("error", (error) => {
      fail(`Codex app-server stdin failed: ${errorMessage(error)}`);
    });
    child.once("error", (error) => {
      fail(`Codex app-server process failed: ${errorMessage(error)}`);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      const detail = signal ? `signal ${signal}` : `exit code ${String(code)}`;
      fail(`Codex app-server exited before returning rate limits (${detail}).`);
    });

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
