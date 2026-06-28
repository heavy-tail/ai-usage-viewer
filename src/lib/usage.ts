import type {
  UsageLimit,
  UsageProvider,
  UsageSnapshot,
  UsageStatus,
} from "../types";
import { statusFromPercent } from "./percent";

export const PROVIDER_ORDER: UsageProvider[] = [
  "claude",
  "codex",
  "agy",
  "grok",
];

export const PROVIDER_LABEL: Record<UsageProvider, string> = {
  claude: "Claude Code",
  codex: "Codex",
  agy: "Antigravity",
  grok: "Grok",
};

// Maps to the CSS variable suffix used for colors (--st-green, etc.).
export type Tone = "green" | "amber" | "red" | "gray" | "orange" | "purple";

export const STATUS_TONE: Record<UsageStatus, Tone> = {
  available: "green",
  warning: "amber",
  exhausted: "red",
  unknown: "gray",
  unavailable: "gray",
  error: "orange",
  drift: "purple",
};

// Bar fill "heat" by how full a limit is, in three semantic bands. Kept
// separate from `status` so the bar reads as a magnitude gauge (how close to
// the cap) while the badge/attention chips stay the discrete alert signal.
//   0–74% green · 75–89% amber · 90–100% red
export function usageTone(usedPercent?: number): Tone {
  if (usedPercent == null || Number.isNaN(usedPercent)) return "gray";
  if (usedPercent >= 90) return "red";
  if (usedPercent >= 75) return "amber";
  return "green";
}

export function deriveStatus(used?: number, remaining?: number): UsageStatus {
  return statusFromPercent({ usedPercent: used, remainingPercent: remaining });
}

export function groupByProvider(
  limits: UsageLimit[]
): Record<UsageProvider, UsageLimit[]> {
  const out = { claude: [], codex: [], agy: [], grok: [] } as Record<
    UsageProvider,
    UsageLimit[]
  >;
  const indexes = { claude: new Map(), codex: new Map(), agy: new Map(), grok: new Map() } as Record<
    UsageProvider,
    Map<string, number>
  >;

  for (const l of limits) {
    const bucket = out[l.provider];
    const existingIndex = indexes[l.provider].get(l.id);
    if (existingIndex == null) {
      indexes[l.provider].set(l.id, bucket.length);
      bucket.push(l);
    } else {
      bucket[existingIndex] = l;
    }
  }
  return out;
}

export function fmtPercent(n?: number): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${Math.round(n)}%`;
}

export function snapshotPlanLabel(
  snapshot: UsageSnapshot,
  provider: UsageProvider
): string | undefined {
  return snapshot.limits.find((l) => l.provider === provider && l.planLabel)
    ?.planLabel;
}
