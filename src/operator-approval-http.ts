import { randomBytes } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import { tokensEqual } from "./auth.js";
import type { OperatorApprovalService } from "./operator-approval.js";
import type { ApprovalRecord } from "./operator-approval-store.js";

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

function page(record: ApprovalRecord, csrf: string): string {
  const expired = Date.parse(record.expiresAt) <= Date.now();
  const status = expired && ["pending", "approved"].includes(record.status) ? "expired" : record.status;
  const rows = { "요청 ID": record.id, "작업": "Kernel 기존 프로젝트 ID 채택", "작업 경로": record.cwd, "Kernel 실행 환경": record.kernelHome,
    "현재 프로젝트 ID": record.sourceProjectId, "채택할 기존 ID": record.legacyProjectId,
    "연속 작업 ID": record.taskId, "요청 사유": record.reason, "만료 시각 (UTC)": record.expiresAt, "상태": status };
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kernel 작업 승인</title><style>body{font-family:system-ui,sans-serif;background:#f5f7fa;color:#182333;margin:0;padding:24px}main{max-width:720px;margin:24px auto;background:white;padding:28px;border:1px solid #ccd4df;border-radius:12px}h1{font-size:24px}p,dd{line-height:1.6}dt{font-weight:700;margin-top:14px}dd{margin:4px 0;overflow-wrap:anywhere;white-space:pre-wrap}.notice{background:#fff2d5;padding:14px}label{display:block;font-weight:700;margin:20px 0 8px}input{box-sizing:border-box;width:100%;padding:12px;font:inherit}button{padding:12px 24px;margin:18px 8px 0 0;font:inherit;cursor:pointer}button[value=approve]{background:#174db3;color:white;border:1px solid #174db3;border-radius:5px}</style></head>
<body><main><h1>Kernel 작업 승인</h1><p>아래 경로에서 기존 프로젝트 ID를 채택합니다. 기존 상태를 임의로 병합하지 않습니다.</p>
<p class="notice">대상을 확인하십시오. 승인은 이 요청에 한 번만 적용됩니다. 현재 root 명령 실행 권한은 이 승인 절차와 별도로 존재합니다.</p>
<dl>${Object.entries(rows).map(([key, value]) => `<dt>${key}</dt><dd>${escape(value)}</dd>`).join("")}</dl>
${status === "pending" ? `<form method="post" autocomplete="off"><input type="hidden" name="token" value="${escape(record.viewToken)}"><input type="hidden" name="csrf" value="${escape(csrf)}">
<label for="key">작업 승인 전용 인증키</label><input id="key" type="password" name="key" required autocomplete="off" maxlength="512">
<button type="submit" name="decision" value="approve">이 작업 승인</button><button type="submit" name="decision" value="deny">거절</button></form>` : "<p>결정이 기록되었거나 요청이 종료되었습니다. 채팅에서 승인 상태를 조회하십시오.</p>"}
</main></body></html>`;
}

export function registerApprovalRoutes(app: Express, service: OperatorApprovalService): void {
  if (!service.config.operatorApprovalEnabled) return;
  const origin = new URL(service.config.publicUrl!).origin;
  const secure = new URL(origin).protocol === "https:";
  const attempts = new Map<string, { count: number; until: number }>();
  const prefix = "/operator-approvals/:id";
  const protect = (_request: Request, response: Response, next: () => void) => {
    response.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
    next();
  };
  app.get(prefix, protect, async (request, response) => {
    try {
      const token = typeof request.query.token === "string" ? request.query.token : "";
      const record = await service.browserRecord(String(request.params.id), token);
      const csrf = randomBytes(32).toString("hex");
      response.cookie("operator_csrf", csrf, { httpOnly: true, sameSite: "strict", secure, path: "/operator-approvals", maxAge: 3600000 });
      response.type("html").send(page(record, csrf));
    } catch { response.status(404).type("text").send("승인 요청을 확인할 수 없습니다."); }
  });
  app.post(prefix, protect, express.urlencoded({ extended: false, limit: "8kb" }), async (request, response) => {
    const forbidden = () => response.status(403).type("text").send("승인을 확인할 수 없습니다. 요청 화면과 인증키를 확인하십시오.");
    if (request.get("origin") !== origin) { forbidden(); return; }
    for (const [ip, attempt] of attempts) if (attempt.until <= Date.now()) attempts.delete(ip);
    const ip = request.ip || "unknown";
    const prior = attempts.get(ip);
    if ((prior?.count ?? 0) >= 5 || (!prior && attempts.size >= 1000)) {
      response.set("Retry-After", "900").status(429).type("text").send("인증 시도가 너무 많습니다. 나중에 다시 시도하십시오."); return;
    }
    const cookie = (request.get("cookie") || "").split(";").map(p => p.trim()).find(p => p.startsWith("operator_csrf="))?.slice(14) || "";
    const { csrf, key, token, decision } = request.body ?? {};
    if (typeof csrf !== "string" || !cookie || !tokensEqual(cookie, csrf) || typeof key !== "string"
      || !tokensEqual(key, service.config.operatorApprovalKey!) || typeof token !== "string"
      || (decision !== "approve" && decision !== "deny")) {
      attempts.set(ip, { count: (prior?.count ?? 0) + 1, until: prior?.until ?? Date.now() + 900000 });
      forbidden(); return;
    }
    try {
      await service.decide(String(request.params.id), token, decision);
      attempts.delete(ip);
      response.clearCookie("operator_csrf", { path: "/operator-approvals", sameSite: "strict", secure, httpOnly: true });
      response.type("html").send(page(await service.browserRecord(String(request.params.id), token), ""));
    } catch { response.status(409).type("text").send("요청이 만료되었거나 이미 처리되었습니다. 채팅에서 상태를 확인하십시오."); }
  });
}
