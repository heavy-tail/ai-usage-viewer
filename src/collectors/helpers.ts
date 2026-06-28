import type { UsageLimit, UsageProvider } from "../types";
import { isParserDriftError } from "../parsers/errors";
import {
  CollectorUnavailableError,
  PtyProcessError,
  PtyTimeoutError,
  errorMessage,
} from "./errors";
import type { ProviderCollectorResult } from "./types";

export function okResult(input: {
  provider: UsageProvider;
  startedAt: number;
  checkedAt: string;
  limits: UsageLimit[];
  rawText: string;
  cleanedText: string;
  rawFileName: string;
}): ProviderCollectorResult {
  return {
    provider: input.provider,
    ok: true,
    state: "ok",
    checkedAt: input.checkedAt,
    durationMs: Date.now() - input.startedAt,
    limits: input.limits,
    rawText: input.rawText,
    cleanedText: input.cleanedText,
    rawFileName: input.rawFileName,
  };
}

export function failedResult(input: {
  provider: UsageProvider;
  startedAt: number;
  checkedAt: string;
  rawFileName: string;
  error: unknown;
}): ProviderCollectorResult {
  const error = input.error;
  const rawText = extractRawText(error);
  const cleanedText = extractCleanedText(error);

  if (error instanceof CollectorUnavailableError) {
    return makeFailed("unavailable", input, rawText, cleanedText);
  }

  if (isParserDriftError(error)) {
    return makeFailed("drift", input, error.sourceText, error.sourceText);
  }

  if (error instanceof PtyTimeoutError || error instanceof PtyProcessError) {
    return makeFailed("error", input, rawText, cleanedText);
  }

  return makeFailed("error", input, rawText, cleanedText);
}

function makeFailed(
  state: "unavailable" | "error" | "drift",
  input: {
    provider: UsageProvider;
    startedAt: number;
    checkedAt: string;
    rawFileName: string;
    error: unknown;
  },
  rawText = "",
  cleanedText = ""
): ProviderCollectorResult {
  return {
    provider: input.provider,
    ok: false,
    state,
    checkedAt: input.checkedAt,
    durationMs: Date.now() - input.startedAt,
    limits: [],
    rawText,
    cleanedText,
    rawFileName: input.rawFileName,
    error: errorMessage(input.error),
  };
}

function extractRawText(error: unknown): string {
  if (
    error instanceof CollectorUnavailableError ||
    error instanceof PtyTimeoutError ||
    error instanceof PtyProcessError
  ) {
    return error.rawText ?? "";
  }
  return "";
}

function extractCleanedText(error: unknown): string {
  if (
    error instanceof CollectorUnavailableError ||
    error instanceof PtyTimeoutError ||
    error instanceof PtyProcessError
  ) {
    return error.cleanedText ?? "";
  }
  return "";
}
