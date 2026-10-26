# MCP 운영 안정성과 복구 성능 최종 개선 계획

작성일: 2026-10-25 KST  
문서 상태: **계획 확정. 2026-10-26 W0~W5 구현·검증 및 운영 배포·서버 검증 완료. 실제 클라이언트·24시간 효과는 미검증.**  
기준 소스: `5719fe03dcded10e4678ce375ddfbbdffeb3fb6f`  
기준 build ID: `src-b111ea24bef00c7f4491`

위 기준은 계획 작성 시점의 분석 기준이다. 실행 결과는 [구현 기록](OPERATIONS-2026-10-26-IMPLEMENTATION.md)과 [배포 기록](OPERATIONS-2026-10-26-DEPLOYMENT.md)을 따른다. 아래 계약·수용 기준은 보존한다.

## 1. 핵심 전략과 문서의 효력

**MCP는 실행·관측·복구를 책임진다. 소비 Harness는 개발 절차·수용 기준·프로젝트 완료를 책임진다.** 이번 개선은 이 경계를 유지하면서 연결 종료, 복구 지연, 조회 반복을 줄인다.

기존 구현은 이번 관측 구간에서 실행 시작·종료와 저장 영수증을 일치시켰다. 다음 작업은 이 기반 위에서 수행한다. 실행 영수증을 생략하거나 검증 강도를 낮춰 속도를 높이지 않는다.

이 문서는 개선 이유, 근거, 구현 계약, 실행 순서와 수용 기준을 함께 고정한다. 미래 구현을 현재 기능으로 표시하지 않는다. 아래에 정한 설정명·신규 응답 필드는 **구현 대상**이다.

문서 간 적용 순서는 다음과 같다.

1. 이번 7개 운영 개선의 범위와 수용 기준은 이 문서를 따른다.
2. 기존 실행·복구·완료 권한 경계는 [EXECUTION-CONTROL.md](EXECUTION-CONTROL.md)를 유지한다.
3. [CONTRACTS.md](CONTRACTS.md)와 기존 BACKLOG의 단계·workflow 상태는 과거 제안이다. 이번 작업이 Harness 단계나 완료 권한을 MCP로 옮기는 근거가 되지 않는다.
4. 기존 BACKLOG는 전체 후보 목록으로 유지한다. 이번 작업을 이유로 다른 후보를 모두 구현하지 않는다.

## 2. 목표와 범위

### 2.1 달성할 결과

- 장기 명령을 조회할 때 외부 연결이 끊기기 전에 제한된 응답을 반환한다.
- 실행 기록이 늘어도 한 작업의 복구 조회가 다른 작업의 전체 이력을 매번 읽지 않게 한다.
- 작업공간 관측의 시간 예산을 Git·파일 읽기까지 적용한다.
- 짧은 명령의 반응성을 유지하면서 장기 명령의 조회·출력 재전송을 줄인다.
- 설정 파일, Compose, 실행 컨테이너의 실효값을 일치시킨다.
- 만료되거나 잘못된 세션의 다음 복구 행동을 명확히 한다.
- 원본 로그에 이미 있는 오류 분류를 보고서에서도 보존한다.

### 2.2 이번 범위 밖의 작업

- 소비 프로젝트의 업무 코드와 개별 시험 실패 수정.
- Kernel Run·프로젝트 계약 재발급, 완료 판정 변경, 승인 기록 수정.
- 파일 편집과 stdin의 새 중복 방지 체계 구축.
- Events, webhook, 신규 전송 프로토콜 도입.
- 저장 영수증 정리·자동 삭제, 운영 데이터의 무단 마이그레이션.
- OAuth·프록시 보안 완화, health check 주기 변경.
- 과거 의존성 취약점 수치를 현재 값으로 사용하는 일.

문서 작성 요청은 제품 구현, Git 게시, 운영 재시작을 실행한 것으로 취급하지 않는다. 이후 구현 요청을 받으면 개발·격리 검증을 진행한다. 운영 배포 권한은 그때의 사용자 요청 범위에 따른다.

## 3. 분석 기준과 증거

### 3.1 고정한 분석 구간

기준 세션은 [개선안 반영 및 구현](codex://threads/01a16c4b-d7e7-71a1-8177-6746058128f9)이다. 마지막 완료 응답은 **2026-10-24 16:32:35 KST**다.

주 분석 구간은 **2026-10-24 16:32:35 이상, 2026-10-25 17:33:00 미만**이다. 새 배포 부팅 시점인 10-24 16:17부터의 기록은 배포 확인용 보조 구간으로만 사용했다. 본문의 운영 수치는 주 분석 구간을 기준으로 한다.

원본 `requests.jsonl`은 20,350행, 9,701,244바이트다. 보존 시작은 10-13 13:54:37이고 마지막 이벤트는 10-25 17:31:22다. 원본 전체를 읽은 뒤 해당 구간을 선택했다. 구간 밖 기록을 이후 실사용 수치에 합치지 않았다.

현재 소스에서 계산한 build ID와 운영 컨테이너 build ID는 같았다. 로그·sidecar·프록시·터널·저장 영수증·작업 checkpoint를 대조했다. 시각과 checkpoint는 **10월 25일 조사 시점의 스냅샷**이다.

### 3.2 증거 목록

| ID | 관측·소스 근거 | 판단에 사용하는 범위 |
| --- | --- | --- |
| E01 | HTTP 요청 1,592건, 실행 시작 243건, 종료 243건 | 주 분석 구간의 규모 |
| E02 | 243개 lifecycle 일치, 저장 영수증 243개 모두 matched, 같은 workspace/operation의 복수 실행 0 | 기존 추적과 중복 방지의 관측 결과 |
| E03 | read_process 연결 종료 16건, 각각 125,006.2~125,041.6ms. Nginx MCP 499도 16건 | 조회 대기와 외부 연결 수명의 불일치 |
| E04 | read_process는 최대 300,000ms, JSON 응답. Nginx read/send timeout은 3,600초 | 현 전송·대기 계약 |
| E05 | openai_mcp context 62회, p50 9,370.6ms, p95 12,465.3ms. HTTP 외곽 overhead p95 6.7ms | 지연의 대부분이 도구 내부라는 근거 |
| E06 | Moonshot workspace 영수증 2,256개·task 26개. task 검색의 workspace 순회, 실행 전체 조회·sync 뒤 task 필터 | 복구 조회의 확장성 문제 |
| E07 | 2,000ms 관측 예산으로 읽기 전용 재현: Moonshot 3,917ms/complete, Ontology 3,659ms/partial. Git subprocess timeout 없음 | 관측 전체 deadline 부재 |
| E08 | read_process 1,097회/전체 68.9%. 빈 running 조회 126회. 상위 3개 프로세스에 599회 집중 | 조회 정책의 개선 대상 |
| E09 | 13개 프로세스의 반환 출력이 생성량 초과. 양의 차이 합계 867,984바이트 | 재전송 비용. 불필요한 재전송으로 확정하지 않음 |
| E10 | yield config와 README 존재. Compose 전달·실행 환경변수 없음 | 표준 배포 설정의 누락 |
| E11 | process_session_unknown 7건. 약 4초 동안 4회 연속 발생. 같은 boot | unknown 조회의 복구 안내 부족 |
| E12 | 원본 safe errorCode/errorCategory가 report input에서 제거됨. 도구 오류 10건: unknown 7, patch check 2, replacement mismatch 1 | 기본 보고서의 원인 분류 누락 |
| E13 | 정상 종료 197, 비정상 종료 46. 비정상: nonzero exit 42, signal 4. signal 중 timeout 2. spawn 실패 0 | 명령 결과와 MCP 호출 성공의 구분 |
| E14 | malformed 0, incomplete last line 0, 관측 retention loss 0. sidecar droppedEvents 0/writeFailures 0 | 기록된 구간의 관측 품질 |
| E15 | Nginx 4,608요청, health 200 2,995건. 429/502/504 관측 0. Cloudflared 33행 중 context canceled 오류 행 32개 | 전송 경계의 보조 증거 |

도구 오류 10건, HTTP 4xx 3건, 비정상 명령 46건은 서로 다른 축이다. 이 수를 합쳐 장애 건수를 만들지 않는다. Cloudflared 오류 행 32개도 장애 32건을 뜻하지 않는다.

E02/E14의 0건은 관측한 기록에 대한 결과다. 완전히 유실된 boot나 crash buffer가 없다는 증명은 아니다. 184개 요청의 task 미연결에는 프로토콜·파일 도구 요청이 포함된다. 현재 실행 도구의 lifecycle 보장 범위를 벗어난 요청을 모두 추적 결함으로 표시하지 않는다.

### 3.3 원인 분리와 불확실성

| 확인한 사항 | 아직 확인하지 못한 사항 |
| --- | --- |
| 약 125초의 연결 종료가 반복됨 | 연결 종료 주체가 클라이언트·외부 프록시·터널 중 어디인지 |
| context 내부 처리와 전체 이력 조회 경로가 느림 | 전체 시간 중 task 탐색·sync·Git·evidence 각각의 비율 |
| 관측 예산이 전체 처리 시간을 제한하지 못함 | 느린 Git의 원인이 mount·백신·Git 설정 중 무엇인지 |
| 출력 재전송이 실제 발생함 | 의도적 재읽기·응답 유실 복구·cursor 누락 각각의 비율 |
| unknown 세션 조회 7회 | 같은 ID인지, 만료인지, 오입력인지, 다른 서버의 ID인지 |
| 명령 46건이 비정상 종료함 | 각 명령이 예상된 검사 실패인지 실제 제품 회귀인지 |

원인을 확정하지 못해도 서버 조회를 제한하고 복구 안내를 개선할 수 있다. 다만 추정 원인을 확정한 것으로 문서화하지 않는다.

## 4. 개선 항목과 구현 계약

### OPS-01. 외부 연결 안에서 반환하는 조회 대기와 전체 응답 deadline — 높음 / F1

**개선 이유**: 현재 허용하는 300초 대기가 관측된 약 125초 연결 수명을 넘는다. 또한 현재 `trackedProcessResult`는 프로세스 대기 뒤 terminal hook, 저장소 lock, 영수증 소유 관계 검사와 내구성 확인까지 기다린다. waiter 상한만 줄여서는 전체 MCP 응답 시간이 제한되지 않는다. E03/E04/E15가 근거다.

**변경 대상**: `src/config.ts`, `src/exec-tools.ts`, `src/process-manager.ts`, `src/http-server.ts`, Compose와 관련 시험.

**구현 계획**

1. 서버 설정 `MCP_PROCESS_READ_WAIT_MAX_MS`를 추가한다. 기본값은 60,000ms, 허용 범위는 1,000~300,000ms로 고정한다. wire 입력의 기존 범위 0~300,000ms는 유지한다. 실제 공개 연결 시험이 기본값 60,000ms에서 실패하면 30,000ms로 낮추고 근거를 기록한다. 운영자가 기본값보다 크게 설정할 수는 있지만 그 값까지 외부 연결 생존을 보장한다는 뜻은 아니다.
2. `read_process`의 전체 응답 deadline 시작점은 **입력 검증 직후 tool handler 진입 시각의 monotonic clock**으로 고정한다. `requestedWaitMs`는 caller 값, `effectiveWaitMs = drainOnly ? 0 : min(requestedWaitMs, MCP_PROCESS_READ_WAIT_MAX_MS)`로 계산한다. 전체 deadline은 `responseStartedAt + effectiveWaitMs + 5,000ms`다. 5,000ms는 terminal hook·lock·receipt read·durability 확인과 응답 직렬화를 위한 중앙 후처리 예산이며 프로젝트별로 바꾸지 않는다. `waitMs=0`과 `drainOnly=true`도 전체 예산 5,000ms를 가진다.
3. 저장된 receipt의 `persistenceState`는 기존 `ok | degraded`를 그대로 유지한다. storage schema에 `pending`이나 `unverified`를 추가하지 않는다. 대신 이번 응답에만 `persistenceVerification: "not_required" | "verified" | "pending"`을 추가한다. `not_required`는 프로세스가 아직 실행 중이라 terminal durability 판정 대상이 아님, `verified`는 terminal receipt와 durability 확인이 deadline 안에 끝남, `pending`은 프로세스 종료는 관측했지만 기존 terminal 저장/확인이 deadline까지 끝나지 않음을 뜻한다. 검증 시도 자체가 손상·owner 오류 등으로 실패하면 기존 오류 계약을 사용하고 정상 응답의 새 enum으로 감추지 않는다.
4. 응답의 `running/completed`는 ProcessManager가 관측한 프로세스 상태다. `executionState`와 `persistenceState`는 마지막으로 성공적으로 읽은 receipt 관측값이며, terminal durability의 증거가 되려면 `persistenceVerification=verified`여야 한다. `pending`에서 receipt 자체를 `degraded`, `unknown` 또는 다른 상태로 변경하지 않고 `safeTerminal` 또는 동등한 durable 성공을 반환하지 않는다.
5. 전체 응답 deadline에 도달했는데 terminal 저장 확인이 끝나지 않았으면 저장 작업 자체를 취소하지 않는다. ProcessManager가 소유한 terminal hook과 receipt 저장은 계속 완료되어야 한다. 응답은 `persistenceVerification=pending`과 기존 ID를 사용하는 다음 복구 호출을 반환한다.
6. deadline 경쟁 구현은 저장 Promise를 버리거나 새 저장 작업을 중복 생성하지 않는다. terminal hook은 기존 1회 실행 계약을 유지한다. 저장 확인이 늦어진 응답을 재조회해도 새 spawn이나 새 terminal write가 발생하지 않아야 한다.
7. request abort는 **조회 waiter와 응답 대기**만 종료한다. HTTP 연결 종료가 process kill, terminal hook 취소, receipt 상태 unknown 전환을 일으켜서는 안 된다.
8. timer·listener·abort handler는 성공·timeout·abort 경로 모두에서 해제한다. HTTP abort, process terminal, persistence 완료가 동시에 경합해도 terminal 저장은 1회다.
9. 명령 timeout, 초기 실행 yield, 종료 신호의 의미는 바꾸지 않는다. 조회 예산이 끝나면 현재 프로세스 상태·cursor·receipt 관측값·`persistenceVerification`·다음 호출을 반환한다.

**수용 기준**: AC01, AC02. 서버 공개 catalog와 실제 클라이언트에서 각각 확인한다. 프록시 timeout 상향으로 우회하지 않는다.

### OPS-02. 작업 범위 복구 조회와 검증 후 메모리 인덱스 — 높음 / F2

**개선 이유**: 한 task의 복구에 다른 task의 영수증 전체를 읽고 sync한다. 누적 실행이 증가하면 복구 비용도 커진다. E05/E06이 근거다. 현재 `readExecution`도 단일 영수증을 읽은 뒤 같은 workspace의 전체 실행을 다시 읽어 소유 관계를 검증하므로, 단순한 task 필터만으로는 병목이 사라지지 않는다.

**변경 대상**: `src/continuity/task-store.ts`, `task-service.ts`, `execution-recorder.ts`, 저장·복구·journal 지원 코드와 시험.

**무결성 경계 결정 — D-OPS02-01**

성능 구현 전에 아래 경계를 명시적으로 채택한다. 이것은 기존 hot read가 우연히 제공하던 전역 검사 시점을 조정하는 설계 변경이며, 인덱스 구현 안에 숨기지 않는다.

- **정상 hot path**: 선택한 workspace/task/operation의 schema·owner binding과 현재 프로세스가 관리하는 메모리 인덱스의 일관성을 검사한다. 무관한 모든 execution 파일을 매 조회마다 다시 읽어 검사하지 않는다.
- **시작·재시작**: single-writer guard를 획득한 뒤 원본 `state.json`과 execution 전체를 검사한다. 소유자 불일치·잘못된 파일명·schema 손상·이전 boot 미정산 실행을 처리한 뒤에만 메모리 인덱스를 유효 상태로 만든다.
- **복구·의심 상태**: journal/atomic write 복구 실패, 캐시 불일치, 예상하지 못한 원본 상태, 명시적 integrity check 요청이 있으면 전체 원본 검증으로 돌아간다. 명시적 integrity check는 저장소 내부/운영 검증 경로를 뜻하며, 이 작업만을 위해 새 공개 MCP 도구를 추가하지 않는다. 검증이 끝나기 전 빈 성공 응답을 만들지 않는다.
- **정상 writer 밖의 외부 변경**: 실행 중 수동 파일 편집을 모든 hot read 시점에 즉시 검출한다고 약속하지 않는다. 시작·복구·명시적 무결성 검사에서는 검출해야 한다. 이 경계가 허용되지 않는다면 OPS-02 성능 최적화는 보류하고 기존 전체 검사를 유지한다.
- 파일 watch, directory mtime, generation 값만으로 외부 변경이 없었다고 증명하지 않는다.

**원본 변경 경로와 캐시 계약**

구현 전에 아래 경로를 실제 코드와 대조해 표를 확정한다. 표에 없는 원본 변경 경로가 발견되면 인덱스 구현을 시작하지 않는다.

| 원본 변경 | 현재 대표 경로 | 메모리 인덱스 처리 |
| --- | --- | --- |
| task/workspace 상태 변경 | checkpoint/create/update/complete의 `writeWorkspace` 및 journal/atomic commit | 원본 commit 성공 뒤 해당 workspace/task entry 갱신. 실패 시 캐시 무효화 |
| execution `prepared` | `ExecutionRecorder.prepare` → `writeExecution` | 원본 write 성공 뒤 operation/task entry 추가 |
| execution `running` | `markRunning` → `writeExecution` | 같은 operation entry 갱신 |
| execution `exited`/`spawn_failed` | terminal hook/`markTerminal`/`markSpawnFailed` → `writeExecution` | 같은 operation entry 갱신. unresolved/recent 분류도 함께 갱신 |
| persistence degraded·caller reconciliation | `markPersistenceDegraded`, `reconcile`, `withReconciliations` | 원본 write 성공 뒤 상태 갱신 |
| 이전 boot 복구 | `#recoverPreviousBootExecutions`의 직접 atomic write | 부팅 전체 검증·복구 과정 안에서 반영. 인덱스 생성은 복구 완료 뒤 수행 |
| journal/atomic write 복구 | 저장소 초기화·복구 경로 | 복구 완료 전 인덱스 사용 금지. 완료 뒤 원본에서 재구축 |

**인덱스 키 범위 — D-OPS02-02**

- 논리적 execution identity는 `(workspaceId, operationId)`다. `operationId` 단독 전역 키는 금지한다.
- task/operation/recent/unsettled 분류와 cache invalidation은 모두 workspace-scoped다.
- owner 검증은 요청한 `workspaceId`와 읽은 receipt의 `workspaceId`를 함께 확인한다.
- 같은 `operationId`를 가진 두 workspace를 동시에 보유한 fixture에서 조회·상태 갱신·무효화가 교차하지 않아야 한다.

**구현 계획**

1. 먼저 task 탐색, 원본 영수증 읽기, ownership validation, sync/durability, Git 관측, evidence 확인의 소요 시간·파일 읽기 수·sync 수를 분리한다. 9.37초 전체를 fsync나 task 탐색 하나의 원인으로 단정하지 않는다.
2. 1차 최적화는 **부팅 검증 후 생성하는 프로세스 메모리 인덱스**로 제한한다. 논리적 실행 키는 기존 계약대로 `(workspaceId, operationId)`다. 구현은 `Map<workspaceId, WorkspaceExecutionIndex>` 아래에 `operations: Map<operationId, ReceiptLocator>`와 task별 분류를 두는 workspace-scoped 구조를 기본으로 한다. 전역 `Map<operationId, ...>`는 사용하지 않는다. 같은 `operationId`가 다른 workspace에 존재해도 서로 독립된 실행이다. 원본 task·receipt·journal이 항상 권위 자료다.
3. 메모리 인덱스는 권위 저장 성공 뒤 같은 storage lock 경계에서 갱신하거나, 갱신을 보장할 수 없으면 즉시 **해당 workspace의 캐시만** 무효화한다. operation 조회·상태 갱신·무효화는 항상 workspace 경계를 먼저 선택한 뒤 operation key를 사용한다. 한 workspace의 같은 operation ID 변경이 다른 workspace의 entry를 갱신하거나 무효화해서는 안 된다. 캐시 갱신 실패를 원본 저장 실패로 바꾸지 않고, 캐시 값을 새 실행 허가나 durability 증거로 사용하지 않는다.
4. **영속 인덱스와 generation은 1차 구현에서 만들지 않는다.** 재시작 시 전체 검증·재구축 비용이 실제 운영 문제라는 별도 측정 결과가 나온 경우에만 후속 설계 결정으로 검토한다. 조회 최적화를 이유로 모든 execution write를 새 journal 엔진으로 이동하지 않는다.
5. 정상 hot path에서는 선택한 task와 필요한 receipt만 읽는다. running/unsettled는 전부 보존하고, terminal recent N 제한은 전체 파일 로드보다 앞에서 적용한다. completion blocker 판단은 recent N에 의존하지 않는다.
6. checkpoint의 과거 receipt evidence는 recent N과 별도로 `operationId`로 정확히 조회하고 owner binding을 검증한다. `verifyEvidence`에 recent 목록만 넘겨 정상 과거 증거를 `missing`으로 만들지 않는다.
7. 미정산 목록이 응답 예산을 넘으면 total/omittedCounts/cursor를 반환한다. cursor 정렬 기준은 안정적인 `(preparedAt, operationId)` 또는 그와 동등한 총순서를 사용한다. 페이지 사이 동시 변경은 중복 또는 누락 여부가 명시적으로 검증되어야 하며, 범용 검색 프레임워크는 만들지 않는다.
8. 원본 write·rename·sync 실패의 기존 내구성 의미를 유지한다. 저장 실패 뒤 retry가 성공으로 보이려면 원본 durability 확인을 다시 수행해야 한다. 메모리 인덱스 hit만으로 persistence `ok`를 만들지 않는다.
9. 시작·복구·명시적 integrity scan에서 기존 소유자 불일치·schema 손상·파일명 불일치 fixture를 전체 검사한다. 정상 hot path에서는 선택된 record의 owner 검사를 유지하고, 무관 record 손상 검출 시점은 D-OPS02-01의 경계를 따른다.
10. 메모리 인덱스로도 AC03 목표에 도달하지 못하면 계측으로 남은 병목을 먼저 확인한다. 영속 인덱스·generation·새 저장 엔진은 자동 후속 단계가 아니다.

**설계 제한**: 부팅 또는 명시적 integrity scan의 O(N)은 허용한다. 정상 task 조회의 반복 O(N)은 제거한다. single-writer guard는 정상 writer 경계를 보장하지만 외부 파일 변조 부재를 증명하지는 않는다. 캐시·인덱스는 언제나 폐기 후 원본에서 재구축할 수 있어야 한다.

**수용 기준**: AC03, AC04, AC05. 10,000개 기록의 조회 성능과 전체 무결성 검사의 시점을 별도로 검증한다.

### OPS-03. 작업공간 관측 전체에 시간 예산 적용 — 높음 / F3

**개선 이유**: 2초 제한이 파일 loop 일부에만 적용되고 Git 호출에는 제한이 없다. 변경 파일이 없어도 3.9초가 걸린다. 관측이 멈추면 복구 응답도 늦어진다. E07이 근거다.

**변경 대상**: `src/continuity/workspace-snapshot.ts`, 필요 시 `workspace-identity.ts`, context 시험.

**구현 계획**

1. observeWorkspace 진입에서 전체 deadline을 계산한다. 전후 Git 조회·staged object 조회·파일 fingerprint에 남은 예산을 전달한다.
2. Git 자식 프로세스에는 남은 시간에 맞는 timeout과 취소를 적용한다. 실제 자식 종료를 확인한다. Promise.race만으로 백그라운드 작업을 남기지 않는다.
3. 파일 읽기는 abort 가능한 경로 또는 제한된 chunk 읽기를 사용한다. 취소할 수 없는 OS I/O의 정리 지연은 별도 측정한다.
4. 예산 초과는 partial/unknown과 time_budget_exceeded로 표현한다. 검증하지 못한 fingerprint를 complete 또는 drift 없음의 근거로 사용하지 않는다.
5. deadline 종료 시각과 cleanup 소요를 구분한다. 결과 반환 지연을 숨기지 않는다. observation completeness와 elapsed time도 구분한다.
6. identity resolution이 관측 밖에서 시간을 쓰는 경우 별도 계측한다. 이 비용을 observeWorkspace 2초 준수에 섞어 성공을 주장하지 않는다.

**수용 기준**: AC06. 변경 없는 저장소·느린 Git·큰 파일·동시 변경에서 모두 검증한다.

### OPS-04. 장기 명령 조회와 출력 cursor 정책 개선 — 중간 / F4

**개선 이유**: 전체 호출의 68.9%가 조회다. 빈 조회는 조회의 11.5%이므로 빈 응답만 줄여서는 충분하지 않다. 자주 출력하는 장기 실행과 재읽기도 다뤄야 한다. E08/E09가 근거다.

**변경 대상**: `src/exec-tools.ts`, `process-manager.ts`, telemetry·report, `scripts/execution-benchmark.mjs`, README.

**구현 계획**

1. 기존 output/terminal 의미와 cursor 단위를 보존한다. 기본 output을 전역으로 terminal로 바꾸지 않는다. MCP가 명령 본문이나 프로젝트 이름으로 build/test 의도를 추론하지 않는다.
2. 종료만 필요한 명령은 caller가 terminal을 선택하도록 문서와 다음 호출 안내를 정리한다. 계속 출력이 필요한 호출은 output을 유지한다. Moonshot 등 특정 Harness의 관측 비율을 전체 기본값 변경 근거로 사용하지 않는다.
3. **지속 polling 정책**과 **이번 drain에만 적용하는 즉시 조회**를 분리한다. 최소 stateless 계약으로 `drainOnly`와 동등한 선택적 입력을 사용한다. `drainOnly=true`이면 이번 호출의 effective wait만 0으로 하고, 요청한 waitMode/waitMs는 다음 continuation 정책으로 보존한다.
4. `hasMore=true`이면 nextCall은 같은 afterSeq 규칙과 `drainOnly=true`로 남은 출력을 읽는다. `hasMore=false && running=true`로 전환되면 nextCall은 `drainOnly=false`로 복원하고 원래 waitMode/waitMs를 다시 사용한다. 서버 전역 또는 프로세스별 polling 상태를 저장하지 않는다.
5. caller가 nextCall을 **그대로** 따르는 시험을 추가한다. `terminal 30초 → drain 0초 → drain 완료 → terminal 30초`가 유지되어야 하며, drain 이후 0초 polling이 반복되면 실패다.
6. cursor 누락의 기존 의미인 처음부터 읽기는 유지한다. 의도적 재읽기를 금지하지 않는다. 중복 전송 비용과 보존 손실은 별도로 집계한다.
7. waitMode, requested/effective wait, drain 여부, 요청/반환 cursor, hasMore와 출력 바이트 수만 제한된 metadata로 남긴다. 숫자의 유효 범위와 enum을 검증한다. 출력 본문·명령·경로는 남기지 않는다.
8. OPS-01의 wait cap과 전체 응답 deadline은 drain에도 동일하게 적용한다. drain은 현재 호출의 waiter만 0으로 만들 뿐 persistence 확인이나 응답 안전 계약을 우회하지 않는다.

**수용 기준**: AC07, AC08. 구현 자체의 효과와 caller 정책 선택의 효과를 분리해 측정한다.

### OPS-05. 배포 설정과 실효값 일치 — 중간 / F5

**개선 이유**: `MCP_DEFAULT_PROCESS_YIELD_MS`는 구현·문서에 있지만 표준 Compose에서 전달되지 않는다. `.env`만 변경하는 운영 절차로는 설정이 적용되지 않는다. E10이 근거다.

**변경 대상**: `docker-compose.yml`, `.env.example`, `src/config.ts`, 제한된 진단 응답, README·환경/배포 검증 script.

**구현 계획**

1. Compose에 `MCP_DEFAULT_PROCESS_YIELD_MS`를 기본값 750과 함께 전달한다. 새 조회 대기 상한도 같은 경로로 전달한다.
2. 실행별 yield override와 기존 유효 범위 0~30,000ms를 유지한다. 초기 yield와 read wait 상한을 하나의 timeout으로 합치지 않는다.
3. 진단에는 yield와 read wait 상한의 실효값만 반환한다. 환경변수 전체나 비밀값을 노출하지 않는다.
4. `.env.example`·README·config·Compose의 기본값과 범위를 일치시킨다. 구형 설정이 없을 때 기존 기본값이 유지되는지 검증한다.
5. 이번과 무관한 OAuth 예시·비밀 검사·커밋 검사기를 수정하지 않는다. 검사 오탐이 발생하면 원인을 별도 기록한다.

**수용 기준**: AC09. `.env`→Compose→컨테이너 환경→loadConfig→실제 동작을 격리 배포에서 연결한다.

### OPS-06. unknown 세션의 영수증 복구 안내 — 중간 / F6

**개선 이유**: unknown 오류 뒤 짧은 시간에 조회가 반복됐다. 결과가 불명확하면 잘못된 재실행으로 이어질 수 있다. E11이 근거다. 보존 1시간만으로 7건 모두를 만료로 확정할 수 없다.

**변경 대상**: `src/exec-tools.ts`, `process-manager.ts`, `execution-recorder.ts`, task 조회·오류 schema와 시험.

**구현 계획**

1. `process_session_unknown` 코드와 오류 호환성을 유지한다. 일반 설명에 조회 반복을 멈추고 기존 task/operation을 확인할 절차를 추가한다.
2. read_process에 선택적인 taskId+operationId 쌍을 받는 경로를 추가한다. 값의 UUID 형식만으로 소유 관계를 인정하지 않는다. 원본 receipt의 workspace/task/operation/session/boot 관계를 검증한다.
3. 메모리 세션이 없고 receipt가 종료를 증명하면 결과와 persistence 상태를 반환한다. 출력은 별도 expired/unavailable로 표시한다. 빈 출력이 성공적인 전체 drain이었다고 표시하지 않는다.
4. receipt가 prepared/running/unknown인데 현재 프로세스를 확인할 수 없으면 불확실 상태와 context 조회를 안내한다. 종료 성공을 만들어 내지 않는다.
5. receipt가 없거나 식별자가 충돌하면 기존 unknown/충돌 오류를 반환한다. 다른 task의 결과를 노출하지 않는다. 검증한 owner binding만 telemetry correlation에 넣는다.
6. caller가 ID 쌍을 제공하지 않았으면 서버가 추측해서 연결하지 않는다. 오류 안내는 일반 복구 절차에 그친다. 어떤 경로도 새 spawn을 수행하지 않는다.

**수용 기준**: AC10, AC11. 출력 만료와 실행 결과 불명은 서로 다른 상태로 검증한다.

### OPS-07. 오류 분류와 대기 관측을 보존하는 보고서 — 중간 / F7

**개선 이유**: 서버가 기록한 안전한 오류 코드가 report input에서 제거된다. 분석마다 원본을 따로 읽어야 하고, 125초 종료와 cursor 비용도 기본 보고서에서 설명할 수 없다. E12가 근거다.

**변경 대상**: `src/telemetry*.ts`, `scripts/usage-report-input.mjs`, `usage-report.mjs`, `usage-report-integrity.mjs`, 보고서 시험.

**구현 계획**

1. 기존 오류 allowlist를 report input에서도 적용한다. unknown 값은 제한된 other로 분류한다. 원문 오류 메시지는 복사하지 않는다.
2. 도구·build별 오류 분포와 검증된 task 범위의 분포를 출력한다. toolError가 true인데 코드가 없으면 unknown_code로 별도 센다. 구형 로그를 성공으로 보정하지 않는다.
3. HTTP 4xx/5xx, toolError, aborted, process exit, signal, timeout을 별도 축으로 유지한다. 비율의 분모를 함께 출력한다.
4. OPS-01/04의 요청 대기·실효 대기·전체 응답 elapsed/deadline 결과·`persistenceVerification`·drain 여부·cursor metadata를 제한된 수치/enum으로 schema에 추가하고 보고서가 읽게 한다. `persistenceVerification`은 응답 관측값이며 receipt `persistenceState`와 별도 축으로 집계한다. legacy는 미관측으로 표시한다.
5. OPS-02의 단계별 시간·읽은 receipt 수·index 상태를 제한된 수치/enum으로 추가한다. 사용자 정의 label이나 경로를 metric dimension으로 받지 않는다.
6. 보고서는 읽기 전용을 유지한다. 저장소 복구·journal replay·receipt 수정·작업 재실행을 하지 않는다. 조사 중 파일 변경은 inconclusive로 유지한다.

**수용 기준**: AC12, AC13. 원본 errorCode가 있는 fixture에서 집계 합계가 맞아야 한다. 임의 비밀 문자열은 출력에 없어야 한다.

## 5. 변경 중에도 유지할 공통 계약

| 경계 | 필수 조건 |
| --- | --- |
| 실행 중복 방지 | 같은 workspace/operation+동일 입력은 기존 실행 반환. 다른 입력은 충돌 |
| 실행 식별자 범위 | 논리적 실행 키는 `(workspaceId, operationId)`. operationId 단독 전역 key 금지. 같은 operationId의 다른 workspace는 독립 실행 |
| 저장 권위 | 원본 receipt·task·journal이 권위. index·로그·진단은 파생 관측 |
| 무결성 검사 시점 | 선택 record의 owner 검사는 hot path에서 유지. workspace 전체 검사는 시작·복구·명시적 integrity scan에서 보장. 외부 변조의 매 조회 즉시 검출은 보장하지 않음 |
| 불확실한 결과 | unknown은 재실행 허가가 아님. 기존 ID와 현재 상태부터 확인 |
| 연결과 프로세스 | HTTP abort·조회 timeout이 프로세스 종료를 뜻하지 않음 |
| 완료 권한 | exit 0·MCP completed는 Harness의 프로젝트 완료를 대체하지 않음 |
| 출력 | cursor와 UTF-8 경계 유지. 응답 재전송과 보존 손실을 구분 |
| 관측 | deadline·부분 관측·수집 공백을 명시. 누락을 정상으로 채우지 않음 |
| 호환성 | 기존 호출·schema-v2 원본을 읽을 수 있어야 함. 신규 index는 재구축 가능 |
| 보안 | OAuth·tracking required·owner 검사를 유지. 비밀·명령·출력 본문을 로그에 추가하지 않음 |
| 배포 | active-process guard 유지. 실행 중 force restart로 검증을 통과시키지 않음 |

## 6. 구현 순서와 산출물

모든 항목의 시작 상태는 planned다. 아래 상태 열은 실행 때만 갱신한다. 이전 문서의 완료 표시를 이번 작업의 완료 근거로 재사용하지 않는다.

| Wave | 작업과 의존성 | 필수 산출물 | 통과 조건 | 상태 |
| --- | --- | --- | --- | --- |
| W0 | 최소 계측과 baseline 고정. E01~E15, 오류 분류, task 탐색/receipt read/owner validation/sync/persistence/Git/evidence 단계 시간·읽기 수 측정 | 기준 수치·fixture·비교 명령·단계별 비용표·기능/설정 호환표 | AC12~14 baseline 고정 | planned |
| W1 | 독립 수정: OPS-01, OPS-03, OPS-05. 조회 waiter와 전체 응답 deadline 분리, 관측 deadline, Compose 전달 | wait cap·response deadline·abort 경합 시험·workspace deadline·실효값 진단 | AC01/02/06/09 | planned |
| W2 | **저장 경계 확정만 수행**. D-OPS02-01, 모든 원본 변경 경로·single writer·시작/복구/integrity 검사·evidence targeted lookup 계약을 코드와 fixture로 고정 | mutation matrix·무결성 경계 결정·실패/복구 fixture | AC04/05의 계약 시험. 이 단계에서 영속 인덱스 구현 금지 | planned |
| W3 | OPS-02 최소 조회 최적화. W2 통과 후 부팅 검증 기반 메모리 인덱스와 task-scoped 조회 구현 | 메모리 인덱스·cache invalidation·recent/unsettled/evidence 분리·성능 비교 | AC03~05. 목표 미달 시 병목 재계측, 영속 인덱스 자동 추가 금지 | planned |
| W4 | OPS-04/06과 OPS-07 최종 집계. continuation 정책 복원, cursor, unknown receipt 복구 | nextCall verbatim 시험·unknown 공통 검증·완성 보고서 | AC07/08/10~13 | planned |
| W5 | 변경 전체의 **분리된 격리 후보 검증**. 코드 성능, caller 정책 효과, 공개 테스트 연결, Harness 호환과 rollback 호환성을 각각 판정 | AC 결과표·baseline/candidate·policy A/B·격리 runtime/catalog 결과·회귀 결과·배포 후보 digest·rollback 호환 증거 | AC01~15 + **AC16-CANDIDATE** + **AC18**. 특정 Harness 실패를 핵심 MCP 결과와 혼합하지 않음 | planned |
| W6 | 허가된 운영 배포와 효과 관측. W5와 배포 전 AC18 rollback 호환 시험 통과 필요 | 운영 source/image/runtime/catalog 일치·실제 client 확인·24시간 운영 비교·조건부 실제 rollback 기록 | **AC16-DEPLOYED + AC17**. AC18은 배포 전 필수 호환 시험이며 실제 rollback 실행은 rollback 조건 발생 시에만 수행 | planned |
새 계측만을 위해 별도의 운영 배포를 강제하지 않는다. W1~W4는 격리 환경에서 수행한다. 실제 공개 경로 시험이 필요하면 별도 테스트 경로 또는 허가된 canary에서 수행한다.

변경 파일은 항목별 대상으로 제한한다. 제품 수정과 소비 Harness 수정이 동시에 필요하면 원인과 범위를 먼저 분리한다. 이 문서만으로 다른 저장소의 구현을 자동 확대하지 않는다.

## 7. 검증 및 수용 기준

### 7.1 재현 가능한 시험 조건

- fixture의 명령·출력·실행 시간·영수증 수·동시성·yield·waitMode·waitMs·출력 상한을 고정한다.
- 같은 기계와 격리 이미지에서 baseline/candidate를 각각 측정한다. build digest와 자원 조건을 남긴다.
- 성능 비교는 최소 20회, 첫 실행과 정상 hot path를 나눠 기록한다. 단위 가짜 timer 시험은 실제 공개 연결 시험을 대체하지 않는다.
- 저장 성능 시험은 hot path와 시작/복구/integrity scan을 분리한다. hot path가 빨라졌다는 이유로 전체 무결성 검사를 생략하지 않는다.
- caller 정책 효과를 비교할 때는 candidate 내부 비교를 사용한다. 구현 효과 비교는 baseline/candidate에서 waitMode·waitMs·출력 상한을 동일하게 고정한다.
- 운영 비교는 workload 구성과 실행 수를 함께 기록한다. 조용한 기간의 낮은 오류 수를 개선 효과로 단정하지 않는다.

| ID | 검증 대상 | 통과 기준과 남길 증거 |
| --- | --- | --- |
| AC01 | HTTP 대기·전체 응답 상한 | `responseStartedAt`을 handler 진입 monotonic 시각으로 기록하고 `effectiveWaitMs = drainOnly ? 0 : min(requestedWaitMs, configured cap)`, `deadline = responseStartedAt + effectiveWaitMs + 5,000ms`를 검증. 기본 cap 60초에서 요청 300초의 effective wait는 60초 이하. `waitMs=0`·drain도 5초 전체 budget을 사용. terminal hook/lock/receipt 저장 지연 fixture에서 deadline 시 `persistenceVerification=pending`, durable 성공 금지, receipt `persistenceState` 변조 0, 지연 저장은 이후 완료, spawn/terminal write 각 1회 |
| AC02 | 응답 유실·취소·저장 경합 | 조회 중 HTTP 연결 강제 종료, terminal 저장 중 연결 종료, abort/terminal/persistence 동시 경합을 시험. 프로세스와 terminal 저장은 계속 진행, 기존 ID로 재조회 가능, 최종 receipt 일치. waiter timer/listener가 기준 수준으로 복귀하고 저장 Promise 유실·추가 spawn·중복 terminal write 0 |
| AC03 | 정상 조회 확장성 | 시작 시 전체 검증을 끝내고 메모리 인덱스를 만든 뒤, 대상 task 10개 receipt 고정·다른 task 100/1,000/10,000개에서 warm summary를 측정. hot path 영수증 read/sync 수가 전체 N에 비례하지 않고 p95(10,000) ≤ 2×p95(100)+100ms. 같은 wait/관측 조건으로 비교하며 startup full scan 비용은 별도 보고 |
| AC04 | 메모리 인덱스 재구축·무결성 경계 | 재시작, 이전 boot 미정산, journal/atomic write 복구, cache 강제 무효화에서 원본 전체 검증 후 인덱스 재구축. 실행 중 외부에서 무관 receipt를 변조한 fixture는 hot read 즉시 검출을 요구하지 않되 명시적 integrity scan과 다음 재시작에서 반드시 거절. 선택 operation 자체의 owner/schema 손상은 hot path에서 거절. 영속 index/generation 파일은 생성하지 않음 |
| AC05 | 저장 내구성과 조회 정확성 | prepared/running/exited/spawn_failed/degraded/reconcile/previous-boot 복구 등 mutation matrix의 모든 경로에서 원본 write 성공 뒤 해당 workspace 캐시가 일치하거나 무효화됨. rename/sync 실패·손상 schema·owner 불일치·미정산 receipt에서 기존 원본 거절/복구 의미 유지. recent N 밖의 정상 receipt evidence를 targeted lookup으로 present 판정. **동일 operationId를 가진 두 workspace fixture에서 조회·상태 갱신·캐시 무효화 교차 영향 0**. 동일 workspace/operation replay 추가 spawn 0. unresolved total과 cursor 페이지 합계 일치 |
| AC06 | 관측 deadline | 2초 예산의 느린 Git/변경 없음/큰 파일 fixture에서 예산+500ms 이내 취소·반환을 목표로 통과. 지연 주입 fixture는 반드시 제한 준수. 실제 OS I/O가 상한을 넘으면 원인·cleanup 시간 기록 후 미충족으로 남김. partial을 complete/drift 없음으로 표시하지 않음 |
| AC07 | 구현 효과와 사용 정책 효과 | **A 구현 효과:** baseline/candidate를 동일 waitMode·waitMs·maxOutputBytes로 비교해 nextCall을 그대로 따르는 caller의 호출 수·0초 반복·출력 bytes를 측정. candidate가 `hasMore true→false` 뒤 running이면 원래 polling 정책을 복원. **B 정책 효과:** 같은 candidate에서 output 1초와 terminal 30초를 비교해 terminal 정책의 호출 감소, 첫 출력 지연, 종료 인지 지연을 별도 보고. A/B를 합쳐 신규 구현 효과로 주장하지 않음 |
| AC08 | 출력 정확성 | UTF-8 경계·큰 출력·다중 drain·`hasMore=true→false` 후 계속 실행·의도적 재읽기·응답 유실 fixture. append 순서와 반환 cursor 일치. nextCall verbatim 실행에서 drain 후 0초 polling 고착 0. 재읽기 없는 fixture 중복 출력 0. 손실 발생 시 dropped 수치와 명시 상태 일치 |
| AC09 | 설정 전달 | 격리 `.env`에서 yield=3,000/read cap=30,000 설정. Compose 환경·실효 진단·동작 일치. read cap 허용 범위 1,000~300,000, 미설정 기본 60,000, wire `waitMs=0` 즉시 조회 유지. 미설정 yield=750 유지, 실행별 override 유지, 경계 밖 설정값 거절 |
| AC10 | 출력 만료 복구 | 메모리 만료 뒤 검증된 task/operation으로 terminal 결과와 출력 unavailable 반환. receipt 불변, 새 spawn 0. 종료 결과와 출력 가용성 분리 |
| AC11 | 잘못된 복구 식별자 | UUID 오입력·owner 불일치·다른 boot·영수증 없음·unknown 상태에서 타 작업 정보 노출 없음. 검증 전 correlation 승격 없음. unknown 자동 재실행 0 |
| AC12 | 보고서 집계 | 오류 코드가 있는 10건 fixture의 분포 합계=10. toolError와 HTTP/process 오류 축 분리. 구형 필드 누락은 미관측. since/until·task/build 필터의 합계 일치 |
| AC13 | 관측 안전성 | 명령·환경·token·오류 원문·경로·임의 enum을 주입해도 보고서/console/disk에 비밀 문자열 없음. read-only 보고서 전후 원본 digest 동일. pending/동시 변경은 inconclusive |
| AC14 | 비교 기준 | fixture·baseline/candidate digest·설정·반복 수·p50/p95·file read/sync 수·생성/반환/손실 바이트·aborted·spawn 수를 같은 형식으로 저장 |
| AC15 | 호환성과 회귀 | 기존 schema-v2, 기존 waitMs 입력, output/terminal, safe-terminal 안내, execution identity, complete_work, OAuth, approval bridge 시험 통과. 실제 설치 Harness 시험은 실제 done 응답이 있을 때만 통과 |
| AC16 | 후보/운영 배포 일치 | **AC16-CANDIDATE:** 격리 후보에서 source/image build ID, catalog 기능, tracking required, 설정 실효값과 테스트 client 신규 필드/옵션 호출 일치. **AC16-DEPLOYED:** 허가된 운영 배포 뒤 source/image/runtime build ID, 실제 catalog, tracking required, 설정 실효값과 실제 client 호출을 다시 확인. 후보 통과를 운영 통과로 재사용하지 않음 |
| AC17 | 운영 효과 | 배포 후 최소 24시간. 125초 유형 조회 종료, context 단계별 지연, read/실행, 재전송, unknown 복구를 보고. 관련 장기 조회가 20회 미만이면 효과 미검증으로 유지하고 기간 연장 |
| AC18 | rollback 호환성 | **배포 전 필수 시험.** 격리 상태 사본에서 이전 이미지가 원본 v2를 읽고 실행·복구 가능. 메모리 index는 폐기/재구축 가능하고 원본·미정산 실행을 삭제하지 않음. 이 AC는 rollback 가능성 검증이며 실제 운영 rollback 실행 성공을 요구하지 않는다. 실제 rollback은 8.3 조건 발생 시 별도 운영 결과로 기록 |

AC03/06의 수치는 새 목표다. 기존 관측에서 이미 충족한 사실이 아니다. 성능 목표를 변경하면 같은 후보를 완료 처리하기 전에 근거와 변경 이유를 이 문서에 기록한다.

실제 Harness가 미설치면 compatibility는 skipped, 설치됐으나 provider·approval·신원 요구가 충족되지 않으면 blocked로 기록한다. skipped/blocked를 pass로 바꾸지 않는다. 핵심 MCP 회귀는 특정 Harness 설치에 의존하지 않는다.

### 7.2 기존 시험에 연결할 위치

| 항목 | 우선 확장할 시험·도구 |
| --- | --- |
| OPS-01 | `test/execution-controls.test.ts`, `process-manager.test.ts`, `recovery.integration.test.ts` |
| OPS-02 | `test/continuity-storage.test.ts`, `continuity.test.ts`, `performance.test.ts` |
| OPS-03 | `test/continuity.test.ts`, 필요 시 관측 전용 fixture |
| OPS-04 | `test/execution-controls.test.ts`, `execution-observability.test.ts`, `scripts/execution-benchmark.mjs` |
| OPS-05 | `test/config.test.ts`, `execution-controls.test.ts`, `scripts/verify-docker.mjs`, `verify-live.mjs` |
| OPS-06 | `test/recovery.integration.test.ts`, `continuity-smoke.test.ts`, `execution-controls.test.ts` |
| OPS-07 | `test/usage-report.test.ts`, `usage-correlation.test.ts`, `execution-correlation.test.ts`, `diagnostic-codes.test.ts` |

각 Wave는 관련 focused suite를 실행한다. 최종 후보에서는 `npm run typecheck`, `npm test`, `npm run build`, `npm audit --omit=dev`, `node scripts/check-public-config.mjs`, `npm run integration:docker`를 수행한다. Windows의 core 시험은 기존 격리 Linux 실행 경로를 사용한다. 동일 후보가 통과한 검사를 근거 없이 반복하지 않는다.

보안 검사 결과는 현재 실행 결과로 기록한다. 기존 취약점·새 취약점·이번 변경과의 관계를 분리한다. 빌드 통과를 보안 검사 통과로 표시하지 않는다.

## 8. 배포, 관측과 rollback

### 8.1 배포 전

1. 최종 diff·검증 결과·AC 미충족 항목을 정리한다. 신규 schema/catalog 변경을 명시한다.
2. 이미지·source digest·실효 설정을 고정한다. 이전 이미지와 설정을 보존한다.
3. 상태 백업은 활성 writer와 일관된 경계에서 만든다. 디렉터리 복사만으로 일관된 transaction 백업이라고 주장하지 않는다. **W6 운영 배포 전에 격리 rollback 호환 시험 AC18을 필수 수행한다.** 이는 실제 rollback 실행과 별개다.
4. active-process guard로 기존 작업이 없는지 확인한다. 활성 작업이 있으면 종료를 기다린다. 소비 프로젝트 실행을 강제로 끝내지 않는다.

### 8.2 배포 및 클라이언트 확인

1. W5의 AC16-CANDIDATE와 AC18 통과를 확인한 뒤 허가된 배포 절차로 이미지를 적용한다. `npm run post-deploy:verify`와 **AC16-DEPLOYED**를 새 운영 증거로 수행한다.
2. authenticated 공개 MCP 호출과 실제 클라이언트 호출을 구분해 기록한다. 서버 tools/list 통과를 connector catalog 갱신 증거로 대체하지 않는다.
3. 장기 무출력·응답 유실·동일 operation 재조회 canary를 안전한 임시 workspace에서 수행한다. production 소비 task는 사용하지 않는다.
4. 24시간 수집 구간과 build 필터를 고정한다. 관련 표본 부족은 미검증으로 남긴다.

### 8.3 중단과 rollback 조건

다음 중 하나가 발생하면 배포 확대를 중단한다.

- 같은 workspace/operation의 추가 spawn, owner 교차 노출, receipt/journal 모순.
- 조회 연결 종료가 프로세스를 종료하거나 terminal 영수증을 유실함.
- index 복구가 원본을 덮어쓰거나 미정산 실행을 정상으로 누락함.
- 비밀·명령·출력 본문이 새 telemetry에 기록됨.
- 동일 fixture에서 context p95가 baseline보다 20% 이상 악화하고, 새 원인 설명이나 승인된 목표 변경이 없음.
- 설정 실효값·source/image/runtime/catalog가 다름.

관측 오류는 관련 경로의 신규 사용을 중지하고 원본을 보존해 조사한다. rollback도 active-process guard를 따른다. 이전 이미지를 복원하려고 실행 중인 작업을 끊거나 진행된 상태를 오래된 백업으로 되돌리지 않는다. 이전 이미지가 새 상태를 읽지 못하면 무리한 downgrade를 중단하고 격리 복구 또는 전진 수정을 선택한다.

## 9. 완료 기록 양식과 판정

완료 보고에는 다음 정보를 남긴다.

- 각 OPS의 변경 commit/digest와 실제 변경 파일.
- 각 AC의 pass/fail/blocked/skipped/not_verified 상태, 검증 시각·환경·근거 경로.
- baseline/candidate 성능 표와 호출·출력·내구성 비교.
- 서버 검증, 실제 클라이언트 검증, 운영 효과를 구분한 결과.
- 배포 버전·rollback 후보·남은 위험·미확정 원인.
- Kernel을 사용한 구현이면 Kernel의 실제 최종 next.action.type. 외부 문서로 done을 대신하지 않음.

구현·격리 검증을 끝내면 implementation_verified로 기록할 수 있다. 운영 배포와 실사용 확인 전에는 deployed/production_verified로 표시하지 않는다. 24시간 효과가 미검증이면 그 상태를 유지한다. 이번 문서 자체의 작성 완료는 제품 개선 완료를 뜻하지 않는다.

## 10. 증거 보관과 추적

### 10.1 파일별 역할

- 이 문서: 저장소에 보관하는 최종 계획과 안전한 집계 근거.
- [EXECUTION-CONTROL.md](EXECUTION-CONTROL.md): 현재 구현의 권한·실행·관측 계약.
- [EXECUTION-CONTROL-MEASUREMENT.md](EXECUTION-CONTROL-MEASUREMENT.md): 10월 24일 합성 시험. 실사용 성능 입증과 구분.
- `docs/runtime/review-2026-10-25/`: 이번 분석의 로컬 보고서 사본. Git/package payload에서 제외.
- 원시 로그·진단·영수증 원본: 기존 운영 저장소와 조사 산출물에 유지. 계획 문서나 패키지에 복사하지 않음.

### 10.2 로컬 근거 링크

다음 링크는 이 PC의 조사 사본이다. 다른 checkout에 파일이 없으면 본문의 집계 근거와 아래 digest를 확인하고 담당 실행 환경에서 원본을 요청한다. 링크 부재를 runtime 성공으로 해석하지 않는다.

- [상세 분석](../../runtime/review-2026-10-25/REVIEW.md)
- [주 구간 보고서](../../runtime/review-2026-10-25/after-session.json)
- [읽기 전용 영수증 대조](../../runtime/review-2026-10-25/after-session-live-receipts.json)
- [추가 집계](../../runtime/review-2026-10-25/analysis.json)
- [터널 안전 집계](../../runtime/review-2026-10-25/tunnel-summary.json)

### 10.3 항목 추적표

| 개선 | 증거 | 수용 기준 | 기존 후보와 관계 |
| --- | --- | --- | --- |
| OPS-01 | E03/E04/E15 | AC01/02 | MCP-17/24의 운영 연결 문제를 구체화 |
| OPS-02 | E05/E06 | AC03/04/05 | MCP-15/16/21. 메모리 인덱스 우선, 영속 인덱스는 측정 전 도입하지 않음. 완료·workflow 권한은 확장하지 않음 |
| OPS-03 | E07 | AC06 | MCP-21의 관측 예산 구체화 |
| OPS-04 | E08/E09 | AC07/08/14 | MCP-17/25. Events 도입 없이 개선 |
| OPS-05 | E10 | AC09/16 | MCP-22/26의 실효 설정 검증 |
| OPS-06 | E11 | AC10/11 | MCP-12/24의 receipt 복구 경로 보완 |
| OPS-07 | E12/E13/E14 | AC12/13 | MCP-19/20의 관측 분류 보완 |

<!-- evidence-digests:start -->

| 로컬 파일 | SHA-256 |
| --- | --- |
| REVIEW.md | cf658b9a97127647679a9297f38fee986554b5da6af9039719b4b6514316b329 |
| after-session.json | ab105b7d4604c0d3db8fd2812e939770f7968ecb616807e484433aee44c7b93e |
| after-session-live-receipts.json | 9e5721d866de2839ad79aeb596194616cec3e289423d683d77259df3102dd4a9 |
| analysis.json | 90e79c3630cbf3c3e0276f068fdecf8c8f54dbcf7a43304e81d1dd466422b04c |
| tunnel-summary.json | 121abc039facfa0e059086c382235067e692628892e4bd45af7ec9693c7d8bef |

<!-- evidence-digests:end -->

## 11. 문서 준비 결과

이번 산출물은 최종 계획 문서와 기존 계획 목차의 연결이다. 근거 사본은 Git에서 제외된 runtime 경로에 보관했다. 원시 로그·비밀·상태 DB를 새 source 문서에 추가하지 않았다.

두 차례 정적 리뷰를 반영해 OPS-01의 응답 전용 persistence verification과 deadline 계산식, OPS-02의 workspace-scoped index key, W5/W6의 후보·운영 검증 경계를 확정했다. 최종 검증에서 7개 OPS·15개 증거·18개 AC·7개 Wave를 확인했고, 로컬 링크 9개는 모두 존재했으며 근거 SHA-256 5개도 모두 일치했다. `git diff --check`도 통과했다. 제품 코드는 변경하지 않았으므로 제품 회귀 시험은 실행하지 않았다.

설치된 Relay/Kernel scripts와 package 명령에서 active knowledge repository audit 지원 진입점을 찾지 못했다. 따라서 해당 audit은 실행하지 않았다. 이 결과를 제품 구현 또는 Kernel 완료 판정으로 사용하지 않는다.
