# AI Usage Viewer

Local dashboard for subscription quota and usage surfaced by AI CLI tools. It is
for local OAuth/subscription usage screens, not API billing or token accounting.

> **Shared as-is.** This is a personal tool published without warranty or
> support. It reads usage by parsing each CLI's on-screen output, so a provider
> changing its CLI can temporarily break a collector until its parser is updated.
> Windows only.

## Supported Providers

- Claude Code: accessibility-mode `/usage` output and `claude auth status`
- OpenAI Codex: structured `account/rateLimits/read` through app-server, with
  the TUI footer as a fallback for older builds
- Antigravity CLI (`agy`): `/quota`
- Grok Build CLI (native Windows binary): weekly footer plus `/usage show`

Collectors are best-effort because these CLIs expose usage through interactive
terminal UIs. If a CLI is missing, logged out, times out, or changes output
format, the app records `unavailable`, `error`, `stale`, or `drift` instead of
guessing quota values.

## Install

Requirements:

- **Windows** (the collectors drive the CLIs through Windows pseudo-consoles)
- **Node.js 24 LTS** and npm
- The provider CLIs you want to track, **installed and logged in**. You only need
  the ones you use — Claude Code, OpenAI Codex, Antigravity (`agy`), Grok Build.
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

This writes `data/usage-snapshot.json` and redacted raw transcripts under
`data/raw/`.

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
uploaded; raw CLI transcripts stay off GitHub and are removed from the runner
workspace after each job. Personal OAuth sessions should never be copied into
GitHub-hosted CI.

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
- `planLabelFallback`: labels used when a provider does not expose plan text

Machine-specific paths should stay in `config.json`; do not hardcode them in
source files.

## Data And Privacy

Runtime data is local and ignored by git:

- `data/usage-snapshot.json`
- `data/compatibility-report.json`
- `data/raw/*.txt`
- `data/logs/*`

Snapshot and raw-output writes pass through redaction helpers for email,
organization, account, and session-like identifiers. Raw CLI output can still
contain account metadata before redaction, so keep `data/` out of commits.

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

Pull requests and pushes to `main` run an exact install, dependency audit,
type-check, test, and production-build check on a Windows GitHub Actions runner
with Node.js 24.

After those checks pass, `main` and `v*` tag runs also upload a Windows/Node
deployment bundle to the workflow run. A `v*` tag publishes the verified bundle
in a GitHub Release. The bundle contains the built dashboard, local server
source, and locked npm manifests; it still requires Windows, Node.js 24, and an
`npm ci` after extraction. Release tags must match `package.json`, archives are
reproducible and boot-smoke-tested, and an existing release asset is never
silently replaced. It is not a portable installer or an automatic desktop
updater yet. Release runs include a SHA-256 checksum and GitHub build
provenance; verify a downloaded archive with `gh attestation verify <archive>
--repo heavy-tail/ai-usage-viewer` before installing it.

## Known Limitations

- A provider can still introduce genuinely new quota semantics that require a
  new adapter release. The app detects incomplete/unknown sections, retains the
  last verified values, and records a redacted compatibility report instead of
  guessing or silently dropping rows.
- Windows only — the collectors rely on Windows pseudo-consoles.
- Login, workspace trust, and update prompts can make provider collection
  unavailable or stale until handled locally.
- History charts, SQLite persistence, packaged desktop apps, and browser
  automation collectors are intentionally out of scope for this MVP.
- The compatibility report is ready for a separate repair worker to consume,
  but this repository does not yet run an autonomous code-writing agent or
  install releases automatically.
