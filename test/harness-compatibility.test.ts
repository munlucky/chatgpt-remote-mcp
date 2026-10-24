import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("keeps the core suite independent of an optional Harness installation", async () => {
  const result = JSON.parse(execFileSync(process.execPath,["scripts/harness-compatibility-smoke.mjs"],{encoding:"utf8"}));
  expect(result).toEqual({status:"skipped",reason:"harness_not_configured"});
  const root = await mkdtemp(path.join(os.tmpdir(),"mcp-absent-harness-"));
  try {
    const missing = JSON.parse(execFileSync(process.execPath,["scripts/harness-compatibility-smoke.mjs",
      "--harness-executable",path.join(root,"missing"),"--projects-dir",root],{encoding:"utf8"}));
    expect(missing).toEqual({status:"skipped",reason:"harness_not_installed"});
    await writeFile(path.join(root,"untouched"),"preserved");
  } finally { await rm(root,{recursive:true,force:true}); }
});

it("does not classify inaccessible installs or failed workers as successful compatibility", () => {
  const script = `import {classifyHarnessAccessFailure,isSuccessfulTrackedExit} from './scripts/harness-compatibility-smoke.mjs';
    const ok={running:false,hasMore:false,exitCode:0,signal:null,timedOut:false,executionState:'exited',persistenceState:'ok'};
    console.log(JSON.stringify({access:['ENOENT','EACCES','EIO'].map(code=>classifyHarnessAccessFailure({code}).status),
      outcomes:[ok,{...ok,signal:'SIGTERM'},{...ok,exitCode:7},{...ok,timedOut:true},{...ok,persistenceState:'degraded'},{...ok,executionState:'unknown'}].map(isSuccessfulTrackedExit)}));`;
  const result = JSON.parse(execFileSync(process.execPath,["--input-type=module","-e",script],{encoding:"utf8"}));
  expect(result).toEqual({access:["skipped","blocked","blocked"],outcomes:[true,false,false,false,false,false]});
});
