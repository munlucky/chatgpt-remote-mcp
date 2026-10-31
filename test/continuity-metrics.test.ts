import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/mcp-server.js";
import { requestMetrics, type RequestMetrics, type UsageEvent } from "../src/telemetry.js";
import { serializeUsageEvent } from "../src/telemetry-schema.js";

it("measures actual context receipt reads and syncs in the existing request scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),"mcp-metrics-"));
  const service = createServices(loadConfig({MCP_AUTH_TOKEN:"test",MCP_DEFAULT_CWD:root,MCP_CONTINUITY_STATE_DIR:path.join(root,"state")},root));
  try {
    const created = await service.continuityService.create({cwd:root,requestId:randomUUID(),objective:"metric fixture",checkpoint:{phase:"test",current:"inspect",completed:[],remaining:[],blockers:[],changedPaths:[],evidenceRefs:[]}});
    const prepared = await service.executionRecorder.prepare({cwd:root,taskId:String(created.taskId),operationId:randomUUID(),toolKind:"run_script",semanticInput:{test:true}});
    await service.executionRecorder.markSpawnFailed(prepared.record);
    const metrics: RequestMetrics = {setupMs:null,toolMs:null,toolError:null};
    await requestMetrics.run(metrics,()=>service.continuityService.context({taskId:String(created.taskId),format:"summary"}));
    expect(metrics.continuity?.receiptReads).toBeGreaterThan(0);
    // Already-durable receipts do not repeat fsync on every context read.
    expect(metrics.continuity?.syncCalls ?? 0).toBe(0);
    await service.continuityService.store.invalidateWorkspace(prepared.record.workspaceId);
    const revalidated: RequestMetrics = {setupMs:null,toolMs:null,toolError:null};
    await requestMetrics.run(revalidated,()=>service.continuityService.context({taskId:String(created.taskId),format:"summary"}));
    expect(revalidated.continuity?.syncCalls).toBeGreaterThan(0);
    expect(metrics.continuity?.taskLookupMs).toBeGreaterThan(0);
    expect(metrics.continuity?.evidenceMs).toBeGreaterThanOrEqual(0);
    const raw = JSON.stringify(serializeUsageEvent({event:"mcp_request",continuity:{...metrics.continuity,secret:"sentinel",receiptReads:-1,gitMs:Infinity}} as unknown as UsageEvent));
    expect(raw).not.toContain("sentinel"); expect(raw).not.toContain(root);
    expect(JSON.parse(raw).continuity).not.toHaveProperty("receiptReads");
    expect(JSON.parse(raw).continuity).not.toHaveProperty("gitMs");
    const safe=serializeUsageEvent({event:"mcp_request",processRead:{running:true,hasMore:true,waitMode:"sentinel",requestedWaitMs:-1,nextSeq:Infinity,persistenceVerification:"sentinel",persistenceState:"sentinel",command:"sentinel",responseElapsedMs:Infinity}} as unknown as UsageEvent);
    expect(JSON.stringify(safe)).not.toContain("sentinel");
    expect(safe.processRead).toMatchObject({waitMode:null,requestedWaitMs:null,nextSeq:null,persistenceVerification:null,persistenceState:null,responseElapsedMs:null});
  } finally {await service.processManager.shutdown();await service.continuityService.close();await rm(root,{recursive:true,force:true});}
});
