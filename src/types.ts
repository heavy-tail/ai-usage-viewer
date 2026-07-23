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

  // Canonical timestamp when the provider supplies one. The UI can safely
  // infer older, unambiguous resetLabel shapes for consistent presentation.
  resetAt?: string;

  status: UsageStatus;
  statusLabel?: string;

  // A provider can explicitly block usage even when the percentage gauge is
  // still low (for example, a workspace spending limit). Keep that state
  // separate from provider-specific labels so the UI cannot hide it.
  blockingReason?: string;

  // Rows retained after a failed refresh remain useful, but must never look
  // like newly verified data.
  freshness?: "verified" | "stale";

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
  // Explicitly distinguishes configured providers from placeholders and
  // disabled collectors, including when the collector has no rows yet.
  enabled?: boolean;
  ok: boolean;
  state: CollectorState;
  // The displayed rows may be stale. Preserve the latest attempt's cause for
  // compatibility automation without exposing it in the primary UI.
  attemptState?: Exclude<CollectorState, "stale">;
  checkedAt: string;
  durationMs: number;
  // Compatibility diagnostics stay out of the primary UI, but make canary and
  // repair reports traceable to an exact adapter and observed output shape.
  adapterVersion?: string;
  formatFingerprint?: string;
  formatChanged?: boolean;
  // True when a previously observed actionable quota row disappears or a new
  // one appears. This catches partial parser success that a format hash alone
  // cannot reliably identify.
  rowInventoryChanged?: boolean;
  error?: string;
};

export type UsageSnapshot = {
  generatedAt: string;
  // The validated display timezone used for every provider reset time.
  timezone?: string;
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
  // IANA timezone used consistently for every reset timestamp in the UI.
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
