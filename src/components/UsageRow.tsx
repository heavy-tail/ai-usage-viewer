import type { UsageLimit } from "../types";
import { displayResetLabel } from "../lib/resetTime";
import { STATUS_TONE, fmtPercent, usageTone } from "../lib/usage";
import { displayStatusLabel } from "../lib/staleLabel";

export function UsageRow({
  limit,
  timeZone,
}: {
  limit: UsageLimit;
  timeZone?: string;
}) {
  const used = limit.usedPercent;
  const tone = toneForUsageRow(limit);
  const remaining = limit.remainingPercent;
  const width = Math.max(0, Math.min(100, used ?? 0));
  const statusLabel = displayStatusLabel(limit.statusLabel);
  const resetLabel = displayResetLabel(limit, { timeZone });
  const lastVerified = lastVerifiedLabel(limit, timeZone);

  if (limit.informational) {
    return (
      <div className="row row-info">
        <span className="row-scope">{limit.scope}</span>
        <span className="row-info-value">{fmtPercent(remaining)} left</span>
      </div>
    );
  }

  return (
    <div className="row">
      <div className="row-head">
        <span className="row-scope">{limit.scope}</span>
        {limit.window && <span className="chip">{limit.window}</span>}
        <span className="row-spacer" />
        <span className="row-used">{fmtPercent(used)} used</span>
      </div>
      <div className={`bar tone-${tone}`}>
        <div className="bar-fill" style={{ width: `${width}%` }} />
      </div>
      <div className="row-meta">
        <span className={limit.blockingReason ? "row-blocking" : undefined}>
          {limit.blockingReason ??
            (remaining != null ? `${fmtPercent(remaining)} left` : "")}
        </span>
        <span className="row-meta-right">
          {statusLabel && (
            <span className="row-statuslabel">{statusLabel}</span>
          )}
          {resetLabel && (
            <span className="row-reset" title={limit.resetLabel}>
              {resetLabel}
            </span>
          )}
          {lastVerified && (
            <span className="row-freshness">{lastVerified}</span>
          )}
        </span>
      </div>
    </div>
  );
}

export function toneForUsageRow(limit: UsageLimit) {
  if (limit.status === "exhausted" || limit.blockingReason) {
    return STATUS_TONE.exhausted;
  }
  return limit.usedPercent != null
    ? usageTone(limit.usedPercent)
    : STATUS_TONE[limit.status];
}

export function lastVerifiedLabel(
  limit: Pick<UsageLimit, "checkedAt" | "freshness">,
  timeZone?: string
): string | undefined {
  if (limit.freshness !== "stale") return undefined;
  const checkedAt = new Date(limit.checkedAt);
  if (Number.isNaN(checkedAt.valueOf())) return "Last verified earlier";
  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      ...(timeZone ? { timeZone } : {}),
    }).format(checkedAt);
    return `Last verified ${formatted}`;
  } catch {
    return "Last verified earlier";
  }
}
