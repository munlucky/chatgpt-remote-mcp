# Independent Kernel reviews through Moonremote

Moonremote can launch a fresh Codex reviewer and return the official Kernel
`reviewReceiptId`. It does not accept a supplied verdict, reviewer identity,
model, approval reference, or receipt. Kernel owns route selection, capsules,
receipt ingestion, and the final completion decision.

## Configuration

Build the service with `npm ci` and `npm run build`. Enable
`MCP_KERNEL_REVIEW_ENABLED=true`; the two review tools are exposed only when
this setting is enabled. Docker deployments normally use
`MCP_KERNEL_REVIEW_TARGET=host`; enable the existing native host executor and
its path mappings. Set `MCP_KERNEL_REVIEW_CODEX` to the native Codex executable
if the companion's PATH does not contain it. Sign in to Codex on that host.
Use an entrypoint from a complete compatible Codex package, including its
`codex-code-mode-host`. On the tested Mac, Homebrew CLI 0.162.1 failed model
tool negotiation; the app's matching 0.165.0-alpha.1.2 package successfully
executed read-only tools. Its entrypoint was
`/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`.
Do not disable the code-mode host to work around a missing package: models
using `functions.exec` require that host. Use the model/tool probe to validate
the configured installation.
`MCP_KERNEL_REVIEW_TIMEOUT_MS` defaults to 600000 (30 seconds to 30 minutes).
The deadline covers provider execution, cleanup, and the handoff to Kernel.
An expired operation cannot emit an attestation or enter ingestion. Once a
valid handoff begins, the atomic Kernel operation is awaited instead of raced
against a timeout. The managed worker additionally has a 15-second watchdog
grace; interruption during commit is uncertain and requires receipt inspection.
The control plane is closed only after dispatch/ingestion settles. An observed
review verdict and its findings survive cleanup and ingestion failures.

The service must see the installed Kernel payload at `MOON_RELAY_KERNEL_HOME`.
For Docker this includes the original Run's `/root/.moon-relay-kernel` and
`/shared/...` paths. Pass the exact Kernel project path. Continuity aliases
identify tasks but do not rewrite Kernel identities. A local process reading
a Docker-created Run may otherwise report stale runtime binding.

Direct local execution is available with `MCP_KERNEL_REVIEW_TARGET=local` when
Codex and Kernel are installed in the service's execution environment.
The existing running service is not upgraded merely by editing these files;
build and deploy the configured service before calling its new tools.

## Workflow

1. Call `get_kernel_review_status({cwd,probeModelTools:true})` before a task that will require an
   independent review. It starts an ephemeral session to check the protocol,
   authentication, configured model/effort, read-only permissions, and a fixed
   sandboxed directory-read command, then
   confirms cleanup. With `probeModelTools:true` it also runs a bounded model
   turn and requires an observed successful command, consuming Codex usage.
   The default protocol-only check runs no inference and cannot prove model
   tool access. Neither check satisfies a review obligation.
2. Continue the existing Kernel Run and its normal hard verification workflow.
   Use `get_work_context` to recover the active Moonremote task; do not recreate
   an existing contract or task.
3. When Kernel returns `action.type=review`, call
   `start_kernel_review({cwd,runId,taskId,operationId})`. Retain the execution IDs
   and follow the returned `read_process` call with 30-second terminal waits.
4. Inspect the JSON result. `receipt-recorded` means a review receipt exists;
   its verdict may still be `fail`. Findings may require fixes and fresh proof.
   Only Kernel `next.action.type=done` establishes final completion.

An exact repeat of the same operation returns its existing tracked execution.
Prepared, running, or unknown work must be inspected, never retried with a new
operation ID. Kernel additionally owns review claims and receipt reuse for the
current subject. Restart uncertainty remains visible through execution tracking.
For a failed security review, the Host may request an official reviewer route
again after a newer implementation mutation, zero remaining work units, fresh
hard proof, and current mutation provenance. This handles Kernel versions that
continue to return `fix` for the historical failed judgment. The earlier failed
receipt stays intact; no obligation is waived or marked passed by Moonremote.
After a dispatch settles, only claims it actually acquired are released using
Kernel's ownership-checked API. Another session's claim is never released.
Launcher failures resolve as explicit failures, so installed transports do not
retain a wait timer from a rejected launcher Promise. Neither adaptation writes
runtime databases or fabricates review evidence.

## Evidence and failure boundaries

The reviewer uses a new ephemeral Codex app-server thread with its matching
code-mode host package. Desktop session/bootstrap values are cleared from the
reviewer transport. The service checks
the server-returned model, effort, cwd, approval policy and read-only sandbox;
it disables inherited MCP servers, plugins, web search and child delegation.
It rejects client-side tool/approval requests and incomplete/failed turns.
The fixed prompt is generated from Kernel's issued review capsule. Repository
content is untrusted input and cannot supply review provenance.

Before and after review the Host observes the workspace identity and Run
mutation revision. It confirms reviewer cleanup and supplies this attestation
to Kernel's independent-subagent transport. The standard dispatcher records
route/admission/usage and ingests the outcome. Workspace changes, missing
telemetry, wrong model/permissions, timeouts and unconfirmed cleanup produce no
successful receipt. No runtime database or receipt is edited directly.

Native cleanup requires both local client exit and the companion's durable
terminal result. Unconfirmed jobs are retained for inspection. Provider stderr,
credentials and full review prompts are not returned to MCP callers.

This integration uses the documented [Codex app-server protocol](https://developers.openai.com/codex/app-server).
It does not add OS isolation around Moonremote's existing unrestricted tools.
Review execution is opt-in and can consume the signed-in Codex account's usage.
Windows uses the existing companion transport; validate the configured native
Codex executable and read-only sandbox on Windows before operational use.

## Reproducible real integration check

`npm run test:kernel-review` runs the full Linux suite and build. It uses no
Codex account. To verify real inference and Kernel ingestion separately, build
the project and run:

```sh
MCP_KERNEL_REVIEW_CODEX="/path/to/complete/codex/bin/codex" \
  node scripts/kernel-review-smoke.mjs
```

This POSIX opt-in check consumes Codex usage. It creates a disposable project,
continuity task and isolated Kernel state. A read-only link loads the installed
Kernel payload without modifying existing state. The check exercises:

1. An intentionally incorrect guard with passing incomplete tests, which must
   receive an actual failing independent review receipt.
2. A guard/test fix followed by fresh Kernel hard proof.
3. A real app-server response with only observed reasoning effort removed,
   after Kernel issues a valid route and capsule. `start_kernel_review` must
   return blocked and add no receipt.
4. A fixture file change injected after the actual model review turn starts.
   The same MCP path must reject the changed subject and add no receipt.
5. Source restoration, fresh hard proof, and an official passing re-review for
   the newer mutation. The first failed receipt and digest must remain intact.

Faults exist only in temporary executable interposers configured by this test;
MCP callers cannot request them. The result records the actual capsule/route/
usage identifiers, both review receipts, mutation revisions and source checks.
Per-operation outputs and isolated state remain at the printed artifact path.
Existing Runs, services and project files are not test targets.

Use `npm run test:kernel-review-live` to run the Linux suite and this live check
as one Kernel-discoverable command. Its explicit `--live` argument survives the
Kernel proof executor's environment allowlist. Environment-variable opt-in is
for manual runs only. For a manual smoke, use the executable setting above or
`--codex /path/to/codex`. The smoke prefers the complete app package on macOS
when no executable is specified, then falls back to `codex` on PATH. Windows
live fault injection is not covered by this POSIX smoke.

The expanded macOS check passed on 2026-10-30 using `gpt-6.1-sol` / `xhigh`:

| Evidence | Observed value |
| --- | --- |
| Isolated Run | `run-cef929d3-1a83-431f-8e46-0d76e3bd8cd4` |
| Preserved failed receipt, mutation 1 | `review-receipt-7c400fe6bdc0c70c63d6ad27` |
| Passing re-review receipt, mutation 3 | `review-receipt-96fcc0a26a860d4e4f720954` |
| Passing receipt digest | `sha256:c7938c7c72a33fbd1b443c4cdb40ad5894c309d9af80e27d1569c92c01df18d8` |
| Valid capsule with observed effort removed | `capsule-77519aa1eb2811fabd379925`, blocked through MCP, no added receipt |
| Valid capsule with source changed during turn | `capsule-1c3648bb5255d916ca9ac21e`, blocked through MCP, no added receipt |

The result also verified exact-operation reuse, distinct reviewer/implementer
session hashes, fresh hard proof, unchanged source across completed reviews and
the original failure digest. It covers the isolated integration fixture; the
implementation's own security review has a separate receipt.
