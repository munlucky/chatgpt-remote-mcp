# MCP execution observability and control

## Responsibility

MCP owns process execution, receipts, deduplication and recovery. A consumer Harness owns its workflow, acceptance and completion decisions. MCP does not infer a Harness stage or create a Harness run ID.

## Telemetry version 2

`requestId` identifies one server-generated HTTP request. It is unrelated to the caller's checkpoint idempotency `requestId`. `bootId` on a request identifies the serving boot. `correlation.executionBootId` identifies the referenced process boot, including receipt replay after restart. Lifecycle `bootId` identifies the spawning boot. Build filters select the build that emitted each event; they do not attribute an old process to the build serving its replay.

`correlation` contains nullable task, workspace, operation, session and execution boot IDs. Services select bindings before recording them. Unknown task input does not become a validated binding. A missing binding has an explicit reason. HTTP close records the information available at that time. Later lifecycle events preserve the originating request ID. The report can derive a binding only from an unambiguous exact boot/request match, with its source reported separately. Context/checkpoint requests without such evidence remain unlinked after early disconnect.

The disk and console serializers select allowed metadata at runtime. They exclude commands, prompts, process output text, workspace paths, checkpoints, raw receipts and arbitrary error objects. Lifecycle coverage is explicitly limited to `exec_command` and `run_script`. The existing operator approval bridge has separate receipts and is outside this coverage claim.

## Reports and integrity

The existing positional hours and explicit `--since`/`--until` interface remain available. Optional `--task-id`, `--workspace-id`, `--build-id` and `--receipts-dir` flags can be combined. The PowerShell wrapper forwards the same filters. Receipt directories refer to the environment running the report.

The report joins retained lifecycles before applying the display interval. HTTP identity is request ID; logical execution identity is workspace/operation; process identity is boot/session. HTTP retries do not imply another spawn. A reused operation in a different workspace is separate. Exact repeated events and conflicting event content are reported separately. Missing evidence, legacy data, terminal events outside the interval and confirmed mismatches have distinct states.

Receipt comparison reads only selected files. It never constructs a TaskStore, acquires a writer guard, migrates data, replays a journal, repairs a receipt or retries work. It checks schema, owner and result fields. A pending transaction or a receipt changed during observation is inconclusive. A mismatch is reread before it is reported. Timestamp equality is not required because receipt persistence and process observation happen at different times. These observations are not a consistent workspace snapshot.

Output metadata distinguishes generated process bytes, HTTP response bytes, returned process bytes and the maximum observed retention loss per process. Repeated cursor reads count as transfer cost. Empty running reads and terminal reads with output are separate. Event gaps include model/user work and silent execution. Cumulative process durations can overlap.

Independent diagnostic sidecars record a boot interval, pending events and cumulative loss counters. Missing or incomplete coverage is `unknown`. Zero counters cover only the recorded observations and do not prove that no boot or crash-buffered event is missing. Report input coverage records rotation/change and incomplete final lines. Logs and diagnostic sidecars are runtime artifacts, not package content.

The pure report schema mirrors the canonical continuity schema without importing writable storage. Regression fixtures check canonical fixture validity and reject invalid receipt timestamps/task owners. A prepared receipt with no session is uncertainty. Duplicate-operation checks use the selected logical keys against all retained lifecycle history, including other builds and events outside the display interval.

## Waiting and guidance

`MCP_DEFAULT_PROCESS_YIELD_MS` defaults to 750 and accepts integers from 0 to 30000. Execution and stdin calls use this server default unless overridden. `read_process.waitMode` defaults to `output`; `terminal` reuses `waitForExit`, ignoring output wakeups until exit or the wait budget. Both modes return bounded output and preserve cursors. Disconnect does not signal the process. These waiting settings are excluded from logical execution identity.

Automatic context guidance is omitted only when running=false, hasMore=false, exitCode=0, signal=null, timedOut=false, executionState=exited and persistenceState=ok. Terminal hooks and receipt reads run before that decision. Receipt replay after memory eviction retains recovery guidance. Failure, uncertainty and reconnect still require current-state inspection. Chat chooses checkpoint boundaries.

## Review and compatibility

The user-designated review chat supplied four initial P1 design boundaries and three P2 implementation defects. The implementation incorporates the request/execute boot split, runtime field selection, read-only storage observation, late lifecycle derivation, prepared-state handling, retained-history duplicate checks and schema/owner validation. Dedicated fixtures cover these boundaries.

The optional compatibility smoke accepts an external executable plus argument prefix and a test-project parent directory. It creates a disposable project and separate runtime, observes public CLI help and doctor, requests a semantic contract, performs one side effect through MCP with deliberate HTTP reply loss, replays the same operation, and checks a final worker marker plus successful durable termination. It restores the active Harness Run through public context/resume before reporting with that returned continuation. It consumes canonical report.next and checks completed resume/context identity separately. Only an actual Harness done response passes. Additional actions or unmet provider/approval requirements are blocked. Missing installation/configuration is skipped; access failures are blocked.

The final review in the user-designated chat confirmed that the last four findings were resolved in code and found no remaining P1/P2 in the requested scope. That review was static. Runtime proof and the installed-Harness smoke were executed separately by the implementing session; they are not represented as independent reviewer execution.

## Execution sequence

1. Implement correlation and scoped reports with fixtures.
2. Measure a fixed workload before changing execution control.
3. Change context guidance and waiting. Preserve receipt durability and reply-loss behavior.
4. Run optional installed-Harness compatibility checks in an isolated test project/runtime.

Production deployment and Git publication require a separate request.

## Publication follow-up

The user requested commit, push and container redeployment after implementation acceptance. The installed Kernel staging validator rejects pre-existing OAuth values in `.env.example` as secrets. The follow-up removes only this task's three added yield example lines from that template. The configurable yield implementation and the README setting guidance remain. A new Kernel successor verifies the final workspace and preserves the accepted implementation lineage before publication. The validator, existing template values, credentials and runtime receipts are not changed.
