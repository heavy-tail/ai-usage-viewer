import { cleanTerminalOutput } from "../lib/terminal";
import {
  parseCodexAppServerRateLimits,
  parseCodexFooter,
  parseCodexLoginStatus,
} from "../parsers/codex";
import { isParserDriftError } from "../parsers/errors";
import {
  CollectorUnavailableError,
  PtyProcessError,
  PtyTimeoutError,
} from "./errors";
import { isCommandAvailable } from "./command";
import {
  CodexAppServerError,
  readCodexAppServerRateLimits,
  type CodexAppServerReader,
} from "./codexAppServer";
import { failedResult, okResult } from "./helpers";
import type { CollectorContext, ProviderCollectorResult } from "./types";

export async function collectCodex(
  context: CollectorContext,
  dependencies: {
    appServerReader?: CodexAppServerReader;
  } = {}
): Promise<ProviderCollectorResult> {
  const provider = "codex" as const;
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();
  const rawFileName = "codex-default.txt";
  let loginText = "";
  let meta = {
    checkedAt,
    sourceCommand: "codex --no-alt-screen, /status best-effort",
    planLabel: context.config.planLabelFallback.codex ?? "ChatGPT",
  };

  try {
    if (!context.config.codex.collectDefault) {
      throw new CollectorUnavailableError("Codex default collection is disabled.");
    }

    if (!(await isCommandAvailable("codex", context.rootDir, context.commandRunner))) {
      throw new CollectorUnavailableError("Codex CLI is not installed.");
    }

    try {
      const appServer = await (
        dependencies.appServerReader ?? readCodexAppServerRateLimits
      )({ cwd: context.rootDir });
      const appServerMeta = {
        ...meta,
        sourceCommand: "codex app-server -> account/rateLimits/read",
      };
      return okResult({
        provider,
        startedAt,
        checkedAt,
        limits: parseCodexAppServerRateLimits(appServer.payload, appServerMeta),
        rawText: appServer.rawText,
        cleanedText: appServer.rawText,
        rawFileName,
      });
    } catch (error) {
      // A successfully read but unrecognized structured payload is authoritative:
      // falling back could publish a smaller TUI subset and hide a new quota.
      if (isParserDriftError(error) || !(error instanceof CodexAppServerError)) {
        throw error;
      }
      // Older Codex builds, non-ChatGPT auth, unsupported methods, and startup
      // failures fall through to the proven terminal collector below.
    }

    loginText = await readCodexLoginStatus(context);
    const login = parseCodexLoginStatus(loginText);
    if (loginText && !login.loggedIn) {
      throw new CollectorUnavailableError(
        "Codex CLI is not logged in.",
        loginText,
        cleanTerminalOutput(loginText)
      );
    }

    meta = {
      ...meta,
      planLabel:
        login.planLabel ?? context.config.planLabelFallback.codex ?? "ChatGPT",
    };

    const pty = await context.ptyRunner({
      command: "codex",
      args: ["--no-alt-screen"],
      cwd: context.rootDir,
      totalTimeoutMs: 40_000,
      responders: [
        { when: /TERM|continue/i, send: "y\r", once: true },
        { when: /Update available[\s\S]*Skip/i, send: "2\r", once: true },
      ],
      steps: [
        {
          // Wait for the complete footer on a SINGLE line, matching the
          // parser's single-line requirement. A [\s\S]* pattern could match
          // while Context/5h/weekly were still scattered across redraw frames
          // (Codex renders slowly behind "Starting MCP servers…"), firing
          // /quit before a full footer line existed and producing spurious
          // drift. The trailing delayMs lets the frame settle first.
          waitFor:
            /Context\s+\d+(?:\.\d+)?%\s+left[^\n]*5h\s+\d+(?:\.\d+)?%\s+left[^\n]*weekly\s+\d+(?:\.\d+)?%\s+(?:left|l)/i,
          timeoutMs: 20_000,
          delayMs: 2_500,
        },
        { send: "/status", delayMs: 100 },
        { send: "\r" },
        {
          waitFor: /Weekly limit:[\s\S]*resets/i,
          timeoutMs: 12_000,
          delayMs: 800,
        },
        { send: "/quit", delayMs: 100 },
        { send: "\r\r", delayMs: 300 },
      ],
    });

    return okResult({
      provider,
      startedAt,
      checkedAt,
      limits: parseCodexFooter(pty.cleanedOutput, meta),
      rawText: [loginText, pty.rawOutput].filter(Boolean).join("\n"),
      cleanedText: [cleanTerminalOutput(loginText), pty.cleanedOutput]
        .filter(Boolean)
        .join("\n"),
      rawFileName,
    });
  } catch (error) {
    const partial = codexFooterFallback({
      error,
      loginText,
      meta,
      provider,
      startedAt,
      checkedAt,
      rawFileName,
    });
    if (partial) return partial;
    return failedResult({ provider, startedAt, checkedAt, rawFileName, error });
  }
}

async function readCodexLoginStatus(context: CollectorContext): Promise<string> {
  const result = await context.commandRunner("codex", ["login", "status"], {
    cwd: context.rootDir,
    timeoutMs: 5_000,
  });
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function codexFooterFallback(input: {
  error: unknown;
  loginText: string;
  meta: {
    checkedAt: string;
    sourceCommand: string;
    planLabel?: string;
  };
  provider: "codex";
  startedAt: number;
  checkedAt: string;
  rawFileName: string;
}): ProviderCollectorResult | undefined {
  if (
    !(input.error instanceof PtyTimeoutError) &&
    !(input.error instanceof PtyProcessError)
  ) {
    return undefined;
  }

  const rawText = [input.loginText, input.error.rawText].filter(Boolean).join("\n");
  const cleanedText = [cleanTerminalOutput(input.loginText), input.error.cleanedText]
    .filter(Boolean)
    .join("\n");

  try {
    return okResult({
      provider: input.provider,
      startedAt: input.startedAt,
      checkedAt: input.checkedAt,
      limits: parseCodexFooter(cleanedText, input.meta),
      rawText,
      cleanedText,
      rawFileName: input.rawFileName,
    });
  } catch {
    return undefined;
  }
}
