# AI Usage Viewer Spec

## Purpose

Build a lightweight local dashboard that aggregates subscription usage/quota
information from local CLI tools:

- Claude Code
- OpenAI Codex
- Antigravity CLI (`agy`)
- Grok Build CLI (native Windows binary)

This dashboard is for OAuth/subscription usage surfaces, not API billing or API
token usage.

## Confirmed Data Sources

### Claude

Source:

```bash
claude --ax-screen-reader
/usage
```

Confirmed output includes:

- Current session usage percent
- Current session reset time
- Current week all-models usage percent
- Current week all-models reset time
- Zero or more model-specific weekly usage percentages (for example, Fable)
- Usage credits percent when present
- Local contribution notes

Example observed values:

```text
Current session
0% used
Resets 1:29am (Asia/Seoul)

Current week (all models)
6% used
Resets Jun 9, 4pm (Asia/Seoul)

Current week (Fable)
6% used

Usage credits
11% used
```

Auth/status source:

```bash
claude auth status
```

Confirmed output includes:

- `loggedIn`
- `authMethod`
- `email`
- `orgId`
- `orgName`
- `subscriptionType`, currently `max`

### Codex

Primary source:

```text
codex app-server
initialize -> initialized -> account/rateLimits/read
```

The app-server returns structured, versioned rate-limit buckets with primary,
secondary, and optional individual spend-control windows. No terminal layout
parsing is required on this path.

Fallback source for older or incompatible Codex builds:

```bash
codex --no-alt-screen
```

Confirmed footer examples:

```text
gpt-5.5 xhigh fast · Context 100% left · 5h 97% left · weekly 76% left
gpt-5.3-codex-spark xhigh · Context 100% left · 5h 96% left · weekly 76% left
```

Auth/status source:

```bash
codex login status
```

Confirmed output:

```text
Logged in using ChatGPT
```

Fallback implementation note:

- Start Codex with `--no-alt-screen`.
- Skip/update prompts if shown.
- Parse the latest footer line containing `Context`, `5h`, and `weekly`.
- For model-specific entries, run Codex with `-m <model>`.

### Antigravity (`agy`)

Source:

```bash
agy
/quota
```

Confirmed output includes model quota rows:

```text
Model Quota

Gemini 3.5 Flash (Medium)
███████████ ███████████ ███████████ ███████████ ███████████ 100%
Quota available

Gemini 3.5 Flash (High)
███████████ ███████████ ███████████ ███████████ ███████████ 100%
Quota available

Claude Sonnet 4.6 (Thinking)
███████████ ███████████ ███████████ ███████████ ███████████ 100%
Quota available

GPT-OSS 120B (Medium)
███████████ ███████████ ███████████ ███████████ ███████████ 100%
Quota available
```

Confirmed TUI header includes:

- User email
- Plan, for example `Google AI Pro`
- Current selected model

Implementation note:

- The CLI may ask for workspace trust on first run.
- `/quota` can be invoked as `/usage` alias behavior was not confirmed for
  `agy`; use `/quota`.
- Collect all pages of the quota panel by scrolling/page-down until the end.

### Grok

Current source:

```bash
grok --no-alt-screen
/usage show
```

Confirmed output:

```text
[stable] Weekly limit left: 17%
Weekly limit: 83%  Next reset: July 31, 16:00 PT
```

Implementation note:

- Launch the configured native `grokCommand` (default `grok` on PATH).
- Treat the weekly footer as remaining quota and the current `/usage show`
  weekly value as used quota, verifying that they add to 100. Legacy monthly
  detail remains supported as a separate row.
- If the detail interaction changes but the weekly footer is complete, publish
  that verified row rather than inventing monthly data.

## Non-Goals

- Do not use browser extensions.
- Do not automate browser sessions.
- Do not call private web APIs directly.
- Do not handle API billing dashboards.
- Do not require Gemini CLI; Antigravity already covers the needed Gemini quota
  rows.
- Do not store OAuth tokens, cookies, or credentials.

## Architecture

Use a local app with a small backend and a dashboard frontend.

```text
Dashboard UI
  -> local backend HTTP API
    -> collector runner
      -> structured local protocol or isolated CLI PTY session
      -> parsers
      -> normalized snapshot
      -> JSON file or SQLite
```

Recommended MVP stack:

- Node.js backend
- `node-pty` for interactive TUI collection
- TypeScript parsers
- `data/usage-snapshot.json` as the first persistence layer
- Vite/React or Next.js frontend
- Recharts or plain progress bars for visualization

SQLite can be added after the MVP if historical charts are needed.

The implementation must treat CLI/TUI parsing as the primary reliability risk.
Before scraping a TUI, each collector should check for a non-interactive or JSON
mode and prefer it when it exposes the same quota data. If only TUI output is
available, parse conservatively and fail loudly on unrecognized formats instead
of displaying guessed quota values.

## Configuration

Machine-specific paths, optional provider lists, and fallback labels should live
in a small config file instead of being hardcoded.

MVP default path:

```text
config.json
```

Suggested shape:

```ts
type AppConfig = {
  enabledProviders: UsageProvider[];
  codex: {
    collectDefault: boolean;
    additionalModelsForContext: string[];
  };
  agy: {
    pinnedGroups: string[]; // model-group names; empty means show all rows
  };
  timezone: string; // used only for future resetAt normalization
  grokCommand?: string;
  planLabelFallback: Partial<Record<UsageProvider, string>>;
};
```

Default provider behavior:

- Enable `claude`, `codex`, `agy`, and `grok`.
- Collect Codex account limits once from the configured default model.
- Show all Agy quota rows unless `agy.pinnedGroups` is set.
- Use source-derived plan labels where possible; use config fallbacks only when
  the source does not expose a plan label.

## Normalized Data Model

Use one normalized shape for all displayed quota/limit rows.

```ts
type UsageProvider = "claude" | "codex" | "agy" | "grok";

type UsageStatus =
  | "available"
  | "warning"
  | "exhausted"
  | "unknown"
  | "unavailable"
  | "error"
  | "drift";

type UsageLimit = {
  id: string;
  provider: UsageProvider;
  providerLabel: string;
  planLabel?: string;
  accountLabel?: string;

  // Example: "Current session", "Current week (all models)",
  // "gpt-5.5 xhigh fast", "Gemini 3.5 Flash (High)", "Free credits".
  scope: string;

  // Example: "session", "5h", "weekly", "monthly", "model-quota".
  window?: string;

  usedPercent?: number;
  remainingPercent?: number;
  resetLabel?: string;

  // MVP should display resetLabel only. resetAt is optional and must remain
  // unset until timezone/year inference is implemented explicitly.
  resetAt?: string;

  status: UsageStatus;
  statusLabel?: string;
  informational?: boolean;

  sourceCommand: string;
  sourceText: string;
  checkedAt: string;
  error?: string;
};

type UsageSnapshot = {
  generatedAt: string;
  collectors: {
    provider: UsageProvider;
    ok: boolean;
    state: "ok" | "unavailable" | "error" | "drift" | "stale";
    checkedAt: string;
    durationMs: number;
    error?: string;
  }[];
  limits: UsageLimit[];
};
```

Percent normalization:

- If source says `N% used`, store `usedPercent = N` and
  `remainingPercent = 100 - N`.
- If source says `N% left` or `N% remaining`, store
  `remainingPercent = N` and `usedPercent = 100 - N`.
- If source says `100% Quota available`, treat it as
  `remainingPercent = 100`, `usedPercent = 0`.

Status rules:

- `exhausted`: remaining percent is `0`, or source includes exhausted/limit hit.
- `warning`: used percent >= `80`, or remaining percent <= `20`.
- `available`: known percent and not warning/exhausted.
- `unknown`: parse failed or no percent.
- `unavailable`: CLI is not installed, provider is disabled, or the CLI reports
  the user is not logged in.
- `error`: collector failed because of timeout, process failure, or unexpected
  runtime behavior.
- `drift`: collector ran, but the output format was not recognized. This should
  be treated as a parser regression and must not render guessed values.

Rows with `informational: true` do not affect warning/exhausted status. Use this
for values such as Codex context remaining, where low remaining context may be
useful but is not a subscription quota.

## Collector Behavior

Each collector should return:

- Raw cleaned terminal output
- Parsed `UsageLimit[]`
- Duration
- Error state, if any
- Adapter version and privacy-safe format fingerprint

Collectors should not block the whole refresh. If one provider fails, the
dashboard should show stale data or the provider's failure state while others
update.

Collector failure handling:

- If a CLI is missing or not authenticated, return `unavailable`.
- If a process times out or exits unexpectedly, return `error`.
- If output is captured but required parser anchors are missing, return `drift`.
- Persist raw output for `error` and `drift` cases to support parser fixes.
- Do not coerce incomplete parser results into real quota rows.
- Reject duplicate IDs, impossible percentages, cross-provider rows, and
  unrecognized percentage-bearing sections before replacing verified data.

Auth and plan status should be cached separately from quota refreshes because it
rarely changes. The refresh flow may reuse cached account labels unless the user
explicitly requests an auth/status refresh.

### PTY Runner

Provide a shared PTY helper:

```ts
type PtyStep = {
  send?: string;
  waitFor?: RegExp | string;
  timeoutMs?: number;
};

type RunPtyOptions = {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  steps: PtyStep[];
  totalTimeoutMs: number;
};
```

Responsibilities:

- Spawn process with PTY.
- Capture all output.
- Capture raw transcript bytes/text before cleanup.
- Build a cleaned transcript for parser input.
- Send commands after expected prompts appear.
- Kill process on timeout.
- Return raw and cleaned output.

ANSI stripping:

- Use a library such as `strip-ansi`, but do not rely on it alone.
- Normalize carriage returns, repeated redraws, cursor movements, and overwritten
  lines before parsing.
- Add golden fixtures that include raw ANSI-heavy PTY output from each CLI.
- Include duplicate-frame detection for paged TUI panels.

### Claude Collector

Flow:

```text
probe claude --help and prefer --ax-screen-reader
spawn claude
wait for prompt
send "/usage\r"
wait for complete session and all-model weekly values
allow optional model-specific and credits rows to settle
send escape
send "/exit\r"
parse output
```

Parser patterns:

```text
Current session\s+(\d+)% used\s+Resets ([^\n]+)
Current week \(all models\)\s+(\d+)% used\s+Resets ([^\n]+)
Current week \(([^)]+)\)\s+(\d+)% used
Usage credits\s+(\d+)% used
```

Also run:

```bash
claude auth status
```

Use this for account and plan labels.

### Codex Collector

Primary flow:

```text
spawn codex app-server over stdio
send initialize
send initialized
send account/rateLimits/read
strictly validate every returned bucket/window
normalize structured percentages and reset timestamps
```

If app-server is unavailable or its protocol/method is unsupported, fall back
silently to the terminal flow. A successfully returned but unrecognized schema
fails closed instead, because the smaller terminal view could hide a new quota:

```text
spawn codex --no-alt-screen
if TERM warning appears, send "y\r"
if update prompt appears, choose "Skip"
wait for footer containing "Context"
send "/quit\r"
parse footer
```

Recommended model collection:

```ts
const codex = {
  collectDefault: true,
  additionalModelsForContext: []
};
```

Codex `5h` and `weekly` limits are account-level limits in the observed footer.
Collect them once from the configured default model. Do not create duplicate
`5h`/`weekly` rows by spawning Codex once per model.

If additional model sessions are later configured, use them only to capture
model-specific informational values such as `Context`. They should not create
additional account-wide quota rows unless a future CLI version exposes truly
model-specific quota data.

Parser pattern:

```text
(.+?) · Context (\d+)% left · 5h (\d+)% left · weekly (\d+)% left
```

Output rows:

- One `UsageLimit` for context remaining
- One `UsageLimit` for 5h limit
- One `UsageLimit` for weekly limit

Mark context rows with `informational: true`. Dashboard cards can show context as
secondary metadata instead of a quota warning source.

### Agy Collector

Flow:

```text
spawn agy
if workspace trust prompt appears, select "Yes"
wait for prompt
send "/quota\r"
wait for "Model Quota"
page down until no new model rows appear
send escape
send "/exit\r"
parse output
```

Parser approach:

- Use a 3-line heuristic instead of a broad model-name regex.
- A row starts with a plausible model name line.
- The next non-empty line with a trailing percent is the quota line.
- The next non-empty line is the status label, for example `Quota available`.
- Continue paging until the cleaned panel frame repeats or no new model names
  are found after a page-down.
- If the model/bar/status sequence is broken, mark the collector as `drift`.

Known model-name prefixes include `Gemini`, `Claude`, `GPT`, and `GPT-OSS`, but
the parser should not use a catch-all prefix that matches arbitrary UI text.

Output rows:

```ts
{
  provider: "agy",
  providerLabel: "Antigravity",
  planLabel: sourcePlanLabel ?? config.planLabelFallback.agy,
  scope: modelName,
  window: "model-quota",
  remainingPercent: percent,
  usedPercent: 100 - percent,
  statusLabel: statusLine
}
```

### Grok Collector

Flow:

```text
spawn <config.grokCommand ?? "grok"> --no-alt-screen
wait for "Weekly limit left"
send "/usage " and accept the highlighted "show" action
wait for "Weekly limit" or legacy "Monthly limit"
send "/quit\r"
parse output
```

Parser patterns:

```text
Weekly limit left:\s*(\d+)%
Weekly limit:\s*(\d+)%
Monthly limit:\s*(\d+)%
Next reset:\s*([^\n]+)
```

Output row:

```ts
[
  limitFromRemaining({ scope: "Weekly limit", window: "weekly", remainingPercent: weeklyLeft }),
  limitFromUsed({ scope: "Monthly limit", window: "monthly", usedPercent: monthlyUsed, resetLabel: resetText })
]
```

## Dashboard UI

Main screen:

- Header
  - Title: `AI Usage`
  - Last refresh time
  - `Refresh all` button
  - Collector health summary

- Provider cards
  - Claude Max
  - Codex
  - Antigravity
  - Grok

Card display rules:

- Show the most important rows per provider.
- Use progress bars based on used percent.
- Show both used and remaining when useful.
- Keep parser and raw-output diagnostics outside the normal user interface.

Colors:

- Green: available
- Yellow: warning
- Red: exhausted
- Gray: unknown usage

Failure display rules:

- When a refresh is unavailable, errors, or detects format drift, keep showing
  the last contract-verified rows without presenting a test or repair workflow
  to the user.
- If a provider has never produced verified rows, omit its empty card from the
  normal dashboard.
- Preserve the machine-readable attempt state and redacted diagnostics in the
  local snapshot/compatibility report for monitoring and repair tooling.
- The user sees a replacement only after the updated adapter has passed its
  parser contract and full compatibility check.

Example card rows:

```text
Claude Max
Current session          0% used      resets 1:29am
Weekly all models        6% used      resets Jun 9 4pm
Weekly Sonnet only       0% used

Codex
gpt-5.5 5h               3% used      97% left
gpt-5.5 weekly           24% used     76% left
Context                  info         100% left

Antigravity
Gemini 3.5 Flash High    0% used      100% available
Claude Sonnet Thinking   0% used      100% available
GPT-OSS 120B Medium      0% used      100% available

Grok
Free credits             44% used     resets Jun 30, 16:00 PT
```

## API Endpoints

MVP backend endpoints:

```text
GET  /api/snapshot
GET  /api/identity
POST /api/refresh
POST /api/refresh/:provider
GET  /api/raw/:provider
```

Behavior:

- `GET /api/snapshot`: returns the latest snapshot.
- `POST /api/refresh`: runs all collectors in parallel with individual
  timeouts.
- `POST /api/refresh/:provider`: runs one collector.
- `GET /api/raw/:provider`: returns latest cleaned, stored debug output. This
  output should be redacted unless debugging mode explicitly disables redaction.

Refresh locking:

- Use a global refresh mutex for the MVP.
- If a refresh is already running, return the in-progress state or reject with a
  clear `409` response instead of starting duplicate PTY sessions.
- Provider-specific refreshes must also respect the same lock unless a later
  implementation adds safe per-provider locking.
- The API should expose collector states so the UI can distinguish `stale`,
  `unavailable`, `error`, and `drift`.

## Refresh Policy

Default:

- Manual refresh button.
- Refresh automatically when the dashboard opens.
- The production server runs a compatibility refresh every six hours without
  overlapping a user-initiated refresh.

Timeouts:

- Claude: 60 seconds (includes slow MCP startup and optional usage credits)
- Codex: 8 seconds for app-server, 40 seconds for terminal fallback
- Agy: 30 seconds
- Grok: 30 seconds

Do not refresh faster than once per minute automatically. The six-hour monitor
skips while a manual refresh is running. A workspace-scoped Windows named-pipe
mutex also prevents a separate collector process from driving the same CLIs
concurrently; `data/refresh.lock` is diagnostic metadata, not the mutex itself.

A separate scheduled compatibility workflow may run the same full check every
six hours on a dedicated self-hosted Windows canary. That runner uses isolated
non-personal test accounts, uploads only the redacted compatibility report,
opens one tracking issue on drift, and closes it after recovery. Personal OAuth
state and raw transcripts must never be sent to GitHub-hosted runners.

## Persistence

MVP:

```text
config.json
data/usage-snapshot.json
data/compatibility-report.json
data/raw/claude.txt
data/raw/codex-default.txt
data/raw/agy.txt
data/raw/grok.txt
```

Add `data/` to `.gitignore` during implementation. Raw files may contain account
labels or other personal metadata even after redaction. Store cleaned/redacted
debug transcripts, not credential files or full auth blobs.

Optional later SQLite schema:

```sql
create table snapshots (
  id integer primary key autoincrement,
  generated_at text not null,
  json text not null
);

create table usage_limits (
  row_id integer primary key autoincrement,
  limit_id text not null,
  snapshot_id integer not null,
  provider text not null,
  provider_label text not null,
  plan_label text,
  account_label text,
  scope text not null,
  window text,
  used_percent real,
  remaining_percent real,
  reset_label text,
  reset_at text,
  status text not null,
  status_label text,
  checked_at text not null,
  source_command text not null,
  source_text text,
  error text,
  foreign key (snapshot_id) references snapshots(id)
);

create index idx_usage_limits_snapshot on usage_limits(snapshot_id);

create unique index idx_usage_limits_snap_limit
  on usage_limits(snapshot_id, limit_id);
```

## Security

- Do not read or expose auth token files.
- Do not log secrets.
- Store only CLI output relevant to usage/quota.
- Apply redaction before storing raw files when possible. At minimum, redact
  email addresses, organization IDs, and obvious account identifiers from stored
  raw output unless a debugging mode explicitly disables redaction.
- Redact email addresses in UI if a privacy setting is enabled.
- Add `data/` to `.gitignore`; snapshots and raw outputs are local runtime data.
- Keep the server bound to `127.0.0.1`.
- Do not expose the backend on the LAN.

## Test Plan

Parser unit tests:

- Claude sample `/usage` output.
- Current Claude model-specific and credits output.
- Codex structured app-server payloads plus footer fallback samples.
- Agy quota sample with multiple model rows.
- Grok usage sample.
- ANSI-heavy terminal redraw samples using raw PTY transcripts.
- Drift samples where required anchors are missing.
- Completeness samples where a valid section appears beside an unknown quota.
- Adapter contract and format-fingerprint tests.
- Redaction samples for email/account-like values.

Collector integration tests:

- Mock PTY output and verify command steps.
- Timeout handling.
- Partial parse handling.
- Missing CLI / unauthenticated CLI handling.
- Refresh lock behavior.
- One collector failure does not fail full refresh.

Manual validation:

1. Run `POST /api/refresh`.
2. Confirm all providers have rows.
3. Confirm values match CLI output.
4. Confirm stale/failed provider state is visible.
5. Confirm no auth tokens are present in snapshot/raw output.

## Implementation Milestones

### Milestone 1: CLI parsers

- Implement normalized types.
- Implement ANSI cleanup.
- Implement terminal redraw normalization.
- Implement parser tests for Claude, Codex, Agy, Grok.
- Implement `drift` detection for unrecognized formats.
- Implement storage redaction helpers.

### Milestone 2: Collector runner

- Add `config.json` loading with safe defaults.
- Add PTY runner.
- Implement collectors.
- Add refresh locking.
- Write `data/usage-snapshot.json`.
- Write redacted raw outputs under `data/raw/`.
- Provide a CLI command:

```bash
npm run collect
```

### Milestone 3: Local API

- Add `GET /api/snapshot`.
- Add `POST /api/refresh`.
- Add provider-specific refresh.

### Milestone 4: Dashboard UI

- Add provider cards.
- Add detailed table.
- Add refresh and health status.
- Add raw output debug drawer.

### Milestone 5: Hardening

- Add timeouts.
- Add stale data markers.
- Add privacy redaction.
- Add optional scheduled refresh.
- Add optional SQLite history using the surrogate-key schema.
- Add `resetAt` normalization only after timezone/year inference is specified.

## Open Questions

- Codex additional models: default to none for MVP. Add
  `additionalModelsForContext` only if the user wants model-specific context
  metadata.
- Agy rows: default to all rows. Support a pinned model list in config.
- History retention: latest snapshot JSON is enough for MVP. Add SQLite only
  when charts are needed.
- Tauri: defer. Start as a localhost web app; wrap later only if a
  tray-resident app is needed.
- `resetAt`: defer ISO normalization until timezone/year inference is specified.

## Appendix A: Review Disposition

This appendix records how review feedback was incorporated into the main spec.
The functional requirements are defined in the sections above.

Accepted into the main spec:

- TUI parsing is the primary reliability risk.
- Prefer non-interactive or JSON output when a CLI exposes equivalent quota data.
- Add explicit `drift`, `error`, and `unavailable` states.
- Treat Codex `5h` and `weekly` as account-wide rows collected once.
- Mark Codex `Context` as informational.
- Keep `resetAt` optional for MVP and display raw `resetLabel`.
- Add a refresh mutex.
- Keep provider command paths and fallback labels in `config.json`.
- Redact stored raw output and add `data/` to `.gitignore`.
- Fix the optional SQLite schema with a surrogate `row_id` and stable
  `limit_id`.
- Replace the Agy catch-all regex with a 3-line parser heuristic and duplicate
  frame detection.

Adjusted rather than fully accepted:

- SQLite remains optional and post-MVP. The corrected schema is documented only
  for the later history feature.
- Background compatibility refresh runs every six hours and never overlaps a
  manual or separate-process refresh.
- Additional Codex model collection is not part of the default MVP. It is limited
  to optional context metadata if enabled later.
