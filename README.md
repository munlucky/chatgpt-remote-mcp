# ChatGPT Remote MCP

A self-hosted MCP development server for a Windows PC running Docker Compose, with
Cloudflare Tunnel, OAuth, bounded file operations, process management and persistent
usage telemetry. The server image is built from this repository's local source and
npm lockfile; GitHub CI/CD is not required for the intended deployment model.

## Setup

1. Copy `.env.example` to `.env` or run `scripts/setup-keys.ps1`.
2. Run `scripts/setup-keys.ps1` to generate independent OAuth approval and probe secrets when they are empty or missing.
3. Replace placeholder host paths, public domain and Cloudflare tunnel token in `.env`.
4. Configure the tunnel origin to `http://localhost:2999`.
5. Run `scripts/start.ps1` from PowerShell.
6. Connect your MCP client to the configured public URL followed by `/mcp`.

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

Cloudflare's canonical client address is accepted only at the local cloudflared →
Nginx trust boundary. Nginx rewrites `X-Forwarded-For` to that single normalized
address and Express trusts only the immediate Nginx hop, keeping OAuth rate limits
separate between external clients.

The MCP server publishes 24 tools, including bounded `read_files` batching and three
durable continuity tools: `get_work_context`, `checkpoint_work`, and `complete_work`.
Existing filesystem and process tools remain available. The container has full access
to configured mounts; protect credentials and select mounts deliberately.

## Task continuity contract

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
