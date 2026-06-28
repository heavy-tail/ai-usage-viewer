import type { CollectorHealth, UsageLimit, UsageProvider } from "../types";
import { PROVIDER_LABEL } from "../lib/usage";
import { UsageRow } from "./UsageRow";

const PROVIDER_LOGO: Record<UsageProvider, string> = {
  claude: "/provider-logos/claude.svg",
  codex: "/provider-logos/codex.svg",
  agy: "/provider-logos/agy.svg",
  grok: "/provider-logos/grok.svg",
};

export function ProviderCard({
  provider,
  limits,
  health,
  plan,
  refreshing,
  queued,
  refreshDisabled,
  onRefresh,
}: {
  provider: UsageProvider;
  limits: UsageLimit[];
  health?: CollectorHealth;
  plan?: string;
  refreshing?: boolean;
  queued?: boolean;
  refreshDisabled?: boolean;
  onRefresh?: () => void;
}) {
  const statusMessage = displayHealthMessage(health, limits.length > 0);
  const refreshLabel = refreshing ? "Refreshing…" : queued ? "Queued" : "Refresh";

  return (
    <section className="card">
      <header className="card-head">
        <span className="provider-logo" aria-hidden>
          <img src={PROVIDER_LOGO[provider]} alt="" />
        </span>
        <div className="card-title">
          <div className="card-name">{PROVIDER_LABEL[provider]}</div>
          <div className="card-sub">
            {plan && <span className="plan">{plan}</span>}
          </div>
        </div>
        {onRefresh && (
          <button
            className="btn btn-compact"
            onClick={onRefresh}
            disabled={refreshDisabled}
            title={`Refresh ${PROVIDER_LABEL[provider]}`}
          >
            <span className={`refresh-ico${refreshing ? " spin" : ""}`}>⟳</span>
            {refreshLabel}
          </button>
        )}
      </header>

      {statusMessage && <div className="card-error">{statusMessage}</div>}

      <div className="card-body">
        {limits.length === 0 ? (
          <div className="empty">No rows.</div>
        ) : (
          limits.map((l) => <UsageRow key={l.id} limit={l} />)
        )}
      </div>
    </section>
  );
}

function displayHealthMessage(
  health: CollectorHealth | undefined,
  hasRows: boolean
): string | undefined {
  if (!health || health.ok) return undefined;
  if (!hasRows) return undefined;
  if (health.state === "stale") return undefined;
  if (health.state === "drift") return "CLI output changed; usage parsing needs an update.";
  if (health.state === "error") return "Refresh failed; showing available saved data.";
  if (health.state === "unavailable") return "CLI is currently unavailable.";
  return undefined;
}
