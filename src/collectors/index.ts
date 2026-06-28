import type { UsageProvider } from "../types";
import { collectAgy } from "./agy";
import { collectClaude } from "./claude";
import { collectCodex } from "./codex";
import { collectGrok } from "./grok";
import type { ProviderCollector } from "./types";

export const PROVIDER_COLLECTORS: Record<UsageProvider, ProviderCollector> = {
  claude: collectClaude,
  codex: collectCodex,
  agy: collectAgy,
  grok: collectGrok,
};
