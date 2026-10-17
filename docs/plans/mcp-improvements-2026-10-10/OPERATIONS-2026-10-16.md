# 운영 로그 기반 개선 계획

작성일: 2026-10-16 KST.
기준 commit: `d8caa670f6b93c05b62f5e32a8ccefda9809934f`.
기준 build ID: `src-d28a71b98e34f1dffba9`.
상태: 계획 작성 완료. 제품 구현과 배포는 시작하지 않았다.

## 1. 목표와 핵심 전략

완료된 작업을 오래된 체크포인트로 복원하는 문제를 막는다. 실패 원인을 작은 메타데이터로 구분한다. 운영 로그와 지속 실행 기록을 직접 연결한다. 기존 저장·중복 방지·프로토콜 검증 경로를 사용한다.

이번 범위는 기존 32개 항목의 운영 개선 부분집합이다. 단계 상태 머신, 새 실행 엔진, 자동 재시도, 새 데이터베이스를 추가하지 않는다. MCP 작업 완료와 소비 프로젝트의 완료 권한은 분리한다. Kernel 완료 권한을 MCP가 대신하지 않는다.

실행 순서는 **W0 기준 고정 → W1 완료 기록 정합성 → W2 관측 식별자·오류 진단 → W3 시간 초과 보고 → W4 프로토콜 호환 검증 → W5 통합·배포 검증**이다. 호스트 시작 지연은 별도 조사 O1로 처리한다.

진행 상태는 [실행 상태표](OPERATIONS-2026-10-16-STATUS.md)에 기록한다. 기존 전체 계획의 상태를 이 부분집합의 완료로 대체하지 않는다.

## 2. 관측 근거와 현재 코드

관측 기간은 10월 13일 23:40:28.966부터 16일 23:40:28.966까지다. 한국 시간이며 시작 포함, 종료 제외다. 원본 자료와 리뷰는 `docs/runtime/review-2026-10-16/`에 있다. 원본 로그, 작업 내용, 계정 정보는 이 계획에 포함하지 않는다.

| 근거 | 확인된 사실 | 구현상 의미 |
| --- | --- | --- |
| E1 | 완료된 계획 작업의 summary와 checkpoint.remaining/blockers가 상충 | complete()는 기존 checkpoint를 유지하고 evidenceRefs만 교체한다. 완료 입력에 최종 checkpoint가 없다. |
| E2 | 운영 로그와 실행 receipt의 bootId가 다름. sessionId로는 319건 모두 연결됨 | createServices와 TaskStore가 각각 UUID를 생성한다. 저장 유실은 확인되지 않았다. |
| E3 | 도구 오류 9건 중 다수가 tool_failure로만 분류됨 | runTool은 ENOENT/EACCES/EPERM 외 오류를 같은 값으로 기록한다. |
| E4 | 명령 319건 중 실패 38건, 그중 시간 초과 10건 | exec/run timeoutMs 기본값은 이미 0이다. 호출자가 지정한 120~240초 제한을 서버 기본 제한으로 오인하면 안 된다. |
| E5 | 지원하지 않는 프로토콜 버전 요청 1건이 HTTP 400으로 거절됨 | 현재 SDK의 후속 HTTP 요청 버전 검증 경로에서 거절됐다. 서버가 미지원 버전을 받아야 한다는 증거는 아니다. |
| E6 | health 공백 7시간 3분 43초와 Windows 종료·시작 기록이 일치 | 애플리케이션 retry로 해결할 수 없다. OS 시작 후 health 복구 약 13분의 원인은 추가 조사 대상이다. |

소스 진입점:

- 완료 처리: `src/continuity/task-service.ts`, `task-tools.ts`, `context-summary.ts`.
- 저장: `src/continuity/task-store.ts`, `storage-schema.ts`, `storage-journal.ts`.
- 관측: `src/mcp-server.ts`, `src/telemetry.ts`, `src/tool-result.ts`, `src/http-server.ts`.
- 실행: `src/exec-tools.ts`, `src/process-manager.ts`, `src/continuity/execution-recorder.ts`.
- 보고·검증: `scripts/usage-report.mjs`, `scripts/live-probe.mjs`, `scripts/verify-live.mjs`.

한계: 사용 로그에는 명령과 출력 본문이 없다. 실패 38건을 제품 결함 38건으로 해석하지 않는다. W8 문서의 회귀 통과 주장은 이번 MCP 개선의 테스트 통과 근거가 아니다.

## 3. 기존 계획과 연결

| 이번 항목 | 기존 ID | 이번에 완료할 범위 | 이번에 완료로 표시하지 않을 범위 |
| --- | --- | --- | --- |
| W1 | MCP-03, MCP-04 | 최종 checkpoint와 terminal 상태의 원자 저장·구조 검사 | 전체 단계 전이, 외부 완료 권한·근거 검증 체계 |
| W2 | MCP-19, MCP-20 | 공통 bootId, 오류 코드 허용 목록, 기존 sessionId 연결 | 파일 변경·stdin receipt, 단계별 전체 상관관계 |
| W3 | MCP-20, MCP-24, MCP-25 | 제한 시간·종료 원인 보고와 긴 실행 안내 | 적응형 스케줄러, 전체 성능 벤치마크 체계 |
| W4 | MCP-06, MCP-23 | 설치 SDK의 협상·버전 거절 시험, 클라이언트 확인 절차 | MCP Events, MCP 2.0 도입, 클라이언트 지원 보장 |
| W5 | MCP-26, MCP-32 | 이번 변경의 회귀·배포·복구 검증 | 기존 32개 항목 전체 수용 시험 |
| O1 | 운영 조사 | 호스트 시작 지연 분해 | 전원 정책 변경, 부팅 작업 설치, 별도 서버 이전 |

## 4. W0 — 기준 고정

선행 조건: 없음. 제품 변경 전에 수행한다.

1. 현재 HEAD, 작업 트리, build ID, 설치 SDK 버전, 실제 배포 build ID를 기록한다. 계획 기준과 달라졌으면 해당 차이를 먼저 검토한다.
2. 기존 `npm run typecheck`와 `npm test`를 실행한다. 실패가 있으면 이번 변경과 구분한다.
3. E1~E5를 재현할 합성 fixture를 준비한다. 실제 사용자 task, 토큰, 경로, 명령 내용을 복사하지 않는다.
4. 저장 schema v2, writeWorkspace, requestId dedupe, revision CAS, unresolved execution 차단 계약을 확인한다.

완료 기준 W0-A: 재현 입력, 기대 결과, 기준 테스트 결과, 기준 commit을 상태표에 기록한다. 운영 자료를 공개 테스트 fixture로 사용하지 않는다.

## 5. W1 — 완료 상태와 최종 체크포인트를 함께 저장

우선순위 P0. 범위 M. 선행 W0.

### 입력과 저장 계약

`complete_work`에 선택 입력 `finalCheckpoint`를 추가한다. 기존 checkpoint 필드 중 `evidenceRefs`와 `executionReconciliations`는 제외한 terminal 전용 스키마를 사용한다. evidenceRefs의 입력 권위는 기존 complete_work 최상위 필드 하나로 유지한다. 실행 reconciliation은 기존 checkpoint_work 경로에서 먼저 수행한다. complete_work가 unknown 실행을 암묵적으로 해결하지 않는다.

completed 처리:

1. finalCheckpoint가 있으면 이를 후보로 사용한다. 없으면 저장된 checkpoint를 후보로 사용한다.
2. 후보는 `phase=completed`, 비어 있지 않은 current, `remaining=[]`, `blockers=[]`를 만족해야 한다. current의 기존 2,048자 제한과 checkpoint 전체 바이트 제한을 유지한다. summary를 잘라 current에 자동 복사하지 않는다.
3. 조건이 맞지 않으면 `completion_checkpoint_conflict`를 반환한다. 상태와 revision, activeTaskId는 변하지 않는다. 오류에는 bounded count와 get_work_context 조회 안내만 제공한다.
4. 남은 일과 blocker를 서버가 임의로 삭제하지 않는다. 자연어 current와 summary의 의미가 같은지 서버가 증명할 수는 없다. 구조 검사 통과를 실제 작업 완료의 증명으로 표현하지 않는다.
5. 기존 prepared/running/unknown 차단과 callerResolution 검사를 그대로 적용한다. 과거 nonzero exit가 있다는 이유만으로 영구 완료 불가 상태를 만들지 않는다.
6. 기존 workspace lock 안에서 최종 checkpoint, status, summary, revision, activeTaskId, dedupe 결과를 같은 writeWorkspace로 저장한다. 저장된 reconciliation은 유지한다. 새로운 저장 엔진을 추가하지 않는다.

abandoned 처리:

- prepared/running 차단은 유지한다. unknown 처리 정책도 현재 계약을 유지한다.
- phase는 abandoned로 정규화한다. 남은 작업과 blocker는 보존한다. finalCheckpoint가 있으면 명시 입력을 사용한다.
- 프로세스를 종료하거나 과거 실행을 재시도하지 않는다.

호환 계약:

- 저장 schema v2 필드 형식은 유지한다. finalCheckpoint는 도구 입력이며 새 persistent 필드가 아니다.
- 이전 클라이언트는 checkpoint_work로 완료 조건을 만족하는 checkpoint를 저장한 뒤 기존 complete_work 호출을 사용할 수 있다.
- 기존처럼 미정리 checkpoint를 완료 처리하던 호출은 명시 오류를 받는다. 이를 행동 호환성 변경으로 릴리스 문서와 도구 설명에 표시한다.
- requestId HMAC에 finalCheckpoint의 존재와 내용을 포함한다. 입력 생략 시 기존 HMAC 구조를 보존한다. dedupe 확인은 활성 상태·revision·신규 완료 조건 검사보다 먼저 수행한다.
- 이전 버전에 이미 저장된 동일 requestId는 원래 결과를 반환한다. 과거 완료 상태를 재작성하지 않는다. 같은 requestId에 finalCheckpoint를 추가하면 다른 입력이므로 충돌이다.
- context에 completed checkpoint의 구조 불일치를 나타내는 파생 경고를 추가한다. 이 경고는 읽기 전용이며 과거 작업을 재개하거나 자동 수정하지 않는다. summary와 full 모두 경고를 보존한다.

변경 파일: task-tools.ts, task-service.ts, context-summary.ts, templates/chatgpt-project-instructions.md, README.md. 저장 코드는 기존 원자 저장 경로의 재사용에 필요한 범위에서만 변경한다.

수용 기준:

- W1-A: remaining 또는 blockers가 있는 completed 요청은 실패하며 파일 상태가 바뀌지 않는다.
- W1-B: 최종 checkpoint를 전달하면 terminal 상태와 active pointer가 함께 저장되고 재시작 후 같은 결과가 조회된다.
- W1-C: 동일 requestId 재전송은 revision을 추가 증가시키지 않는다. 다른 최종 입력과 stale revision은 거절된다.
- W1-D: 저장 실패 직후와 재시작 복구 후 각각 active/terminal, checkpoint, dedupe가 섞인 부분 상태가 없다. 기존 저장 실패 주입 시험을 확장한다.
- W1-E: running/unknown 차단, abandonment 정책, reconciliation 보존 시험이 통과한다.
- W1-F: 과거 불일치 상태는 조회 경고를 반환하고 원본 파일을 바꾸지 않는다. 구형 동일 요청 replay가 유지된다.

검증: `test/continuity.test.ts`, `test/continuity-storage.test.ts`, `test/recovery.integration.test.ts`, `test/all-tools.integration.test.ts`의 해당 계약을 확장한다.

## 6. W2 — 관측 식별자와 오류 진단

우선순위 P1. 범위 M. 선행 W1.

### 공통 bootId

createServices에서 TaskStore를 ProcessManager보다 먼저 만든다. UsageLog의 lifecycle 이벤트는 TaskStore.bootId를 사용한다. TaskStore가 생성하는 현재 ID를 재사용하므로 새 UUID 주입 옵션이나 별도 registry가 필요하지 않다. 한 서비스 인스턴스에서는 동일하고, 새 인스턴스에서는 새 ID를 사용한다. 과거 receipt와 로그는 다시 쓰지 않는다.

신규 로그는 `(bootId, sessionId)`로 연결한다. 과거 서로 다른 bootId 자료는 legacy로 표시한다. 자동으로 같은 부팅으로 합치지 않는다. 필요 시 sessionId 유일성과 종료 결과 일치를 확인한 별도 진단만 허용한다.

### 오류 계약

기존 errorCategory를 유지하고 선택 필드 errorCode를 추가한다. 로그에는 고정 허용 목록 값만 기록한다. 미등록 code는 `other`다. error.message, details, 경로, 명령, 출력, 토큰은 복사하지 않는다.

첫 범위: `file_missing`, `permission_denied`, `replacement_mismatch`, `patch_check_failed`, `process_session_unknown`, `revision_conflict`, `idempotency_conflict`, `tracking_required`, `completion_checkpoint_conflict`, `unresolved_execution`, 기존 저장 오류 중 선별된 코드, `other`.

- replace/patch는 실패한 검사 지점에서 typed error를 만든다. 문장을 파싱해서 분류하지 않는다. patch --check 실패와 실제 적용 실패를 구분한다.
- process 조회는 `process_session_unknown`을 기록한다. 존재하지 않는 ID와 만료·eviction을 구분할 근거가 없으므로 `expired`라고 단정하지 않는다. 새 tombstone 저장소는 추가하지 않는다.
- Zod/SDK 입력 오류는 실제 반환 경로에서 식별 가능한 경우에만 별도 코드로 분류한다. runTool에 도달하지 않은 요청을 성공으로 집계하지 않도록 시험한다.
- HTTP 상태, MCP isError, process exit은 별도 집계 축으로 유지한다.

변경 파일: src/mcp-server.ts, telemetry.ts, tool-result.ts, errors.ts, http-server.ts, process-manager.ts, file-service.ts.

수용 기준:

- W2-A: tracked exec/run 각각의 start, terminal, receipt에 bootId와 sessionId가 일치한다. 두 서비스 인스턴스의 bootId는 다르다.
- W2-B: 기존 restart unknown 처리와 중복 spawn 방지가 유지된다.
- W2-C: 합성 replace/patch/session 오류가 정확한 코드를 남긴다. 일반 오류가 특정 원인으로 추정되지 않는다.
- W2-D: command, path, 출력, 비밀 값, 임의 오류 코드에 심은 sentinel이 로그에 없다. 이벤트 크기와 기존 대기열·회전 제한이 유지된다.

검증: test/execution-observability.test.ts, test/file-service.test.ts, test/process-manager.test.ts, test/recovery.integration.test.ts.

## 7. W3 — 시간 초과·실패 보고서와 호출 안내

우선순위 P1. 범위 S~M. 선행 W2.

1. process_started/terminal에 호출자가 요청한 `timeoutMs`를 선택 메타데이터로 기록한다. 0은 제한 없음이며, 과거 필드 누락은 미상이다. receipt schema에는 이번 단계에서 필드를 추가하지 않는다.
2. 보고서에서 HTTP 실패, tool 오류, nonzero exit, timeout, signal, spawn failure를 구분한다. timeout과 nonzero가 겹치면 총 실패에서 한 번만 센다.
3. 시간 초과 제한별 건수와 누적 실행 시간을 표시한다. 누적 시간은 벽시계 지연이나 전부 낭비된 시간으로 표시하지 않는다.
4. 성공 실행 시간과 도구 외 추가 시간을 분리한다. 서로 다른 명령의 p95를 동일 작업의 성능 비교로 사용하지 않는다.
5. 사용자 지침에 yieldTimeMs/read wait와 실행 timeoutMs의 차이를 설명한다. 긴 검증은 실행 단위를 나누고 호출자가 제한을 선택한다. 서버 기본값 0과 강제 종료 유예는 변경하지 않는다.
6. timeout 뒤에는 기존 receipt와 작업 결과를 확인한다. 같은 operationId에 timeout만 바꾸면 입력 충돌이며, 새 operationId는 새 실행이다. 서버가 새 ID를 발급해 재시도하지 않는다.

변경 파일: src/process-manager.ts, telemetry.ts, mcp-server.ts, scripts/usage-report.mjs, templates/chatgpt-project-instructions.md, docs/performance.md.

수용 기준:

- W3-A: timeout 0/양수/과거 누락이 구별된다. 시작과 종료의 제한 시간이 일치한다.
- W3-B: 합성 fixture의 실패·timeout 중복 집계가 없다. probe 제외와 기간 경계가 유지된다.
- W3-C: 응답 전후 종료 모두 기록된다. 클라이언트가 polling하지 않아도 종료 이벤트가 남는다.
- W3-D: 같은 작업 단위를 사용한 비교 자료가 없으면 개선률을 출력하지 않는다.

검증: test/execution-observability.test.ts, test/process-manager.test.ts. 보고서 fixture는 실제 명령을 재실행하지 않는다.

## 8. W4 — 프로토콜 협상과 실제 클라이언트 경계 검증

우선순위 P1. 범위 S. 선행 W2. 최종 통합은 W3 뒤에 수행한다.

현재 package-lock의 SDK를 기준으로 먼저 재현한다. 최신 SDK 번호를 추정하지 않는다. SDK를 바꿔야 할 근거가 나오면 공식 릴리스·호환 자료를 확인하고 별도 의존성 변경 범위로 기록한다.

1. 지원되는 initialize 버전, 미지원 initialize 버전, 협상된 버전의 후속 요청, 미지원 HTTP 헤더, 헤더 생략을 각각 시험한다.
2. 초기 협상과 후속 요청의 거절 정책을 구분한다. 설치 SDK의 지원 목록을 사용한다. 요청 헤더를 강제 치환하거나 미지원 버전을 허용하지 않는다.
3. 현재 stateless-json 구조에 클라이언트별 협상 상태 저장소를 추가하지 않는다. 서버가 요청 사이 클라이언트 동일성을 보장한다고 주장하지 않는다.
4. HTTP 요청 관측에 지원 여부를 bounded enum으로 남긴다. SDK 지원 버전은 기록할 수 있으나 임의 header 원문은 저장하지 않는다. 거절 시 실제 응답 status와 함께 분류한다.
5. live probe가 initialize의 실제 응답 protocolVersion을 후속 요청에 사용하도록 확인한다. 정적 값만 검사하는 경로가 있으면 수정한다.
6. 서버 catalog 검증과 실제 클라이언트 catalog 갱신 확인을 별도로 기록한다. 클라이언트에 접근할 수 없으면 해당 검증은 미검증으로 남긴다.

변경 파일: src/http-server.ts, telemetry.ts, scripts/live-probe.mjs, scripts/verify-live.mjs, test/mcp.integration.test.ts, test/auth-security.integration.test.ts.

수용 기준:

- W4-A: 지원 버전의 초기화·후속 요청이 성공한다. 미지원 initialize 처리 결과는 SDK 계약과 일치한다.
- W4-B: 미지원 후속 헤더 요청은 HTTP 400이며 도구 부작용이 없다. 원문 header나 인증 정보가 로그에 남지 않는다.
- W4-C: 헤더 생략 정책과 인증·Host 검증이 유지된다. probe가 협상된 버전을 사용한다.
- W4-D: 서버 검증과 클라이언트 검증을 별도 상태로 기록한다. 실제 클라이언트 성공 자료 없이 10월 15일 문제가 해결됐다고 표시하지 않는다.

## 9. O1 — 호스트 시작 지연 조사

우선순위 P2. 제품 구현과 독립된 읽기 전용 조사다.

Windows 시작, 사용자 로그인, Docker 엔진 준비, 컨테이너 시작, 로컬 health, 외부 probe 시각을 분리해 측정한다. 접근 가능한 기존 이벤트만 읽고 빠진 구간은 미상으로 남긴다. 전원 끄기나 재부팅을 시험 수단으로 사용하지 않는다.

현재 compose의 restart 정책이 있음도 확인한다. `scripts/start.ps1`은 build, helper sync, force-recreate를 수행하므로 부팅 시 단순 상태 확인용으로 등록하지 않는다.

완료 기준 O1-A: 관측 가능한 지연 구간, 원인 후보, 미확인 구간과 필요한 최소 변경을 문서화한다. 일정 작업 설치, Docker 시작 설정, 전원 정책 변경은 이 조사 완료와 별도 변경이다. 자동화 생성이나 재부팅은 이 계획 작성의 실행 범위가 아니다.

## 10. W5 — 통합 검증, 배포, 관측

선행 W1~W4. O1은 별도 상태로 남길 수 있다.

### 구현 검증

각 Wave에서 관련 focused suite를 실행한다. 최종 후보에서 `npm run typecheck`, `npm test`, `npm run build`, `npm audit --omit=dev`, `node scripts/check-public-config.mjs`, `npm run integration:docker`를 실행한다. 같은 후보가 통과하면 근거 없이 반복 실행하지 않는다. 실패 수정으로 후보가 바뀌면 영향 범위를 다시 확인한다.

정적 점검: 새 authority·자동 재시도·개인 경로 하드코딩이 없는지 확인한다. telemetry 출력과 보관 예산을 확인한다. schema v2 읽기, 구형 complete 요청 replay, 신규 complete 요청을 포함한 역호환 fixture를 확인한다.

### 배포 검증

- 구현 완료와 운영 배포 완료를 구분한다. 배포 권한이 있는 실행에서만 기존 start.ps1의 active-process guard를 사용한다. busy 또는 preflight 실패 시 실행 중 서비스를 보존한다.
- 기존 image identity, volume 이름과 상태 백업 절차를 기록한다. 라이브 쓰기 중인 디렉터리의 단순 복사를 일관된 백업으로 취급하지 않는다. 백업이 필요하면 writer가 정지된 구간에 수행한다.
- 배포 뒤 `npm run post-deploy:verify`로 source/image, OAuth, catalog, 실행 추적 입력을 확인한다. finalCheckpoint 공개 스키마를 추가 검증한다. 도구 수를 불필요하게 늘리지 않는다.
- 전용 임시 작업공간에서 create → tracked exec → finalCheckpoint complete → context를 검증한다. 실제 진행 중인 소비 프로젝트 task는 수정하지 않는다.
- 이전 이미지로 복구 가능한지 임시 상태 복제본으로 확인한다. schema v2 유지 여부만으로 rollback 가능을 단정하지 않는다. 복구 시 volume 삭제와 과거 receipt 수정은 하지 않는다.

### 관측 기준

배포 직후 합성 성공·실패·timeout·완료 사례를 확인한다. 이후 최초 24시간의 실제 사용 자료를 수동 수집한다. 사용이 없거나 클라이언트 확인이 불가능하면 운영 효과는 미검증이다. 이 계획이 예약 작업을 자동 생성하지는 않는다.

- 신규 tracked 실행의 start/terminal/receipt 식별자 일치.
- 신규 completed 작업의 구조 불일치 0건. 과거 경고는 분리 집계.
- 통제된 오류 사례의 분류 성공과 민감 정보 미기록.
- writeFailures/droppedEvents, unknown 실행, terminal 누락의 관측값. 로그 보존 범위 밖을 0으로 간주하지 않는다.
- timeout 비율은 실제 작업 구성과 표본 수를 함께 표시한다. 실패 38건 또는 11.9%를 그대로 새 배포의 성능 기준으로 사용하지 않는다.

완료 기준 W5-A: 구현 검증 결과, 배포 유무, 서버 확인, 실제 클라이언트 확인, 운영 관측을 각각 기록한다. 배포나 관측을 하지 않은 상태를 전체 운영 개선 완료로 표시하지 않는다.

## 11. 변경 경계와 시작 지침

이번 계획 작성은 제품 코드, 운영 설정, 기존 task 상태를 변경하지 않는다. 원본 로그는 ignored runtime 디렉터리에 유지한다. 기존 과거 completed 기록을 일괄 수정하지 않는다.

구현을 시작할 때 W0부터 수행한다. 각 Wave는 자신의 수용 기준과 관련 회귀 결과를 기록한 뒤 다음 Wave로 진행한다. Kernel 실행으로 전환하는 경우 그 시점의 Kernel work unit과 허용 경로를 따른다. 이 문서를 실행 허가나 Kernel 완료 receipt로 사용하지 않는다.

커밋·푸시가 작업 범위에 포함되면 각 Wave의 문제, 변경, 검증, 미완료 항목을 상세한 한국어로 작성한다. 구현 근거가 없는 planned 항목의 상태는 바꾸지 않는다.

## 2026-10-17 후속 종료 요청

- 사용자는 운영 개선 구현의 커밋·푸시와 Docker 재기동을 요청했다. 커밋 메시지는 변경 동작, 검증 결과와 호환 한계를 상세한 한국어로 기록한다.
- 기존 인증 토큰, OAuth 승인 키, 환경 설정과 영속 볼륨을 보존한다. 비밀 값은 출력하거나 커밋하지 않는다. 기존 시작 스크립트의 실행 중 작업 검사 후 컨테이너를 재생성한다.
- 재기동 전후에 기존 인증 기록과 키의 보존, 컨테이너 건강 상태와 배포 검증 결과를 확인한다. 새 검사에 쓰는 임시 인증 grant는 기존 사용자 grant와 구분한다.
- 기존 구현 검증은 운영 개선 Run과 실행 근거 문서에 있다. 후속 문서 Run은 이 종료 절차의 기록과 커밋 범위를 검증한다. 이 요청은 실제 ChatGPT 클라이언트 확인이나 24시간 관측의 완료를 뜻하지 않는다.
