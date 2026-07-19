# AI Usage Viewer

Local dashboard for subscription quota and usage surfaced by AI CLI tools. It is
for local OAuth/subscription usage screens, not API billing or token accounting.

> **Shared as-is.** This is a personal tool published without warranty or
> support. It uses provider-local structured interfaces where available and
> parses CLI output for the remaining providers, so a provider change can
> temporarily break a collector until its adapter is updated.
> Windows only.

## Supported Providers

- Claude Code: accessibility-mode `/usage` output and `claude auth status`
- OpenAI Codex: structured `account/rateLimits/read` through app-server, with
  the TUI footer as a fallback for older builds
- Antigravity CLI (`agy`): structured quota from its headless local service
- Grok Build CLI (native Windows binary): weekly footer plus `/usage show`

Collectors are best-effort because these are local provider interfaces rather
than public billing APIs. If a CLI is missing, logged out, times out, or changes
its response format, the app records `unavailable`, `error`, `stale`, or `drift`
instead of guessing quota values.

## Install

Requirements:

- **Windows** (some collectors drive interactive CLIs through pseudo-consoles)
- **Node.js 24 LTS** and npm
- The provider CLIs you want to track, **installed and logged in**. You only need
  the ones you use — Claude Code, OpenAI Codex, Antigravity (`agy`), Grok Build.

The first test, build, or start compiles a small local AGY process-containment
helper with Windows' built-in .NET Framework compiler. The generated executable
stays under ignored `.runtime/` state and is not published from the repository.
  Anything missing or logged out simply shows as unavailable.

```powershell
npm install
```

Then create your local config from the template and adjust it for your machine:

```powershell
copy config.example.json config.json
```

`config.json` is git-ignored, so your local paths and preferences stay private.

## Run

For normal use, build once and start the production server:

```powershell
npm run build
npm start
```

Open `http://127.0.0.1:4317/`. One localhost process serves both the built
dashboard and its `/api` routes, so production use does not need a Vite proxy or
a second terminal.

For UI development with Vite hot reload, start the local API:

```powershell
npm run api
```

In another terminal, start the dashboard:

```powershell
npm run dev
```

Open the Vite URL printed by the command, usually `http://127.0.0.1:5173/`.
Vite proxies `/api` to `http://127.0.0.1:4317`; both servers bind to localhost.

To collect once without opening the UI:

```powershell
npm run collect
```

This writes the privacy-filtered `data/usage-snapshot.json` and compatibility
report. Full provider terminal transcripts are kept only in memory while a
refresh runs; they are not persisted or exposed through the local API.

The production server also runs a quiet compatibility refresh every six hours
(override with `COMPATIBILITY_CHECK_INTERVAL_MINUTES`). Each successful result
must pass the normalized adapter contract before it can replace the last
verified rows. To run that canary immediately and receive a nonzero exit code on
drift, use:

```powershell
npm run compatibility:check
```

For provider-side changes that happen without a repository commit,
`.github/workflows/compatibility-canary.yml` defines a separate six-hour canary
on a dedicated, labeled self-hosted Windows runner. Once that runner is
provisioned with non-personal provider test accounts, drift automatically opens
or updates one GitHub issue and recovery closes it. Only the redacted report is
uploaded; provider transcripts are never persisted, and runtime snapshots are
removed from the runner workspace after each job. Personal OAuth sessions
should never be copied into
GitHub-hosted CI. The runner-owned baseline lives outside the checkout, and the
`compatibility-canary` GitHub environment should require review before a manual
baseline replacement can run.

## Desktop Shortcut

On Windows, generate icons and install the shortcut with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-desktop-shortcut.ps1
```

The shortcut starts the single production server locally, opens an Edge/Chrome
app window when available, and creates a startup shortcut for that server. If
the production dashboard is missing or older than its source files, the launcher
rebuilds it before starting. A versioned identity/fingerprint check replaces a
verified older backend automatically, repairs missing launcher state, and never
stops an unrelated process that happens to own the port. Logs go under
`data/logs/`.

## Configuration

Your settings live in `config.json` (copied from `config.example.json`). Edit it
to choose providers and local defaults:

- `enabledProviders`: providers to refresh
- `codex.collectDefault`: collect account limits from the default Codex model
- `agy.pinnedGroups`: optional filter for Antigravity model-group quota rows (e.g. `"Gemini Models"`); empty shows all
- `grokCommand`: path to the native Grok CLI (defaults to `grok` on PATH; set an absolute path if it isn't on PATH)
- `timezone`: IANA timezone used consistently for every displayed reset time
- `planLabelFallback`: labels used when a provider does not expose plan text

Machine-specific paths should stay in `config.json`; do not hardcode them in
source files.

## Data And Privacy

Runtime data is local and ignored by git:

- `data/usage-snapshot.json`
- `data/compatibility-report.json`
- `data/logs/*`

Snapshot and compatibility-report writes pass through redaction helpers for
email, organization, account, session, and credential-like identifiers. CLI
output can contain account metadata while a collector is running, so the app
caps it in memory and does not save or serve full transcripts. Keep `data/` out
of commits. Each Windows pseudo-terminal capture runs in its own short-lived,
hidden worker so native terminal handles are closed even if a provider exits
unexpectedly.

The app does not read token files, cookies, browser sessions, or private web
APIs. It only launches local CLI commands and parses their visible usage output.

## Verification

```powershell
npm test
npm run typecheck
npm run build
```

Expected coverage includes current and historical parser fixtures, completeness
checks, collector behavior, refresh locking, snapshot shape, and redaction.

Pull requests and pushes to `main` run an exact install, full dependency audit,
type-check, tests, production build, and an extracted-bundle smoke test on a
Windows GitHub Actions runner with Node.js 24. Pull requests receive no release
credentials.

After a `main` run passes, its exact tested commit is bundled and attested. A
separate workflow loaded from the protected default branch verifies that commit
is still current, creates the version tag from `package.json`, and publishes the
same immutable ZIP and checksum through the protected `release` environment.
Release logic is never loaded from a pushed tag. Bump `package.json` before the
next release; existing tags and assets are never moved or replaced. The bundle
contains the built dashboard, local server source, and locked npm manifests; it
still requires Windows, Node.js 24, and an `npm ci` after extraction. It is not
a portable installer or an automatic desktop updater yet. Verify a downloaded
archive with `gh attestation verify <archive> --repo heavy-tail/ai-usage-viewer`.

## Known Limitations

- A provider can still introduce genuinely new quota semantics that require a
  new adapter release. The app detects incomplete/unknown sections, retains the
  last verified values, and records a redacted compatibility report instead of
  guessing or silently dropping rows.
- Windows only: the collectors rely on Windows pseudo-consoles.
- Login, workspace trust, and update prompts can make provider collection
  unavailable or stale until handled locally.
- History charts, SQLite persistence, packaged desktop apps, and browser
  automation collectors are intentionally out of scope for this MVP.
- The compatibility report is ready for a separate repair worker to consume,
  but this repository does not yet run an autonomous code-writing agent or
  install releases automatically.
