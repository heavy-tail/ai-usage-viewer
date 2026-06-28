export function Header({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <rect x="1" y="9" width="3.2" height="6" rx="1.2" fill="var(--text-faint)" />
            <rect x="6.4" y="5" width="3.2" height="10" rx="1.2" fill="var(--text-dim)" />
            <rect x="11.8" y="1" width="3.2" height="14" rx="1.2" fill="var(--text)" />
          </svg>
        </span>
        <h1>AI Usage</h1>
      </div>

      <div className="topbar-actions">
        <button
          className="btn"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <span className={`refresh-ico${refreshing ? " spin" : ""}`}>⟳</span>
          {refreshing ? "Refreshing…" : "Refresh all"}
        </button>
      </div>
    </header>
  );
}
