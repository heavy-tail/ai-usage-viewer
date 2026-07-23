import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseGrokUsage } from "../parsers/grok";
import { localSourceTimeZone } from "../parsers/common";
import { CollectorUnavailableError } from "./errors";
import { resolveCommandPath } from "./command";
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
  const configuredCommand = context.config.grokCommand ?? "grok";

  try {
    const command = isAbsolute(configuredCommand)
      ? existsSync(configuredCommand)
        ? configuredCommand
        : undefined
      : await resolveCommandPath(
          configuredCommand,
          context.rootDir,
          context.commandRunner
        );
    if (!command) {
      throw new CollectorUnavailableError(
        `Grok CLI (${configuredCommand}) is not installed.`
      );
    }

    const pty = await context.ptyRunner({
      command,
      args: ["--no-alt-screen"],
      cwd: context.rootDir,
      totalTimeoutMs: 30_000,
      steps: [
        // Quota warnings are conditional and may be weekly or monthly. The
        // prompt marker is the stable signal that the current public Grok Build
        // TUI is ready to accept a slash command, regardless of usage level.
        {
          waitFor:
            /(?:(?:│|\|)\s*>|(?:^|[\r\n])\s*>)\s*(?:Type a message\.\.\.)?/m,
          timeoutMs: 15_000,
        },
        { delayMs: 300 },
        // Submit the complete slash command directly. Driving the completion
        // menu introduced rotating suggestion/status redraws into ConPTY and
        // occasionally selected no action at all, making refresh flaky.
        { send: "/usage show\r", delayMs: 300 },
        {
          waitFor:
            /(?:(?:(?:Monthly|Weekly) limit|Usage):\s*\d|Login with Grok|error sending request[^\r\n]*auth\.x\.ai)/i,
          timeoutMs: 12_000,
        },
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
    if (
      /Login with Grok|error sending request[^\r\n]*auth\.x\.ai/i.test(
        pty.cleanedOutput
      )
    ) {
      throw new CollectorUnavailableError(
        "Grok CLI could not authenticate with xAI.",
        pty.rawOutput,
        pty.cleanedOutput
      );
    }

    const meta = {
      checkedAt,
      sourceCommand: "grok -> quota footer + /usage show",
      sourceTimeZone: localSourceTimeZone(),
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
