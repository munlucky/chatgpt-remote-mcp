import {execFileSync} from "node:child_process";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {expect,it,vi} from "vitest";
import {observeWorkspace,compareWorkspace} from "../src/continuity/workspace-snapshot.js";
vi.mock("node:fs/promises",async(importOriginal)=>{
  const actual=await importOriginal<typeof import("node:fs/promises")>();
  return {...actual,readFile:vi.fn(actual.readFile)};
});
it("bounds unchanged, oversized and delayed-file observations without claiming complete drift evidence",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"mcp-file-deadline-"));
  execFileSync("git",["init","--quiet",root]);
  const identity={workspaceId:"a".repeat(32),executionRoot:root,gitRoot:root,gitCommonDir:path.join(root,".git"),worktreeIdentity:root,repository:true};
  const limits={maxFiles:200,maxBytes:16*1024*1024,maxDurationMs:2000};
  try{
    let begin=performance.now();const unchanged=await observeWorkspace(identity,limits);
    expect(performance.now()-begin).toBeLessThan(2500);expect(unchanged.completeness).toBe("complete");
    const large=path.join(root,"large.bin");await writeFile(large,Buffer.alloc(20*1024*1024));
    begin=performance.now();const oversized=await observeWorkspace(identity,limits);
    expect(performance.now()-begin).toBeLessThan(2500);expect(oversized).toMatchObject({completeness:"partial",reasons:["byte_budget_exceeded"]});
    expect(compareWorkspace(unchanged,oversized).drift).not.toBe("none_detected");
    const actual=await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.readFile).mockImplementation(((file:unknown,options:any)=>{
      if(String(file)!==large)return actual.readFile(file as any,options);
      return new Promise((_resolve,reject)=>{
        const abort=()=>{clearTimeout(timer);options.signal.removeEventListener("abort",abort);reject(Object.assign(new Error("aborted"),{code:"ABORT_ERR"}));};
        const timer=setTimeout(abort,5000);options.signal.addEventListener("abort",abort,{once:true});
        if(options.signal.aborted)abort();
      });
    }) as typeof fs.readFile);
    begin=performance.now();const delayed=await observeWorkspace(identity,{...limits,maxBytes:32*1024*1024});
    expect(performance.now()-begin).toBeLessThan(2500);expect(delayed.completeness).toBe("partial");expect(delayed.reasons).toContain("time_budget_exceeded");
  }finally{vi.mocked(fs.readFile).mockImplementation((await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).readFile);await rm(root,{recursive:true,force:true});}
});
