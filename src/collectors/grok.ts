import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseGrokUsage } from "../parsers/grok";
import { CollectorUnavailableError } from "./errors";
import { isCommandAvailable } from "./command";
import { failedResult, okResult } from "./helpers";
import type { CollectorContext, ProviderCollectorResult } from "./types";

export async function collectGrok(
  context: CollectorContext
): Promise<ProviderCollectorResult> {
  const provider = "grok" as const;
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();
  const rawFileName = "grok.txt";
  // Grok runs as a native Windows binary now (was routed through WSL, which
  // popped a console window when WSL cold-started). `grokCommand` is "grok" by
  // default and can be an absolute path in config.json when it isn't on PATH.
  const command = context.config.grokCommand ?? "grok";

  try {
    const available = isAbsolute(command)
      ? existsSync(command)
      : await isCommandAvailable(command, context.rootDir, context.commandRunner);
    if (!available) {
      throw new CollectorUnavailableError(`Grok CLI (${command}) is not installed.`);
    }

    const pty = await context.ptyRunner({
      command,
      args: ["--no-alt-screen"],
      cwd: context.rootDir,
      totalTimeoutMs: 30_000,
      steps: [
        // Grok moved quota behind `/usage show` ("View credit usage"). Wait for
        // the composer to draw, then run it by opening the slash autocomplete
        // ("/usage " leaves "show" highlighted) and pressing Enter. Typing "show"
        // ourselves collides with the completion and errors ("Unknown argument").
        { waitFor: /Composer 2\.5|❯|\d+\s*\/\s*\d+K/i, timeoutMs: 15_000 },
        { delayMs: 3_500 },
        { send: "/usage ", delayMs: 1_500 },
        { send: "\r", delayMs: 300 },
        { waitFor: /Monthly limit:\s*\d/i, timeoutMs: 12_000 },
        { delayMs: 300 },
        { send: "/quit\r", delayMs: 100 },
      ],
    });

    if (/command not found|not found|No such file/i.test(pty.cleanedOutput)) {
      throw new CollectorUnavailableError(
        "Grok CLI is not available.",
        pty.rawOutput,
        pty.cleanedOutput
      );
    }

    const meta = {
      checkedAt,
      sourceCommand: "grok -> /usage show",
      planLabel: context.config.planLabelFallback.grok ?? "SuperGrok",
    };

    return okResult({
      provider,
      startedAt,
      checkedAt,
      limits: parseGrokUsage(pty.cleanedOutput, meta),
      rawText: pty.rawOutput,
      cleanedText: pty.cleanedOutput,
      rawFileName,
    });
  } catch (error) {
    return failedResult({ provider, startedAt, checkedAt, rawFileName, error });
  }
}
