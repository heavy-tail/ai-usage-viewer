import { parseCodexAppServerRateLimits } from "../parsers/codex";
import { CollectorUnavailableError } from "./errors";
import { resolveCommandPath } from "./command";
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
  const meta = {
    checkedAt,
    sourceCommand: "codex app-server -> account/rateLimits/read",
    planLabel: context.config.planLabelFallback.codex ?? "ChatGPT",
  };

  try {
    if (!context.config.codex.collectDefault) {
      throw new CollectorUnavailableError("Codex default collection is disabled.");
    }

    const command = await resolveCommandPath(
      "codex",
      context.rootDir,
      context.commandRunner
    );
    if (!command) {
      throw new CollectorUnavailableError("Codex CLI is not installed.");
    }

    let appServer;
    try {
      appServer = await (
        dependencies.appServerReader ?? readCodexAppServerRateLimits
      )({ cwd: context.rootDir, command });
    } catch (error) {
      if (error instanceof CodexAppServerError) {
        throw new CollectorUnavailableError(
          `Codex's structured quota source is unavailable: ${error.message}`,
          error.diagnosticText,
          error.diagnosticText
        );
      }
      throw error;
    }
    return okResult({
      provider,
      startedAt,
      checkedAt,
      limits: parseCodexAppServerRateLimits(appServer.payload, meta),
      rawText: appServer.rawText,
      cleanedText: appServer.rawText,
      rawFileName,
    });
  } catch (error) {
    return failedResult({ provider, startedAt, checkedAt, rawFileName, error });
  }
}
