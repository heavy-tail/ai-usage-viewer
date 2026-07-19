import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig, UsageProvider } from "./types";

export const DEFAULT_CONFIG: AppConfig = {
  enabledProviders: ["claude", "codex", "agy", "grok"],
  codex: {
    collectDefault: true,
    additionalModelsForContext: [],
  },
  agy: {
    pinnedGroups: [],
  },
  timezone: "UTC",
  grokCommand: "grok",
  wsl: {
    distro: undefined,
    cwd: ".",
    grokCommand: "grok",
  },
  planLabelFallback: {
    claude: "Max 200",
    codex: "ChatGPT",
    agy: "Google AI Pro",
    grok: "SuperGrok",
  },
};

export async function loadConfig(rootDir: string): Promise<AppConfig> {
  let text: string;
  try {
    text = await readFile(join(rootDir, "config.json"), "utf8");
  } catch (error) {
    // Only a genuinely missing file may enable the defaults. Permission,
    // device, and decoding failures must fail closed instead of silently
    // enabling collectors the user may have disabled.
    if (isMissingFileError(error)) return DEFAULT_CONFIG;
    throw new Error(
      `Unable to read config.json: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  // A present-but-malformed config must NOT silently fall back to defaults:
  // DEFAULT_CONFIG enables every provider, so a typo could re-enable collectors
  // the user meant to disable. Surface a clear error instead.
  let parsed: Partial<AppConfig>;
  try {
    parsed = JSON.parse(text) as Partial<AppConfig>;
  } catch (error) {
    throw new Error(
      `config.json is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return mergeConfig(parsed);
}

function mergeConfig(parsed: Partial<AppConfig>): AppConfig {
  const config = {
    ...DEFAULT_CONFIG,
    ...parsed,
    enabledProviders: normalizeProviders(
      parsed.enabledProviders ?? DEFAULT_CONFIG.enabledProviders
    ),
    codex: {
      ...DEFAULT_CONFIG.codex,
      ...parsed.codex,
      additionalModelsForContext:
        parsed.codex?.additionalModelsForContext ??
        DEFAULT_CONFIG.codex.additionalModelsForContext,
    },
    agy: {
      ...DEFAULT_CONFIG.agy,
      ...parsed.agy,
      pinnedGroups: parsed.agy?.pinnedGroups ?? DEFAULT_CONFIG.agy.pinnedGroups,
    },
    wsl: {
      ...DEFAULT_CONFIG.wsl,
      ...parsed.wsl,
    },
    planLabelFallback: {
      ...DEFAULT_CONFIG.planLabelFallback,
      ...parsed.planLabelFallback,
    },
  };
  assertValidTimeZone(config.timezone);
  return config;
}

function normalizeProviders(values: UsageProvider[]): UsageProvider[] {
  const allowed: UsageProvider[] = ["claude", "codex", "agy", "grok"];
  return values.filter((value): value is UsageProvider => allowed.includes(value));
}

function isMissingFileError(error: unknown): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function assertValidTimeZone(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("config.json timezone must be a non-empty IANA timezone.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    throw new Error(`config.json timezone ${JSON.stringify(value)} is invalid.`);
  }
}
