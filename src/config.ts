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
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `config.json is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return mergeConfig(validateConfig(parsed));
}

type ConfigInput = {
  enabledProviders?: UsageProvider[];
  codex?: Partial<AppConfig["codex"]>;
  agy?: Partial<AppConfig["agy"]>;
  timezone?: string;
  grokCommand?: string;
  wsl?: Partial<AppConfig["wsl"]>;
  planLabelFallback?: AppConfig["planLabelFallback"];
};

function mergeConfig(parsed: ConfigInput): AppConfig {
  const config = {
    ...DEFAULT_CONFIG,
    ...parsed,
    enabledProviders:
      parsed.enabledProviders ?? DEFAULT_CONFIG.enabledProviders,
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

function validateConfig(value: unknown): ConfigInput {
  const input = record(value, "must be a JSON object");
  assertKnownKeys(input, [
    "enabledProviders",
    "codex",
    "agy",
    "timezone",
    "grokCommand",
    "wsl",
    "planLabelFallback",
  ]);
  const result: ConfigInput = {};

  if ("enabledProviders" in input) {
    if (!Array.isArray(input.enabledProviders)) {
      invalid("enabledProviders must be an array of provider names");
    }
    const allowed: UsageProvider[] = ["claude", "codex", "agy", "grok"];
    const providers = input.enabledProviders.map((provider, index) => {
      if (typeof provider !== "string" || !allowed.includes(provider as UsageProvider)) {
        invalid(`enabledProviders[${index}] must be one of ${allowed.join(", ")}`);
      }
      return provider as UsageProvider;
    });
    if (new Set(providers).size !== providers.length) {
      invalid("enabledProviders must not contain duplicate providers");
    }
    result.enabledProviders = providers;
  }

  if ("codex" in input) {
    const codex = record(input.codex, "codex must be an object");
    assertKnownKeys(codex, ["collectDefault", "additionalModelsForContext"], "codex");
    const validated: Partial<AppConfig["codex"]> = {};
    if ("collectDefault" in codex) {
      if (typeof codex.collectDefault !== "boolean") {
        invalid("codex.collectDefault must be a boolean");
      }
      validated.collectDefault = codex.collectDefault;
    }
    if ("additionalModelsForContext" in codex) {
      validated.additionalModelsForContext = stringArray(
        codex.additionalModelsForContext,
        "codex.additionalModelsForContext"
      );
    }
    result.codex = validated;
  }

  if ("agy" in input) {
    const agy = record(input.agy, "agy must be an object");
    assertKnownKeys(agy, ["pinnedGroups"], "agy");
    const validated: Partial<AppConfig["agy"]> = {};
    if ("pinnedGroups" in agy) {
      validated.pinnedGroups = stringArray(agy.pinnedGroups, "agy.pinnedGroups");
    }
    result.agy = validated;
  }

  if ("timezone" in input) {
    assertNonEmptyString(input.timezone, "timezone");
    result.timezone = input.timezone;
  }
  if ("grokCommand" in input) {
    assertNonEmptyString(input.grokCommand, "grokCommand");
    result.grokCommand = input.grokCommand;
  }

  if ("wsl" in input) {
    const wsl = record(input.wsl, "wsl must be an object");
    assertKnownKeys(wsl, ["distro", "cwd", "grokCommand"], "wsl");
    const validated: Partial<AppConfig["wsl"]> = {};
    for (const key of ["distro", "cwd", "grokCommand"] as const) {
      if (key in wsl) {
        assertNonEmptyString(wsl[key], `wsl.${key}`);
        validated[key] = wsl[key];
      }
    }
    result.wsl = validated;
  }

  if ("planLabelFallback" in input) {
    const labels = record(
      input.planLabelFallback,
      "planLabelFallback must be an object"
    );
    const providers: UsageProvider[] = ["claude", "codex", "agy", "grok"];
    assertKnownKeys(labels, providers, "planLabelFallback");
    const validated: AppConfig["planLabelFallback"] = {};
    for (const provider of providers) {
      if (provider in labels) {
        assertNonEmptyString(labels[provider], `planLabelFallback.${provider}`);
        validated[provider] = labels[provider];
      }
    }
    result.planLabelFallback = validated;
  }

  return result;
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(message);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path = ""
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) invalid(`${path ? `${path}.` : ""}${unknown} is not a recognized setting`);
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) invalid(`${path} must be an array of strings`);
  return value.map((item, index) => {
    assertNonEmptyString(item, `${path}[${index}]`);
    return item;
  });
}

function assertNonEmptyString(
  value: unknown,
  path: string
): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    invalid(`${path} must be a non-empty string`);
  }
}

function invalid(message: string): never {
  throw new Error(`config.json ${message}.`);
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
