import { cleanTerminalOutput } from "../lib/terminal";
import {
  claudePlanLabel,
  parseClaudeAuthStatus,
  parseClaudeUsage,
} from "../parsers/claude";
import { localSourceTimeZone } from "../parsers/common";
import { CollectorUnavailableError } from "./errors";
import { resolveCommandPath } from "./command";
import { failedResult, okResult } from "./helpers";
import type { CollectorContext, ProviderCollectorResult } from "./types";

const CACHED_USAGE_RE =
  /Showing last-known usage\b[\s\S]{0,160}\bcould not refresh\b/i;

export async function collectClaude(
  context: CollectorContext
): Promise<ProviderCollectorResult> {
  const provider = "claude" as const;
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();
  const rawFileName = "claude.txt";

  try {
    const command = await resolveCommandPath(
      "claude",
      context.rootDir,
      context.commandRunner
    );
    if (!command) {
      throw new CollectorUnavailableError("Claude CLI is not installed.");
    }

    const authText = await readClaudeAuthStatus(context, command);
    const auth = parseClaudeAuthStatus(authText);
    if (authText && !auth.loggedIn) {
      throw new CollectorUnavailableError(
        "Claude CLI is not logged in.",
        authText,
        cleanTerminalOutput(authText)
      );
    }

    const claudeArgs = await supportedClaudeArgs(context, command);
    const pty = await context.ptyRunner({
      command,
      args: claudeArgs,
      cwd: context.rootDir,
      // Covers the worst-case sum of the startup, core-usage, and optional
      // credits waits. The optional end marker must never exhaust the overall
      // deadline after the core usage rows have already been verified.
      totalTimeoutMs: 60_000,
      steps: [
        {
          // Startup can be slower while Claude initializes MCP servers, and
          // the rotating suggestion text is not stable across releases.
          waitFor: /auto mode on|Try "[^"]+"/i,
          timeoutMs: 25_000,
        },
        { send: "/usage\r", delayMs: 500 },
        { send: "\r", delayMs: 250 },
        {
          waitFor:
            /Current session[\s\S]*?\d+(?:\.\d+)?%\s+used[\s\S]*?Current week\s*\(all models\)[\s\S]*?\d+(?:\.\d+)?%\s+used/i,
          timeoutMs: 20_000,
        },
        // Model-specific rows arrive after Claude finishes scanning local
        // sessions. Credits is the semantic end marker in current builds; it is
        // optional so older plans/builds still return their verified core rows.
        {
          waitFor: /^[\t ]*Usage credits[\t ]*$/im,
          timeoutMs: 5_000,
          optional: true,
          // Credits can paint before the asynchronous model-specific scan has
          // committed its final row. The contribution heading below is the
          // semantic completion signal for that scan.
          delayMs: 250,
        },
        {
          waitFor: /What's contributing to your limits usage\?/i,
          timeoutMs: 6_000,
          optional: true,
          // Older builds/plans omit the contribution panel. In that case the
          // optional wait itself provides a bounded settle period.
          delayMs: 250,
        },
        { send: "\x1b", delayMs: 100 },
        { send: "/exit\r", delayMs: 100 },
      ],
    });

    // Claude can render structurally valid percentages while explicitly saying
    // they are cached because its own refresh failed. Never relabel those rows
    // as newly verified; the refresh layer will retain the prior verified
    // snapshot and mark it stale instead.
    if (CACHED_USAGE_RE.test(pty.cleanedOutput)) {
      throw new CollectorUnavailableError(
        "Claude CLI could not refresh its usage data.",
        pty.rawOutput,
        pty.cleanedOutput
      );
    }

    const meta = {
      checkedAt,
      sourceCommand: "claude -> /usage",
      sourceTimeZone: localSourceTimeZone(),
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

async function readClaudeAuthStatus(
  context: CollectorContext,
  command: string
): Promise<string> {
  const result = await context.commandRunner(command, ["auth", "status"], {
    cwd: context.rootDir,
    timeoutMs: 5_000,
  });
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

async function supportedClaudeArgs(
  context: CollectorContext,
  command: string
): Promise<string[]> {
  try {
    const result = await context.commandRunner(command, ["--help"], {
      cwd: context.rootDir,
      timeoutMs: 5_000,
    });
    const helpText = [result.stdout, result.stderr].filter(Boolean).join("\n");
    return result.exitCode === 0 &&
      /(?:^|\s)--ax-screen-reader(?:\s|$)/m.test(helpText)
      ? ["--ax-screen-reader"]
      : [];
  } catch {
    return [];
  }
}
