import { isAbsolute, relative, resolve } from "node:path";
import { parseAgyRpcQuota } from "../parsers/agyRpc";
import { localSourceTimeZone } from "../parsers/common";
import { CollectorUnavailableError } from "./errors";
import { resolveCommandPath } from "./command";
import {
  AgyRpcError,
  readAgyQuotaRpc,
  type AgyRpcOptions,
  type AgyRpcResult,
} from "./agyRpc";
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
    const rpc = await readQuotaWithStartupRetry(
      dependencies.rpcReader ?? readAgyQuotaRpc,
      {
      command,
      cwd: context.rootDir,
      }
    );
    const meta = {
      checkedAt,
      sourceCommand: "agy local quota API",
      sourceTimeZone: localSourceTimeZone(),
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

async function readQuotaWithStartupRetry(
  reader: (options?: AgyRpcOptions) => Promise<AgyRpcResult>,
  options: Pick<AgyRpcOptions, "command" | "cwd">
): Promise<AgyRpcResult> {
  try {
    // Healthy launches announce the loopback service in a few seconds. A
    // shorter first deadline lets us recover from AGY's occasional hung cold
    // start without making the user wait through the entire refresh budget.
    return await reader({ ...options, timeoutMs: 15_000 });
  } catch (error) {
    if (!(error instanceof AgyRpcError) || error.code !== "timeout") {
      throw error;
    }
  }

  // The first attempt has already been fully cleaned up by readAgyQuotaRpc.
  // One fresh, independently contained launch remains bounded by the original
  // 45-second aggregate budget and succeeds on current AGY builds after a
  // transient cold-start hang.
  return reader({ ...options, timeoutMs: 30_000 });
}

function isWithinDirectory(path: string, directory: string): boolean {
  const difference = relative(resolve(directory), resolve(path));
  return (
    difference === "" ||
    (!difference.startsWith("..") && !isAbsolute(difference))
  );
}
