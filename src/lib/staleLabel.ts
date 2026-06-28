// Single owner of the "stale - <detail>" status-label convention, used by both
// the write side (refresh marking rows stale) and the display side (UsageRow).
// Keeping build + display together prevents the two from drifting apart.

const STALE_PREFIX_RE = /^(?:stale\s*[-·]\s*)+/i;

function stripStalePrefix(label: string): string {
  return label.replace(STALE_PREFIX_RE, "").trim();
}

// The meaningful previous detail to preserve on a freshly-stale row, or
// undefined when there is nothing worth keeping (empty, bare "stale", or legacy
// pay-as-you-go text).
function staleDetail(statusLabel?: string): string | undefined {
  const detail = statusLabel ? stripStalePrefix(statusLabel) : undefined;
  if (!detail || /^stale$/i.test(detail) || /^pay-as-you-go\b/i.test(detail)) {
    return undefined;
  }
  return detail;
}

// Build the statusLabel stored for a row that has just gone stale. Never stacks
// "stale - stale - …" and drops legacy pay-as-you-go detail.
export function buildStaleStatusLabel(previousLabel?: string): string {
  const detail = staleDetail(previousLabel);
  return detail ? `stale - ${detail}` : "stale";
}

// What to render for a row's statusLabel in the UI.
export function displayStatusLabel(statusLabel?: string): string | undefined {
  if (!statusLabel) return undefined;
  const detail = stripStalePrefix(statusLabel);
  if (!detail || /^stale$/i.test(detail)) return "stale";
  if (!/^pay-as-you-go\b/i.test(detail)) return statusLabel;
  return /^stale\b/i.test(statusLabel) ? "stale" : undefined;
}
