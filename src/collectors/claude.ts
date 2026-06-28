import { cleanTerminalOutput } from "../lib/terminal";
import {
  claudePlanLabel,
  parseClaudeAuthStatus,
  parseClaudeUsage,
} from "../parsers/claude";
import { CollectorUnavailableError } from "./errors";
import { isCommandAvailable } from "./command";
import { failedResult, okResult } from "./helpers";
import type { CollectorContext, ProviderCollectorResult } from "./types";

export async function collectClaude(
  context: CollectorContext
): Promise<ProviderCollectorResult> {
  const provider = "claude" as const;
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();
  const rawFileName = "claude.txt";

  try {
    if (
      !(await isCommandAvailable("claude", context.rootDir, context.commandRunner))
    ) {
      throw new CollectorUnavailableError("Claude CLI is not installed.");
    }

    const authText = await readClaudeAuthStatus(context);
    const auth = parseClaudeAuthStatus(authText);
    if (authText && !auth.loggedIn) {
      throw new CollectorUnavailableError(
        "Claude CLI is not logged in.",
        authText,
        cleanTerminalOutput(authText)
      );
    }

    const pty = await context.ptyRunner({
      command: "claude",
      args: [],
      cwd: context.rootDir,
      totalTimeoutMs: 20_000,
      steps: [
        { waitFor: /auto mode on|Try "create|>\s*/i, timeoutMs: 12_000 },
        { send: "/usage\r", delayMs: 500 },
        { send: "\r", delayMs: 250 },
        { waitFor: /Current session[\s\S]*Current week/i, timeoutMs: 20_000 },
        { send: "\x1b", delayMs: 100 },
        { send: "/exit\r", delayMs: 100 },
      ],
    });

    const meta = {
      checkedAt,
      sourceCommand: "claude -> /usage",
      planLabel: claudePlanLabel(
        auth,
        context.config.planLabelFallback.claude
      ),
      accountLabel: auth.email ?? auth.orgName ?? auth.orgId,
    };

    return okResult({
      provider,
      startedAt,
      checkedAt,
      limits: parseClaudeUsage(pty.cleanedOutput, meta),
      rawText: [authText, pty.rawOutput].filter(Boolean).join("\n"),
      cleanedText: [cleanTerminalOutput(authText), pty.cleanedOutput]
        .filter(Boolean)
        .join("\n"),
      rawFileName,
    });
  } catch (error) {
    return failedResult({ provider, startedAt, checkedAt, rawFileName, error });
  }
}

async function readClaudeAuthStatus(context: CollectorContext): Promise<string> {
  const result = await context.commandRunner("claude", ["auth", "status"], {
    cwd: context.rootDir,
    timeoutMs: 5_000,
  });
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}
