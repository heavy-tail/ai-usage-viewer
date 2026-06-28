import type { UsageLimit } from "../types";
import { limitFromRemaining, type ParserMeta } from "./common";
import { ParserDriftError } from "./errors";

// Grok's CLI removed its in-terminal /usage screen. The remaining quota is now
// shown in the launch footer / status bar, e.g.:
//   ╰──────────── Monthly limit left: 0% · Composer 2.5 Fast ─╯
// The percentage is the amount REMAINING. The text after "·" is the active
// model, but it is frequently overwritten by a spinner ("⠧ q") or clipped by
// the box border, so we read only the percentage.
const MONTHLY_RE = /Monthly limit left:\s*(\d+(?:\.\d+)?)%/i;

export function parseGrokUsage(text: string, meta: ParserMeta): UsageLimit[] {
  const match = text.match(MONTHLY_RE);
  if (!match) {
    throw new ParserDriftError(
      "Grok output did not contain a 'Monthly limit left' footer.",
      text
    );
  }

  return [
    limitFromRemaining({
      id: "grok:monthly",
      provider: "grok",
      providerLabel: "Grok",
      scope: "Monthly limit",
      window: "monthly",
      remainingPercent: Number(match[1]),
      sourceText: `Monthly limit left: ${match[1]}%`,
      meta,
    }),
  ];
}
