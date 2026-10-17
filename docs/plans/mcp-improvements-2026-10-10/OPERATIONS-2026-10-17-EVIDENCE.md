# 운영 개선 실행 근거

## W0 기준 고정

- 기준 HEAD: `d8caa670f6b93c05b62f5e32a8ccefda9809934f`.
- source 및 실제 배포 build ID: `src-d28a71b98e34f1dffba9`.
- 실제 배포 image: `sha256:d8843d4d9c8ae7939198a3490f158711c58e0ca3e9036b7a5c076a60373cedfa`.
- 설치 SDK: source/deployment 모두 `1.32.1`. Windows Node `24.18.0`, 배포 Node `22.23.3`.
- 기존 문서 변경 3개는 보존한다. 사용자가 현재 문서를 새 Kernel 기준으로 승인했다.
- Windows `npm run typecheck`: exit 0. `npm test`: exit 1, 93 pass / 23 fail. POSIX 경로, `/bin/bash`, 권한 차이 및 공용 writer 충돌을 포함한다. 제품 수정 전 결과다.
- 격리 Linux development 이미지의 `npm run typecheck && npm test && npm run build`: 모두 통과. 14 suites / 116 tests. 실제 배포 이미지는 dev dependencies를 포함하지 않으므로 production 이미지에서 직접 테스트하지 않는다.
- 저장 계약: schema v2, workspace lock, 단일 writeWorkspace, dedupe 우선, revision CAS, prepared/running/unknown 차단을 확인했다.

## 합성 재현 입력과 기대 결과

실사용 task, 경로, 명령, 계정, 로그를 fixture로 복사하지 않는다.

| 근거 | 합성 입력 | 변경 전 | 수용 결과 |
| --- | --- | --- | --- |
| E1 | remaining=[verify]인 active checkpoint를 completed로 처리 | 오래된 checkpoint 유지 | conflict, 무변경. 명시 finalCheckpoint로 원자 완료 |
| E2 | 임시 workspace에서 tracked exec/run 실행 | 로그와 receipt가 별도 bootId 사용 | start/terminal/receipt의 bootId+sessionId 일치 |
| E3 | replacement 불일치, patch --check 실패, 알 수 없는 process session | 포괄 tool_failure | 허용된 구체 코드, sentinel 비기록 |
| E4 | timeoutMs=0, 양수, 과거 필드 누락의 합성 lifecycle JSONL | 제한별 집계 없음 | 무제한/양수/미상 구분, 실패 중복 합산 없음 |
| E5 | 설치 SDK 지원/미지원 initialize 및 후속 header | 후속 미지원 header HTTP 400 | SDK 협상 계약, 부작용 없음, 원문 header 비기록 |

## 독립 조사 O1: 읽기 전용 관측

- Windows System: 종료 2026-10-15 00:12:05 KST (Kernel-General 13), 시작 07:01:38 (12), EventLog 시작 07:01:49 (6005).
- Docker가 보고한 현 컨테이너 시작: 2026-10-15 07:14:43.7369666 KST. restart policy: `unless-stopped`.
- 기존 review 자료의 최초 health 성공: 07:14:49 KST. 이는 외부 요청의 연속 관측이 아니다.
- 관측 구간: OS 시작→컨테이너 시작 약 13분 6초, 컨테이너 시작→최초 기록 health 약 5초.
- 사용자 로그인과 Docker 엔진 준비 시각은 아직 미상이다. 원인 후보는 로그인/엔진 준비/서비스 시작 순서다. restart policy는 호스트와 엔진 준비 전의 지연을 설명하지 않는다.
- 최소 추가 자료: 기존 로그인 및 Docker Desktop 시작 로그의 해당 시각. 재부팅, 전원 정책 변경, 예약 작업 등록은 수행하지 않는다.

## W1 완료 checkpoint

- finalCheckpoint는 input 전용이다. schema v2와 단일 writeWorkspace를 유지한다. dedupe를 CAS/terminal 검사보다 먼저 확인하며 생략 입력 HMAC을 유지한다.
- completed 구조 충돌은 파일·revision·active pointer를 바꾸지 않는다. abandoned는 phase를 정규화하며 남은 일·blocker와 reconciliation을 보존한다.
- 과거 completed 불일치는 summary/full 경고만 제공한다. 구형 요청 replay는 과거 결과를 반환한다.
- 실제 기존 current 입력 제한은 4,096자였다. 기존 checkpoint 입력은 보존한다. 새 finalCheckpoint current는 계획의 2,048자를 적용한다.
- focused: `npx vitest run test/completion-checkpoint.test.ts test/continuity.test.ts test/continuity-storage.test.ts` exit 0, 51 pass. typecheck exit 0.
- 원자 저장 실패·재시작, CAS, replay, legacy warning, abandonment, reconciliation 시험 포함. recovery/all-tools Linux 통합은 W5에서 확인한다.

## W2 관측 식별자와 오류

- TaskStore를 먼저 생성하고 lifecycle과 receipt가 같은 bootId를 사용한다. 신규 서비스 인스턴스마다 ID가 다르다. 과거 기록은 변경하지 않는다.
- typed replace/patch check/apply/session 오류와 고정 errorCode 허용 목록을 적용했다. 기존 errorCategory와 queue/rotation 한도를 유지한다. 알 수 없는 code는 other다.
- SDK/Zod가 runTool 전에 거절한 요청의 toolError는 null이다. 이를 실행 성공 false로 바꾸지 않는다.
- Linux focused: recovery 3, process-manager 13, observability 4, file-service 8 pass. diagnostic-codes는 유효 UUID fixture 수정 뒤 2 pass. typecheck pass.
- 실제 HTTP 경로에서 sentinel 본문·경로·토큰·오류 code의 비기록, session 오류, SDK 검증 전 거절을 확인했다.

## W3 시간 초과와 보고서

- lifecycle 양쪽에 요청 timeoutMs를 기록한다. 0/양수/과거 누락을 구분하고 receipt schema는 유지한다.
- 보고서는 HTTP/tool/nonzero/timeout/signal/spawn 축과 유일 실패 합계를 분리한다. SDK 사전 거절은 toolUnobserved다. 성공 실행 시간과 요청 tool 외 시간을 분리하며 개선률을 출력하지 않는다.
- Linux typecheck 및 observability/process-manager/usage-report: exit 0, 18 pass. 응답 이전 종료와 응답 이후 polling 없는 종료를 포함한다.
- 합성 JSONL fixture는 기간 경계/probe 제외, 누락 제한 시간, 중복 실패 축을 확인한다. 실제 명령을 재실행하는 fixture가 아니다.

## W4 프로토콜 경계

- SDK 1.32.1의 설치된 SUPPORTED_PROTOCOL_VERSIONS를 사용한다. 미지원 initialize는 SDK 최신 지원 버전으로 협상한다. 후속 미지원 header는 HTTP 400이다. header 생략은 SDK 기본 정책을 유지한다.
- 임의 protocol header는 request 로그 및 transport console에 남기지 않는다. 지원 여부 enum과 허용 버전만 기록한다. stateless 구조와 인증/Host 경계를 유지한다.
- live probe가 origin별 initialize의 실제 응답 버전을 후속 요청에 전달한다. public finalCheckpoint schema와 24개 도구를 검사한다. 실제 클라이언트 검증은 별도 false다.
- Linux typecheck 및 protocol/mcp/auth-security: exit 0, 10 pass. 미지원 header로 write_file 호출 시 부작용 없음과 sentinel 비기록을 확인했다.
- 실제 ChatGPT catalog 갱신/호출 및 운영 효과는 아직 미검증이다. 10월 15일 클라이언트 문제가 해결됐다고 주장하지 않는다.


## W5 통합과 복구 검증

- 후보 build: `src-c0313a0ff62a55ad16e6`. development 이미지 생성 과정의 typecheck/test/build: exit 0, 19 suites / 130 tests.
- `npm audit --omit=dev`: exit 0, vulnerabilities 0. `node scripts/check-public-config.mjs`: exit 0.
- `node scripts/verify-rollback.mjs --image chatgpt-remote-mcp:verify --previous-image <기준 image ID>`: exit 0.
- 운영 데이터가 아닌 전용 임시 volume에 신규 finalCheckpoint 완료와 구형 생략 입력 완료를 저장했다. writer를 닫은 뒤 기준 이미지에서 상태 읽기, 구형 replay, 추가 create/complete 쓰기, schema v2와 active pointer를 확인했다. 임시 volume만 제거했다.
- 롤백 호환 한계: 이전 이미지에서 신규 finalCheckpoint가 포함된 요청을 replay하면 HMAC 입력 계약 차이로 idempotency_conflict다. 구형 생략 입력 replay는 성공한다. 신규 기록 읽기와 추가 쓰기 가능을 검증했으며 신규 입력 replay 성공을 주장하지 않는다.
- 실제 배포는 기존 start.ps1로 수행한다. 시작 전 preflight activeManagedProcesses=0. start.ps1의 두 번째 guard가 실패하면 기존 서비스를 보존한다.
- 영속 경계: continuity/OAuth는 `<MCP_STATE_VOLUME>`의 `/var/lib/cokacremote`, 사용 로그는 `<MCP_USAGE_VOLUME>`, 홈은 `<MCP_HOME_VOLUME>`이다. 이미지 기준은 W0의 immutable ID다.
- 이번 검증은 라이브 상태를 복사하지 않았다. 일관된 운영 백업이 필요하면 preflight 후 writer 정지·종료 확인, state volume archive, writer 재시작 순서가 필요하다. live copy를 백업이라고 표시하지 않는다. 운영 volume 삭제와 과거 receipt 수정은 수행하지 않는다.
- 커밋·푸시는 요청되지 않았다. 모든 Wave baseCommit은 W0 HEAD이며 resultCommit은 uncommitted다. docs/performance.md는 기존 ignore 정책 아래 로컬 문서이며 이번 실행에서 갱신했다.

### 배포 및 즉시 관측

- start.ps1: exit 0. 실제 재생성 전 guard도 통과했다. 배포 시작: 2026-10-17 00:22:12.708 KST.
- 배포 image: `sha256:79017fde6b8c1ce9207d6b50a2c47058ef1f0c5192c4e8f1d5e1534fa0ebc912`, build `src-c0313a0ff62a55ad16e6`.
- `npm run post-deploy:verify`: exit 0. source/image 일치, OAuth·public MCP·proxy·helper·telemetry 검증, 24개 도구와 finalCheckpoint catalog 확인. 협상 버전 `2025-11-25`.
- 임시 workspace의 성공/exit 7/timeout 실행 3개, finalCheckpoint 완료와 동일 요청 replay를 확인했다. 서버 catalog 확인은 실제 ChatGPT 클라이언트 확인이 아니다.
- 즉시 retained 자료: 현 build MCP 요청 25건, start 3/terminal 3, start-terminal-receipt 연결 불일치 0, 신규 completed 구조 충돌 0/1건, unknown 0, terminal 누락 0, timeout 1. 합성 smoke 표본이다. 실제 사용 효과나 24시간 관측으로 해석하지 않는다.
- diagnostics: pendingEvents=0, droppedEvents=0, writeFailures=0. 로그 보존 범위 밖은 미상이다.
- 최초 24시간 관측 구간: 2026-10-17 00:22:12.708부터 2026-10-18 00:22:12.708 KST까지. 아직 기간이 끝나지 않았다. 예약 작업은 만들지 않았다.
- 실제 ChatGPT 클라이언트 catalog 갱신/호출 확인은 접근 가능한 클라이언트 세션이 없어 NOT_VERIFIED다. 소비 프로젝트의 기존 task는 수정하지 않았다.
- Kernel 최종 bound 명령은 static-analysis=`build`, unit-test=`integration:docker`로 요청한다. 최종 권한은 이 Run의 canonical continuation이며 이 문서는 완료 receipt가 아니다.

## 수용 기준 대조표

각 pass는 해당 기준의 범위에만 적용한다. 전체 운영 효과의 완료를 뜻하지 않는다.

| 기준 | 결과 | 근거 |
| --- | --- | --- |
| W0-A | pass | 기준 HEAD/build/SDK, Windows 실패와 Linux 116 pass, 합성 E1~E5 |
| W1-A | pass | completion-checkpoint: remaining/blocker/phase/blank 충돌의 파일 무변경 |
| W1-B | pass | final checkpoint·pointer·dedupe 저장 및 재시작; 실제 smoke |
| W1-C | pass | 동일 replay, 변경 입력 충돌, stale CAS |
| W1-D | pass | write 실패 전/visible snapshot sync 실패/재시작의 완전 상태 확인 |
| W1-E | pass | 기존 running/unknown/recovery, abandonment 및 reconciliation 보존 |
| W1-F | pass | legacy summary/full 경고의 무변경, 생략 입력 replay |
| W2-A | pass | tracked exec/run 양쪽 bootId+sessionId; 별도 서비스 boot 분리; 실제 smoke 연결 |
| W2-B | pass | restart unknown 및 reply loss 후 duplicate spawn 방지 회귀 |
| W2-C | pass | typed replacement/patch-check/session, generic other, SDK 사전 거절 |
| W2-D | pass | sentinel 비기록과 기존 telemetry queue/rotation 회귀 |
| W3-A | pass | 0/100 lifecycle 일치, 과거 timeout 필드 누락 fixture |
| W3-B | pass | 합성 실패 중복 집계/probe 제외/기간 경계 |
| W3-C | pass | 응답 전 종료 및 응답 후 polling 없는 종료 |
| W3-D | pass | 개선률 미출력, 성공 실행과 요청 추가 시간 분리 |
| W4-A | pass | 설치 SDK 전체 지원 initialize/follow-up와 미지원 initialize 협상 |
| W4-B | pass | 미지원 header HTTP 400, write 부작용 없음, 원문 비기록 |
| W4-C | pass | header 생략/인증/Host 회귀; 실제 probe 협상 버전 사용 |
| W4-D | pass | 서버 VERIFIED / 실제 클라이언트 NOT_VERIFIED 분리 |
| W5-A | pass | 구현/배포/서버/실제 클라이언트/관측을 각기 기록. 24시간 미관측 명시 |
| O1-A | pass | OS→컨테이너 지연, 원인 후보와 로그인/엔진 미상 구간 문서화 |
