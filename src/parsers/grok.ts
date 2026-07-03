import type { UsageLimit } from "../types";
import { limitFromUsed, type ParserMeta } from "./common";
import { ParserDriftError } from "./errors";

// Grok moved quota out of the launch footer into the `/usage show` command
// (labelled "View credit usage" in the CLI). Its output, printed into the
// status area, reads:
//   Monthly limit: 5%   Next reset: July 31, 16:00 PT
// The percentage is the amount USED — the command reports "credit usage", and
// the old remaining-style "Monthly limit left: N%" footer no longer exists.
// (ConPTY may glue a stray cursor char between the two fields, e.g.
// "Monthly limit: 5%XNext reset: …", so each field is matched independently.)
const MONTHLY_RE = /Monthly limit:\s*(\d+(?:\.\d+)?)%/i;
const RESET_RE =
  /Next reset:\s*([A-Za-z]+\s+\d{1,2},\s*\d{1,2}:\d{2}\s*[A-Za-z]{2,4})/i;

export function parseGrokUsage(text: string, meta: ParserMeta): UsageLimit[] {
  const match = text.match(MONTHLY_RE);
  if (!match) {
    throw new ParserDriftError(
      "Grok output did not contain a 'Monthly limit' line (run /usage show).",
      text
    );
  }

  const reset = text.match(RESET_RE)?.[1]?.replace(/\s+/g, " ").trim();

  return [
    limitFromUsed({
      id: "grok:monthly",
      provider: "grok",
      providerLabel: "Grok",
      scope: "Monthly limit",
      window: "monthly",
      usedPercent: Number(match[1]),
      resetLabel: reset ? `Resets ${reset}` : undefined,
      sourceText: `Monthly limit: ${match[1]}%${reset ? ` · Next reset: ${reset}` : ""}`,
      meta,
    }),
  ];
}
