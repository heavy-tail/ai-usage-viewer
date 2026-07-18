import { isAbsolute, relative, resolve } from "node:path";
import { parseAgyRpcQuota } from "../parsers/agyRpc";
import { CollectorUnavailableError } from "./errors";
import { resolveCommandPath } from "./command";
import { readAgyQuotaRpc } from "./agyRpc";
import { failedResult, okResult } from "./helpers";
import type { CollectorContext, ProviderCollectorResult } from "./types";

export async function collectAgy(
  context: CollectorContext,
  dependencies: {
    rpcReader?: typeof readAgyQuotaRpc;
  } = {}
): Promise<ProviderCollectorResult> {
  const provider = "agy" as const;
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();
  const rawFileName = "agy.txt";

  try {
    const command = await resolveCommandPath(
      "agy",
      context.rootDir,
      context.commandRunner
    );
    if (!command) {
      throw new CollectorUnavailableError("Antigravity CLI (agy) is not installed.");
    }
    if (!isAbsolute(command) || isWithinDirectory(command, context.rootDir)) {
      throw new CollectorUnavailableError(
        "Antigravity CLI (agy) did not resolve to a trusted installed executable."
      );
    }

    // AGY's TUI creates a Windows console before hiding it, which can still be
    // presented for a frame. Its own local language service exposes the same
    // quota as structured Connect JSON, so collect that data without creating a
    // PTY or scraping a provider-owned screen. If this private contract changes,
    // fail closed and retain the last verified rows instead of falling back to a
    // terminal that can flash or silently publish an incomplete layout.
    const rpc = await (dependencies.rpcReader ?? readAgyQuotaRpc)({
      command,
      cwd: context.rootDir,
      timeoutMs: 30_000,
    });
    const meta = {
      checkedAt,
      sourceCommand: "agy local quota API",
      planLabel: context.config.planLabelFallback.agy ?? undefined,
    };
    const parsed = parseAgyRpcQuota(
      rpc.payload,
      meta,
      context.config.agy.pinnedGroups
    );

    return okResult({
      provider,
      startedAt,
      checkedAt,
      limits: parsed.limits,
      // Never persist AGY's complete internal response. The parser emits only
      // the normalized quota structure needed for diagnostics/fingerprinting.
      rawText: parsed.sourceText,
      cleanedText: parsed.sourceText,
      rawFileName,
    });
  } catch (error) {
    return failedResult({ provider, startedAt, checkedAt, rawFileName, error });
  }
}

function isWithinDirectory(path: string, directory: string): boolean {
  const difference = relative(resolve(directory), resolve(path));
  return (
    difference === "" ||
    (!difference.startsWith("..") && !isAbsolute(difference))
  );
}
