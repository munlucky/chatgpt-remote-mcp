# Execution control measurement

## Before control changes

Build: `bench-157aef4b8358d912`. UTC interval: 10/24/2026 05:18:45 to 10/24/2026 05:19:01.

Linux test container. Sequential workload: 100 ms and 1100 ms Node scripts. Each writes two short lines. Three samples per duration and configuration. Each operation is requested again once to verify deduplication. read_process wait budget is 1000 ms. This is local synthetic evidence; it does not establish production speed.

| Yield ms | Executions | Additional polls | Automatic context guidance | Extra spawns | Output bytes | Retention loss | Response p95 ms |
|---|---|---|---|---|---|---|---|
| 750 | 6 | 6 | 6 | 0 | 60 | 0 | 914.6 |
| 3000 | 6 | 0 | 6 | 0 | 60 | 0 | 1,372.0 |
| 5000 | 6 | 0 | 6 | 0 | 60 | 0 | 1,414.6 |

Lifecycle: 18 starts, 18 terminals, 18 correlated starts. Dropped events: 0. Write failures: 0. Peak simultaneous MCP requests: 1.

Reproduce after npm run build: `node scripts/execution-benchmark.mjs`. Add `--terminal` after terminal waiting is implemented. Response percentiles include the exact-operation replay requests and deliberate execution waits. A larger yield budget can reduce calls while increasing the latency of an individual call.

## After control changes

Build: `bench-ee30a9a38fc4802e`. UTC interval: 10/24/2026 05:22:20 to 10/24/2026 05:22:53.

The workload, samples, output and poll budget match the baseline. output rows provide the same-setting comparison. terminal rows change only the read wait policy.

| Yield ms | Read mode | Executions | Additional polls | Automatic context guidance | Extra spawns | Output bytes | Retention loss | Response p95 ms |
|---|---|---|---|---|---|---|---|---|
| 750 | output | 6 | 6 | 0 | 0 | 60 | 0 | 988.7 |
| 750 | terminal | 6 | 3 | 0 | 0 | 60 | 0 | 852.9 |
| 3000 | output | 6 | 0 | 0 | 0 | 60 | 0 | 1,284.5 |
| 3000 | terminal | 6 | 0 | 0 | 0 | 60 | 0 | 1,328.0 |
| 5000 | output | 6 | 0 | 0 | 0 | 60 | 0 | 1,341.4 |
| 5000 | terminal | 6 | 0 | 0 | 0 | 60 | 0 | 1,457.7 |

Lifecycle: 36 starts, 36 terminals, 36 correlated starts. Dropped events: 0. Write failures: 0. Peak simultaneous MCP requests: 1.

At 750 ms yield, the terminal read policy reduced additional reads from 6 to 3 for these six executions. At 3000/5000 ms yield, all workloads finished inside the initial budget and required zero additional polls. Safe terminal automatic context guidance changed from 6/6 to 0/6 for each setting. Exact retries caused zero additional spawns. All rows returned 60 process-output bytes with zero observed retention loss.

The default remains 750 ms. These small local samples do not justify a production latency claim or a universal default change. The Docker host experienced transient memory pressure during later verification; no production resources were reconfigured.

## Installed Harness compatibility

The external installed Node launcher passed the black-box MCP compatibility smoke in a disposable project and isolated runtime. The observed Harness Run was `run-aadd3815-641e-4b5b-9257-3c869cd82d64`. Its report returned canonical `next.action.type=done`. Public resume and context restored the active Run before report, then retained the same completed Run afterward. A final worker marker and a successful durable terminal receipt confirmed that the interrupted worker reached its final statement. HTTP reply loss preserved the worker; replaying the same MCP operation left exactly one side effect. The smoke does not import Harness implementation modules.

Without an installed/configured Harness, the dedicated compatibility command records skipped; an installed Harness with unmet provider, approval or CLI requirements records blocked. Core tests do not require a Harness.
