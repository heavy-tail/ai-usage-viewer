import type { UsageStatus } from "../types";

export type PercentPair = {
  usedPercent?: number;
  remainingPercent?: number;
};

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function fromUsedPercent(used: number): Required<PercentPair> {
  const usedPercent = clampPercent(used);
  return {
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
  };
}

export function fromRemainingPercent(
  remaining: number
): Required<PercentPair> {
  const remainingPercent = clampPercent(remaining);
  return {
    usedPercent: clampPercent(100 - remainingPercent),
    remainingPercent,
  };
}

export function statusFromPercent(
  percent: PercentPair,
  sourceText = "",
  informational = false
): UsageStatus {
  const lowered = sourceText.toLowerCase();
  const used =
    percent.usedPercent ??
    (percent.remainingPercent != null
      ? clampPercent(100 - percent.remainingPercent)
      : undefined);
  const remaining =
    percent.remainingPercent ??
    (percent.usedPercent != null ? clampPercent(100 - percent.usedPercent) : undefined);

  if (lowered.includes("exhausted") || lowered.includes("limit hit")) {
    return "exhausted";
  }
  if (used == null && remaining == null) return "unknown";
  if (remaining === 0) return "exhausted";
  if (informational) return "available";
  if ((used ?? 0) >= 80 || (remaining ?? 100) <= 20) return "warning";
  return "available";
}
