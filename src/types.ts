// Normalized data model — mirrors spec.md "Normalized Data Model" + Appendix A.

export type UsageProvider = "claude" | "codex" | "agy" | "grok";

export type UsageStatus =
  | "available"
  | "warning"
  | "exhausted"
  | "unknown"
  | "unavailable"
  | "error"
  | "drift";

export type UsageLimit = {
  id: string;
  provider: UsageProvider;
  providerLabel: string;
  planLabel?: string;
  accountLabel?: string;

  // Example: "Current session", "Current week (all models)",
  // "gpt-5.5 xhigh fast", "Gemini 3.5 Flash (High)", "Free credits".
  scope: string;

  // Example: "session", "5h", "weekly", "monthly", "model-quota", "context".
  window?: string;

  usedPercent?: number;
  remainingPercent?: number;
  resetLabel?: string;

  // MVP displays resetLabel only; resetAt stays unset until timezone/year
  // inference is implemented (Appendix A.2.3).
  resetAt?: string;

  status: UsageStatus;
  statusLabel?: string;

  // Context-style rows shown as secondary metadata, not a colored quota bar.
  informational?: boolean;

  sourceCommand: string;
  sourceText: string;
  checkedAt: string;
  error?: string;
};

export type CollectorState =
  | "ok"
  | "unavailable"
  | "error"
  | "drift"
  | "stale";

export type CollectorHealth = {
  provider: UsageProvider;
  ok: boolean;
  state: CollectorState;
  checkedAt: string;
  durationMs: number;
  error?: string;
};

export type UsageSnapshot = {
  generatedAt: string;
  collectors: CollectorHealth[];
  limits: UsageLimit[];
};

export type AppConfig = {
  enabledProviders: UsageProvider[];
  codex: {
    collectDefault: boolean;
    // Reserved — accepted in config but not yet consumed by any collector/UI.
    additionalModelsForContext: string[];
  };
  agy: {
    // Optional filter of Antigravity model-group names (e.g. "Gemini Models").
    // Empty means show every group.
    pinnedGroups: string[];
  };
  // Reserved — accepted in config but not yet consumed by any collector/UI.
  timezone: string;
  // Command used to launch the native Grok CLI. Defaults to "grok" (on PATH);
  // set an absolute path in config.json when it is not on PATH.
  grokCommand?: string;
  // Legacy — Grok used to run through WSL. It now runs natively (see
  // grokCommand), so these are accepted for back-compat but no longer consumed.
  wsl: {
    distro?: string;
    cwd: string;
    grokCommand: string;
  };
  planLabelFallback: Partial<Record<UsageProvider, string>>;
};
