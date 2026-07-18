import { parseAgyAccountInfo, parseAgyQuota } from "../parsers/agy";
import { CollectorUnavailableError } from "./errors";
import { isCommandAvailable } from "./command";
import { failedResult, okResult } from "./helpers";
import type { CollectorContext, ProviderCollectorResult } from "./types";

export async function collectAgy(
  context: CollectorContext
): Promise<ProviderCollectorResult> {
  const provider = "agy" as const;
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();
  const rawFileName = "agy.txt";

  try {
    if (!(await isCommandAvailable("agy", context.rootDir, context.commandRunner))) {
      throw new CollectorUnavailableError("Antigravity CLI (agy) is not installed.");
    }

    const pty = await context.ptyRunner({
      command: "agy",
      args: [],
      cwd: context.rootDir,
      cols: 160,
      rows: 60,
      // agy signs in over the network at launch ("Signing in…") before it can
      // draw the quota screen; that step is variable and occasionally exceeds
      // 30s, which previously tripped the total cap and marked agy stale. Give
      // the slow-login case headroom (the success path still finishes in ~6-9s).
      totalTimeoutMs: 45_000,
      responders: [
        {
          // Keep this anchored to the actual trust question. A broad
          // /workspace/ responder also matches the `/add-dir` help text and
          // types "y" into the normal prompt while the quota screen closes.
          when: /(?:do you trust|trust this (?:folder|workspace)|allow access to this workspace)/i,
          send: "y\r",
          once: true,
        },
      ],
      steps: [
        { waitFor: /\? for shortcuts|Google AI Pro|>\s*$/i, timeoutMs: 15_000 },
        { send: "/quota\r", delayMs: 250 },
        // Wait for the actual quota screen ("Weekly Limit" only renders there),
        // not the "/usage (quota)" autocomplete menu. Then let all groups draw.
        { waitFor: /Weekly Limit/i, timeoutMs: 40_000 },
        { delayMs: 1_000 },
        { send: "\x1b", delayMs: 100 },
        { send: "/exit\r", delayMs: 100 },
      ],
    });

    const account = parseAgyAccountInfo(pty.cleanedOutput);
    const meta = {
      checkedAt,
      sourceCommand: "agy -> /quota",
      planLabel:
        account.planLabel ?? context.config.planLabelFallback.agy ?? undefined,
      accountLabel: account.email,
    };

    return okResult({
      provider,
      startedAt,
      checkedAt,
      limits: parseAgyQuota(
        pty.cleanedOutput,
        meta,
        context.config.agy.pinnedGroups
      ),
      rawText: pty.rawOutput,
      cleanedText: pty.cleanedOutput,
      rawFileName,
    });
  } catch (error) {
    return failedResult({ provider, startedAt, checkedAt, rawFileName, error });
  }
}
