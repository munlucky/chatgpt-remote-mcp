# Kernel identity approval bridge

## Scope and trust

The bridge supports only `kernel_identity_adopt`: adopt one eligible legacy Kernel
project ID without rewriting its existing data. It never treats a chat message,
caller-supplied approver name, or an MCP connection approval as operation consent.
It cannot override Kernel identity conflicts or protected review rules.

The MCP service authenticates a bearer credential or OAuth grant. Requests are owned
by its server-derived hash. OAuth ownership survives access-token refresh within the
same grant. Two conversations using the same grant share that ownership; no trusted
ChatGPT conversation identity is available. A new grant must create a new request.
An OAuth grant is a client credential, not proof of a named human user.

The browser requires a separate operator key for each decision. The resulting actor
is recorded as `operator-key-holder`, not an invented account identity. The Kernel
receipt separately records the actual local OS username (`root` in the current
container). Keep these two actor meanings distinct.

The current host exposes unrestricted root execution and file access. This bridge
adds a verifiable application workflow, **not protection against an agent that uses
those root capabilities to bypass it**. Its ledger HMAC detects accidental changes
or modification without its key; it does not defeat root access to the key. The key
is excluded from managed subprocess environments, but remains accessible to root
through host configuration. Do not describe this as an independently enforced
operator security boundary. That requires a separate broker and Kernel-side trust
verification, plus removal of the agent's access to privileged Kernel state/keys.

## Enable and use

1. Run `scripts/setup-keys.ps1`. It creates missing independent secrets and does not
   print them. Set `MCP_OPERATOR_APPROVAL_ENABLED=true` in the ignored deployment
   `.env`. Keep the existing volumes. Configure `MOON_RELAY_KERNEL_HOME` through the
   existing Kernel profile mount. The public URL must be an HTTPS origin without a
   path prefix (HTTP is accepted only for loopback tests).
2. Deploy using `scripts/start.ps1`. Its active-process guard includes approval
   execution because the complete approve/repair/status sequence runs as one managed
   process. Refresh the connector catalog and check for all three new tools.
3. Read `get_work_context`. Reuse an active continuity task for the exact workspace;
   do not replace a Kernel task contract. Inspect Kernel identity candidates first.
4. Call `request_operator_approval` with `taskId`, a UUID `requestId`, `cwd`,
   `operation: "kernel_identity_adopt"`, `sourceProjectId`, `legacyProjectId`, and
   `reason`. The service independently inspects the Kernel and requires
   `repair_required`, a matching source, and an eligible legacy candidate.
5. Open the returned `approvalUrl`. The human checks the immutable operation,
   workspace, runtime, IDs, task, reason, and expiry. Retrieve the key locally with
   `scripts/get-approval-key.ps1 -Operator` and enter it into that form. Never paste
   it into chat or an MCP argument. Approve or deny the displayed request.
6. Call `get_operator_approval` with `approvalRequestId`. On `approved`, call
   `execute_approved_operation` with that ID and a new UUID `operationId`. It accepts
   no replacement target, command, runtime, approver, or approval reference.
7. Follow `get_operator_approval` until `succeeded` or `unknown`. A managed `sessionId`
   is also available to process tools. After `succeeded`, inspect work context and
   continue the existing Kernel workflow. This bridge never issues `kernel next`
   automatically and never declares a Kernel task complete. An idle chat is not
   automatically awakened by a browser decision.

## Binding and execution

Requests bind the authenticated owner, continuity task, canonical workspace,
configured Kernel runtime, source/legacy project IDs, selected identity-candidate
snapshot, and SHA-256 of the CLI entrypoint, CLI dispatcher, and identity approval
module. A repository subdirectory or configured alias resolves to its workspace
root. This digest is a change detector for these three modules, not a signature of
the entire transitive Kernel installation.

An approved request gets a server-generated `moonremote:approval:<uuid>` reference.
Before spawn, the ledger records its one-time execution reservation durably. A
fixed Node worker checks the installation digest and the identity snapshot again,
then invokes the official Kernel CLI through argv with no shell:

```text
identity status
identity approve --legacy-project-id … --approval-ref … --approved-by <OS user>
identity repair  --legacy-project-id … --approval-ref …
identity status
```

The final identity must be ready, match the approved legacy ID, and retain the
observed canonical root and runtime. The Kernel creates its own HMAC-signed receipt.
The Host reference links that receipt to the Host ledger; the current Kernel does
not independently authenticate the Host issuer. Kernel conflicts remain blocking.

`requestId` replays only identical input for the same owner. `operationId` replays
the existing execution, including uncertain or completed results, without spawning
again. Another operation ID cannot consume that approval. Concurrent exact calls
serialize with task completion through the continuity workspace lock.

## Expiry, durability, and recovery

The request TTL starts at creation and applies to pending and approved requests.
An execution reserved before expiry may finish after expiry. Denial is terminal.
Decisions require the operator key, the request's view token, a same-origin POST,
and a matching HttpOnly/SameSite CSRF cookie. HTTPS cookies are Secure. The page
escapes caller text, prevents framing, and sends no-store/no-referrer headers.
Failed decisions are limited to five per client IP per 15 minutes. Nginx disables
approval-path access logs so URL view tokens do not enter those logs.

State is stored in `MCP_CONTINUITY_STATE_DIR/operator-approvals/ledger.json` as a
versioned, HMAC-signed envelope. Writes use file fsync, atomic rename, and directory
fsync where supported. Windows lacks directory fsync and has the same power-loss
limitation as the existing continuity store. A writer lock prevents ordinary
concurrent writers. Keep one service replica per state directory.

The ledger retains at most 1,000 requests and 8 MiB. It does not delete audit history
automatically. Budget or persistence failures stop new state changes. Corruption or
key rotation with an existing ledger prevents startup; retain the original key and
backups. Before archiving a full ledger, stop the service, verify every unsettled
operation, and archive the whole signed ledger securely. Do not edit signed JSON.
Archival removes old request lookup and dedupe from the active service; retain the
archive for audit and never blindly replay old requests.

A crash, timeout, worker failure, or unverifiable final output gives `unknown`.
On restart, persisted `executing` records also become `unknown`. Exact retries
return the existing state. New identity execution on the same workspace and task
completion remain blocked by unresolved executions. Inspect Kernel identity,
receipts, files, and any retained process output. Do not automatically repeat the
repair. The current bridge intentionally has no model-callable uncertainty override;
an administrator must inspect and resolve/archive the record offline.

## Validation boundary

The integration suite uses an isolated CLI double to test HTTP/MCP authentication,
browser decisions, binding, duplicates, drift, failures, signed-ledger integrity,
and restart recovery. It does not approve or repair real user projects. Production
deployment and a real identity-adoption decision are separate operating steps.
