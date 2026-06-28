# AI Usage Viewer

Local dashboard for subscription quota and usage surfaced by AI CLI tools. It is
for local OAuth/subscription usage screens, not API billing or token accounting.

> **Shared as-is.** This is a personal tool published without warranty or
> support. It reads usage by parsing each CLI's on-screen output, so a provider
> changing its CLI can temporarily break a collector until its parser is updated.
> Windows only.

## Supported Providers

- Claude Code: `/usage` and `claude auth status`
- OpenAI Codex: TUI footer from `codex --no-alt-screen`
- Antigravity CLI (`agy`): `/quota`
- Grok Build CLI (native Windows binary): quota read from the launch footer

Collectors are best-effort because these CLIs expose usage through interactive
terminal UIs. If a CLI is missing, logged out, times out, or changes output
format, the app records `unavailable`, `error`, `stale`, or `drift` instead of
guessing quota values.

## Install

Requirements:

- **Windows** (the collectors drive the CLIs through Windows pseudo-consoles)
- **Node.js 18+** and npm
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

Start the local API:

```powershell
npm run api
```

In another terminal, start the dashboard:

```powershell
npm run dev
```

Open the Vite URL printed by the command, usually `http://127.0.0.1:5173/`.
The API listens on `http://127.0.0.1:4317` and is bound to localhost.

> **Supported run mode:** `npm run dev` together with `npm run api` (or the
> desktop shortcut, which starts both). `npm run build` / `npm run preview` are
> for type-checking and bundle inspection only — the built bundle does not proxy
> `/api`, so a static `dist/` cannot reach the collector API on its own. If a
> hosted build is ever needed, serve `dist/` from `src/server.ts` or front both
> with a reverse proxy.

To collect once without opening the UI:

```powershell
npm run collect
```

This writes `data/usage-snapshot.json` and redacted raw transcripts under
`data/raw/`.

## Desktop Shortcut

On Windows, generate icons and install the shortcut with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-desktop-shortcut.ps1
```

The shortcut starts the API and dashboard locally, opens an Edge/Chrome app
window when available, and creates a startup shortcut for the local server. Logs
go under `data/logs/`.

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

Expected coverage includes parser fixtures, collector behavior, refresh locking,
snapshot shape, and redaction.

## Known Limitations

- CLI/TUI output can drift when provider CLIs update.
- Windows only — the collectors rely on Windows pseudo-consoles.
- Login, workspace trust, and update prompts can make provider collection
  unavailable or stale until handled locally.
- History charts, SQLite persistence, packaged desktop apps, browser automation
  collectors, and background refresh are intentionally out of scope for this
  MVP.
