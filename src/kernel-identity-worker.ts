import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface IdentityPlan {
  cwd: string; kernelHome: string; kernelCli: string; kernelDigest: string;
  sourceProjectId: string; legacyProjectId: string; identityDigest: string; approvalRef: string;
}

export function identityBinding(status: Record<string, unknown>, legacyProjectId: string): string {
  const candidates = status.legacyCandidates as Array<Record<string, unknown>> | undefined;
  const candidate = candidates?.find(item => item.projectId === legacyProjectId);
  if (status.status !== "repair_required" || !candidate?.hasData
    || (candidate.hasPersistedIdentity && !candidate.sameRootEvidence)) {
    throw new Error("Kernel identity is not an eligible repair candidate");
  }
  return JSON.stringify({ projectId: status.projectId, resolvedProjectId: status.resolvedProjectId,
    canonicalRoot: status.canonicalRoot, runtimeHome: status.runtimeHome, candidate });
}

export async function kernelDigest(kernelCli: string): Promise<string> {
  const root = path.dirname(path.dirname(kernelCli));
  const files = [kernelCli, path.join(root, "scripts/application/kernel-cli/main.js"),
    path.join(root, "scripts/kernel/project-identity-preflight.js")];
  const hash = createHash("sha256");
  for (const file of files) hash.update(await readFile(file));
  return hash.digest("hex");
}

// This function is serialized as fixed server code. All operation inputs travel
// through one JSON argv value. No model-supplied shell or executable is accepted.
async function worker(plan: IdentityPlan, loadModule: (specifier: string) => Promise<any>): Promise<void> {
  const { execFileSync } = await loadModule("node:child_process");
  const { userInfo } = await loadModule("node:os");
  const { createHash } = await loadModule("node:crypto");
  const { readFile } = await loadModule("node:fs/promises");
  const path = await loadModule("node:path");
  const digest = async () => {
    const root = path.dirname(path.dirname(plan.kernelCli));
    const hash = createHash("sha256");
    for (const file of [plan.kernelCli, path.join(root, "scripts/application/kernel-cli/main.js"),
      path.join(root, "scripts/kernel/project-identity-preflight.js")]) hash.update(await readFile(file));
    return hash.digest("hex");
  };
  const invoke = (args: string[]) => JSON.parse(execFileSync(process.execPath,
    [plan.kernelCli, "identity", ...args, "--json"], {
      cwd: plan.cwd, env: { ...process.env, MOON_RELAY_KERNEL_HOME: plan.kernelHome },
      encoding: "utf8", timeout: 15000, maxBuffer: 256 * 1024, windowsHide: true,
    }));
  let stage = "preflight";
  try {
    if (await digest() !== plan.kernelDigest) throw new Error("kernel_changed");
    const before = invoke(["status"]);
    const binding = identityBinding(before, plan.legacyProjectId);
    if (createHash("sha256").update(binding).digest("hex") !== plan.identityDigest
      || before.projectId !== plan.sourceProjectId) throw new Error("identity_changed");
    stage = "approve";
    invoke(["approve", "--legacy-project-id", plan.legacyProjectId,
      "--approval-ref", plan.approvalRef, "--approved-by", userInfo().username]);
    stage = "repair";
    const repair = invoke(["repair", "--legacy-project-id", plan.legacyProjectId, "--approval-ref", plan.approvalRef]);
    stage = "verify";
    const after = invoke(["status"]);
    if (repair.status !== "ready" || after.status !== "ready" || after.projectId !== plan.legacyProjectId
      || after.canonicalRoot !== before.canonicalRoot || after.runtimeHome !== before.runtimeHome) throw new Error("verification_failed");
    console.log(JSON.stringify({ status: "succeeded", projectId: after.projectId,
      canonicalRoot: after.canonicalRoot, mutation: repair.mutation, receiptId: repair.receipt?.receiptId }));
  } catch {
    console.log(JSON.stringify({ status: "unknown", stage, code: "kernel_operation_not_verified",
      nextAction: "Inspect Kernel identity status and receipts; never retry automatically" }));
    process.exitCode = 1;
  }
}

// tsx/esbuild may annotate nested functions with __name in development builds.
export const IDENTITY_WORKER_SOURCE = `const __name = fn => fn;\n${identityBinding.toString()}\n(${worker.toString()})(JSON.parse(process.argv[1]), specifier => import(specifier));`;
