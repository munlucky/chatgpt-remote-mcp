# ChatGPT Remote MCP

A self-hosted MCP development server for a Windows PC running Docker Compose, with
Cloudflare Tunnel, OAuth, bounded file operations, process management and persistent
usage telemetry. The server image is built from this repository's local source and
npm lockfile; GitHub CI/CD is not required for the intended deployment model.

## Setup

1. Copy `.env.example` to `.env` or run `scripts/setup-keys.ps1`.
2. Run `scripts/setup-keys.ps1` to generate independent OAuth approval and probe secrets when they are empty or missing.
3. Replace placeholder host paths, public domain and Cloudflare tunnel token in `.env`.
4. Configure the tunnel origin to `http://localhost:2999` in your Cloudflare Zero Trust dashboard.
5. (Optional) Run `scripts/verify-env.ps1` to validate Docker status, paths, and environment settings.
6. Run `scripts/start.ps1` from PowerShell.
7. Run `scripts/get-approval-key.ps1` to view/copy the OAuth approval key.
8. Connect your MCP client to the configured public URL followed by `/mcp`.

> **Installing on another PC?** See the step-by-step [Multi-machine Setup Guide](docs/multi-machine-setup.md) for instructions on creating new Cloudflare tunnels and managing multiple machines.

`.env.example` contains examples only. Actual paths, mount aliases, container names,
volume names, timezone and credentials belong in ignored `.env`. Preserve existing
volume names during migration to retain OAuth and user data. The setup helper does
not register OAuth clients and never prints generated secrets.

OAuth access/refresh defaults are 1 hour / 30 days. Dynamic client registrations are
bounded by `MCP_OAUTH_MAX_REGISTERED_CLIENTS` (default 256); when capacity is reached,
the oldest clients with no retained token state are pruned before an active client is
ever removed.

## Development and verification

Use the Windows PC and Docker Desktop as the verification/deployment surface:

- `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `npm audit --omit=dev`
- `npm run integration:docker`: isolated Linux Nginx/typecheck/tests/build/audit/benchmark verification; it does **not** inspect the running deployment by default
- `npm run post-deploy:verify`: current source/image identity, OAuth/proxy policy, runtime commit-helper parity, authenticated diagnostics and public MCP probe checks
- `npm run integration:docker -- --live` or `MCP_VERIFY_LIVE=1 npm run integration:docker`: isolated verification followed by the live checks
- `scripts/usage-report.ps1 -Hours 24`: aggregate actual usage, excluding only authenticated probes carrying the independent probe secret

Request success and command success are separate observations. The bounded usage
log records `process_started` and `process_terminal` metadata independently of the
HTTP response, including request/session/boot IDs, exit code, timeout and signal.
It never records command bodies, paths, output contents or tokens. Missing terminal
metadata does not authorize a retry; durable continuity receipts remain authoritative.
Reports separate client classes inferred from User-Agent (not authenticated identity)
and support exact, start-inclusive/end-exclusive timestamp boundaries:

```bash
node scripts/usage-report.mjs /var/log/mcp-usage --since 2026-10-09T00:00:00+09:00 --until 2026-10-10T00:00:00+09:00
```

The live verifier also checks the public tool catalog for all 25 tools, the three
continuity tools and execution tracking inputs, and returns its catalog digest.
Server catalog verification does not prove that a client's connector catalog has
refreshed. Resolve connector catalog differences without modifying project tasks.

Cloudflare's canonical client address is accepted only at the local cloudflared →
Nginx trust boundary. Nginx rewrites `X-Forwarded-For` to that single normalized
address and Express trusts only the immediate Nginx hop, keeping OAuth rate limits
separate between external clients.

The MCP server publishes 25 tools, including bounded `read_files` batching, generic
`publish_file` artifact delivery, and three durable continuity tools:
`get_work_context`, `checkpoint_work`, and `complete_work`.

### Published artifacts

`publish_file` snapshots a regular file into process-scoped temporary storage and
returns a short-lived capability URL plus an MCP `resource_link`. The download route
does not expose the source path and does not require a bearer token; possession of the
unguessable URL grants access until its TTL expires or the server restarts. Do not
forward a published URL beyond its intended recipient.

Defaults are a 10-minute TTL, 100 MiB per artifact, and 64 active artifacts. Configure
these with `MCP_ARTIFACT_TTL_SECONDS`, `MCP_ARTIFACT_MAX_BYTES`, and
`MCP_ARTIFACT_MAX_ACTIVE`. Production `MCP_PUBLIC_URL` must be an HTTPS origin-root
URL; loopback HTTP is accepted only for local verification. Expired snapshots are
deleted automatically. Publishing is format-neutral; HWP, PDF, images, archives, and
other regular files use the same delivery path.

## Operator approval bridge

The optional bridge adds three tools for **Kernel legacy project identity adoption**:
`request_operator_approval`, `get_operator_approval`, and `execute_approved_operation`.
The enabled catalog contains 28 tools; the default catalog remains 25. Arbitrary
shell commands, identity data merges, deployments, and review overrides are outside
this capability. See [the approval contract and operating steps](docs/operator-approval.md).

Enable it with `MCP_OPERATOR_APPROVAL_ENABLED=true`. Run `scripts/setup-keys.ps1`
to generate an independent `MCP_OPERATOR_APPROVAL_KEY`; it must contain 32–512
characters and differ from connection/probe secrets. `scripts/get-approval-key.ps1
-Operator` displays/copies it locally. Enter it only into the browser approval form.
`MCP_OPERATOR_APPROVAL_TTL_SECONDS` defaults to 600 (allowed: 60–3600). Configuration
changes require a normal deployment with the active-process guard. Refresh the
ChatGPT connector catalog after deployment.

This is an application consent and audit bridge. The existing unrestricted root
execution and file tools remain able to access the same host and Kernel runtime.
The bridge does not establish OS isolation or make a chat message cryptographic
proof of human approval. Strong enforcement against a compromised root agent
requires a separately protected approval broker, execution credentials, and a Kernel
verifier for that broker. That infrastructure migration is outside this feature.

`complete_work` accepts an optional `finalCheckpoint` (current: at most 2,048 characters).
Completion now requires phase `completed`, a nonblank current, and empty remaining/blockers.
Older clients must save that checkpoint through `checkpoint_work` first. Otherwise the call
returns `completion_checkpoint_conflict` without changing state. Final checkpoint and terminal
state use the existing atomic schema-v2 write. Evidence belongs at the top level; execution
reconciliation must precede completion. Existing identical request IDs replay their original
result; adding a final checkpoint changes the request. Legacy inconsistent records are read
with a warning, without rewriting them. This structural check does not certify project completion.
Existing filesystem and process tools remain available. The container has full access
to configured mounts; protect credentials and select mounts deliberately.

## Task continuity contract

### Recovering a disconnected ChatGPT response

A browser response stream and an MCP process are separate observations. A disconnected
banner does not prove that a command stopped. HTTP 200 from MCP does not prove that a
command succeeded. Inspect existing process state and durable execution receipts first.

For a ChatGPT HTTP 429 response, wait for its `Retry-After` interval before retrying
the affected endpoint. Avoid repeated refreshes and new prompts during that interval.
`Resume stream unavailable` means that the requested response stream cannot be resumed;
it does not authorize replaying project commands or issuing a new task contract.
After the cooldown, reload the existing conversation once. If it remains stuck, stop
the stale response and explicitly continue from the first unfinished step after checking
current workspace state. Do not automatically resend commands with side effects.

If the issue repeats, record timestamps with timezone, endpoint path, HTTP status,
`Retry-After`, and corresponding MCP request/process outcomes. Keep authorization
headers, cookies, tokens and message contents out of diagnostic artifacts. Separate
ChatGPT API failures from MCP, OAuth and tunnel failures; do not change project work
units to repair a browser stream. Browser recovery does not prove the original cause.

Deployment probes revoke one token grant per run. The provider invalidates both access
and refresh tokens together. Keep scheduled preflight checks at a two-minute interval
or longer, and keep the active-process restart guard enabled. Do not reduce OAuth rate
limits or force a restart to compensate for a failed probe.

### Durable execution state

Task continuity records bounded caller intent separately from current workspace state
and observed process execution facts. `get_work_context` is read-only and never creates
or resumes a task. `checkpoint_work` uses explicit `create` / `update` modes, UUID
`requestId` idempotency, and revision CAS; stale writers fail instead of being merged.
At most one active task is stored per workspace snapshot.

For commands where duplicate execution matters, pass both `taskId` and a caller-created
`operationId` to `exec_command` or `run_script`. The operation is durably reserved
before spawn. Reusing the same operation ID with identical execution input returns the
existing receipt/session instead of spawning again; different input is rejected.
After a service restart, any prior `prepared` or `running` receipt becomes `unknown` and
is never automatically retried. ChatGPT must inspect current files/artifacts and record
an explicit reconciliation before a `completed` task can close over that uncertainty.

### Enforced tracking and compact recovery

For GPT project work, set `MCP_EXECUTION_TRACKING=required` in the local deployment
configuration. Both execution tools then reject calls without `taskId` and `operationId`
**before spawn**. The `tracking_required` error returns a read-only `get_work_context`
call for the requested workspace. Reuse its active task; create a checkpoint only when
no active task exists. This continuity checkpoint is not a replacement for a project's
existing task contract. The default `optional` policy preserves untracked clients.
This setting applies only to `exec_command` and `run_script`: it does not deduplicate
file edits, stdin writes, or external effects retried under a different operation ID.

Process start, polling, stdin and termination responses preserve the tracked task and
operation IDs, receipt state and persistence state in both text and structured results.
`nextCall` supplies `read_process` with the returned `nextSeq`. Explicit read calls
preserve their wait mode, wait budget and output limit across continuation calls.

Successful process exit needs no automatic `get_work_context` call when all output
is drained, exitCode is zero, there is no signal or timeout, and the durable receipt
is `exited` with persistence `ok`. Failure, uncertainty and reconnect retain recovery
guidance. Chat chooses when to checkpoint; process exit does not complete a task.

`MCP_DEFAULT_PROCESS_YIELD_MS` configures the default wait for execution tools and
`write_stdin` from 0 to 30000 ms. The default remains 750 ms. Per-call `yieldTimeMs`
overrides it. `read_process` accepts `waitMode=output` (default: return on new output
or exit) and `waitMode=terminal` (wait for exit or `waitMs`, ignoring output wakeups).
Both modes preserve output limits and `nextSeq`. A wait budget or HTTP disconnect
does not terminate the process. Waiting settings do not change operation identity.

`MCP_PROCESS_READ_WAIT_MAX_MS` caps each read wait at 60000 ms by default
(configuration range: 1000–300000). The wire `waitMs` range remains 0–300000.
The response deadline starts at handler entry and allows the effective wait plus
5000 ms for receipt verification. A zero wait or `drainOnly=true` still has this
5000 ms verification budget. `persistenceVerification=pending` means a terminal
result is observed but its durable receipt is not yet verified. Follow the same
session's `nextCall`; do not start another execution. Receipt `persistenceState`
keeps its existing `ok`/`degraded` values. Authenticated `/diagnostics` exposes
the effective yield and read cap in `processSettings`.

When `hasMore=true`, follow `nextCall` with `drainOnly=true`. This makes only that
read immediate. The next continuation restores the original wait when output is
drained and the process still runs. Execute the supplied arguments unchanged.
If a session expires, `read_process` can accept its original `taskId` and
`operationId` together. It returns a matching current-boot receipt with
`outputAvailability=unavailable`; this does not prove that all output was read.
Use `get_work_context` for earlier boots or uncertain execution state. Never
restart an execution to recover missing output. Context responses expose total
unsettled counts and a task-bound `nextCursor`; supply it as `cursor` for the next page.

After `npm run build`, run `node scripts/execution-benchmark.mjs --terminal` for a
fixed local workload and per-setting polling, latency, output and deduplication data.
Usage reports accept task/workspace/build filters and an optional read-only receipt
directory. See [execution contracts](docs/plans/mcp-improvements-2026-10-10/EXECUTION-CONTROL.md)
and [measured results](docs/plans/mcp-improvements-2026-10-10/EXECUTION-CONTROL-MEASUREMENT.md).

The optional `scripts/harness-compatibility-smoke.mjs` accepts
`--harness-executable`, `--harness-prefix-json` (an argument array), and `--projects-dir`.
It creates its own disposable project and isolated Harness runtime beneath that
directory. Use the installed public launcher; the smoke does not import Harness
modules. It records `skipped` when no Harness is configured/installed and `blocked`
when an installed Harness requires an unsupported action or approval. Core tests
work without a Harness. On Windows, `npm test` uses a separate disposable Linux
container; `MCP_TEST_IMAGE` can select an existing project image.
Drain `hasMore=true` even if the process has exited. After the output is drained, a
tracked result directs the caller to work context; process completion never closes a
task. A duplicate tracked start is explicitly marked `duplicate=true`, including when
the existing worker is still running.

`get_work_context` defaults to `format=summary` at the MCP tool boundary. It keeps task
identity/revision, bounded intent, drift/evidence status and execution counts, without
duplicating all file fingerprints. `summaryOmissions` describes removed details.
Use `format=full` before detailed reconciliation; a partial summary cannot authorize
retries or prove completion. Direct service calls retain the full view by default.

`list_processes` defaults to 20 entries with no command bodies or output. Filter with
`taskId`, exact `cwd`, or `runningOnly`; running entries sort first. `counts` includes
all matching retained entries, and `truncated` reports omitted entries. `includeCommand=true`
requests the previous command detail explicitly. `availableThroughSeq` reports available
output, not output already read: continue with the previous `nextSeq`, or use `afterSeq=0`
when recovering a lost cursor. Retained output can expire or be evicted; exit receipts
persist separately and do not preserve stdout/stderr across a service restart.

Use the [GPT project instructions template](templates/chatgpt-project-instructions.md)
with this profile. Refresh the connector catalog after deploying schema changes and
check that both execution tools expose tracking IDs. The server places recovery rules
first in its initialization instructions, as described in
[OpenAI's MCP server guidance](https://developers.openai.com/plugins/build/mcp-server).
Neither these rules nor tracking repair ChatGPT's internal response stream or wake an
idle existing conversation. They preserve execution facts and prevent an exact tracked
retry from running twice when the client returns. Existing operations started without
tracking do not acquire durable receipts retroactively.

Validate with `npm run integration:docker` before activation. Deployment must use the
existing active-process guard; do not restart a busy workmachine. Optional/required
changes need a service deployment to take effect. This feature does not restart services
or send browser recovery prompts by itself.

The continuity store lives under `MCP_CONTINUITY_STATE_DIR` (Docker defaults to
`MCP_STATE_DIR/continuity`) and is separate from request telemetry. Workspace snapshots
are atomic JSON files guarded by a single writer; execution receipts are separate JSON
records. Workspace fingerprints cover Git HEAD, branch/detached state, porcelain
status, bounded worktree/untracked content hashes, and staged index object IDs. When a
file/time/byte bound prevents complete inspection, context returns a partial/unknown
observation rather than claiming equality.

Schema v1 uses fail-fast migration: unsupported schema versions or corrupt JSON return
explicit errors and are not rewritten automatically. State is retained until explicitly
changed/closed or until the configured storage budget is exhausted; the server does not
silently discard durable task/receipt history. Storage-full or persistence failures
fail closed for new durable mutations. Normal service shutdown terminates managed
processes first and waits for terminal receipt hooks; host/container crashes cannot
prove the final side effects and therefore recover unsettled executions as `unknown`.

See [performance and operations](docs/performance.md) for logging, monitoring,
rollback and deployment details. Runtime reports under `docs/runtime/` are local and
excluded from Git and Docker build inputs.

## License and provenance

MIT. This project incorporates code from `kstost/cokacremote`.
See [upstream provenance](UPSTREAM.md) and the preserved
[upstream license](templates/UPSTREAM-LICENSE).
