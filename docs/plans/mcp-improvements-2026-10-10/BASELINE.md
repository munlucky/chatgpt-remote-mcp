# 기준과 근거

## 기준 시점

- 저장소: `chatgpt-remote-mcp`.
- HEAD: `e75d99a2bf1fe8deb0e5e6d94d81b011b460da42` (2026-10-10).
- 공개 도구: 현재 README와 등록 소스 기준 24개.
- MCP SDK: 현재 package.json 기준 `@modelcontextprotocol/sdk 1.32.1`.
- 이번 준비 작업 시작 시 Git 작업 트리는 비어 있었다.
- 이번 작업은 문서·작업 목록만 만든다. Docker 반영, 자동화 재개, consumer 변경은 수행하지 않는다.
- 기존 Git 정책이 새 docs 전체를 제외하므로 이번 계획 폴더만 예외로 추가했다. runtime 진단은 계속 제외한다. Docker payload 제외 규칙은 유지한다.

## 지연 분석에서 소비한 사실

| 관찰 | 값 | 해석 제한 |
| --- | ---: | --- |
| openai_mcp class 호출 | 4,615 | 대화 ID의 단독 귀속을 입증하지 않는다. probe와 다른 client class는 제외했다. |
| exec_command / read_process | 1,339 / 1,234 | 실제 호출 수다. 모두 낭비 호출은 아니다. |
| replace_in_file / write_file | 1,263 / 188 | 작은 편집의 묶음 처리 개선 후보를 보여 준다. |
| continuity 3개 API 호출 | 0 | 집계 기간의 호출이다. 오늘 추가 배포의 효과를 평가한 값이 아니다. |
| 프로세스 활성 시간 합집합 | 207.4분 | 전체 작업 시간 또는 모델 추론 시간을 뜻하지 않는다. |
| 10분 이상 호출 공백 합 | 499.6분 | 추론, 명시적 대기, 유지보수, 복구가 섞인다. 장애 시간으로 쓰지 않는다. |
| MCP 내부 overhead p95 | 5.6ms / 4.2ms | 10월 9일 / 10일 구간. 네트워크 왕복·모델 시간을 제외한 값이다. |
| 응답 바이트 / 최대 응답 | 34.88MiB / 725,858B | 컨텍스트 부담 후보다. 연결 해제의 직접 원인 증거는 아니다. |
| 복구 monitor resumeCount | 21 | 완료된 변경이 21회 재실행됐다는 뜻은 아니다. |

정량 자료의 class 관측 범위는 2026-10-09 14:04부터 2026-10-10 09:15까지다. 기준 commit의 추가 추적 강화는 그 뒤에 배포됐다. 과거의 continuity 0회를 새 구현의 실패 증거로 쓰지 않는다.

재개 화면에는 오래된 단계 요약부터 시작해 현재 이력을 다시 읽고 실제 단계를 정정한 사례가 있다. 반복 복원 비용은 관찰했다. 동일 소스 변경 전체가 매번 재실행됐다고 확정하지 않았다. ChatGPT conversation 429와 resume 404도 관찰했다. 최초 연결 해제 원인은 아직 미확정이다.

원본 진단은 `docs/runtime/moonshot-work-duration-2026-10-10.md/.json`에 있다. runtime 자료는 Git에서 제외된다. 이 패키지의 작업 판단에는 위의 익명화된 요약과 아래의 현재 소스 근거를 사용한다. 원시 로그와 전체 대화를 문서에 복사하지 않는다.

## 이미 있는 기능

| 기능 | 현재 근거 | 유지할 계약 |
| --- | --- | --- |
| exec/run 추적 강제 | src/exec-tools.ts | ID 누락을 spawn 전에 거부한다. |
| operation 중복 방지 | execution-recorder / task-store | 같은 ID·같은 입력은 기존 결과, 다른 입력은 충돌이다. |
| checkpoint revision CAS | task-service | 오래된 revision을 자동 병합하지 않는다. |
| atomic 단일 상태 파일 저장 | task-store | 임시 파일·fsync·rename과 단일 writer guard를 유지한다. |
| 재시작 미확정 상태 | task-store | 이전 boot의 prepared/running은 unknown이다. 자동 재실행하지 않는다. |
| summary context | context-summary | omission과 불확실성을 보존한다. |
| 증분 process 출력 | exec-tools / process-output-buffer | nextSeq·hasMore·waitMs를 사용한다. |
| metadata 중심 process 목록 | exec-tools | 기본 bounded 목록을 유지한다. |
| lifecycle telemetry | telemetry | 명령·stdout·token 본문을 저장하지 않는다. |
| 배포 전 active-process guard | scripts/start.ps1 | 활성 실행 중의 강제 배포를 하지 않는다. |
| live/catalog/build 검사 | verify-live / verify-docker | 서버 검증과 ChatGPT 확인을 구분한다. |

## 근거 목록

### E01

- 위치: `docs/runtime/moonshot-work-duration-2026-10-10.json (local ignored diagnostic)`.
- 사실: 2026-10-09~10 관찰: openai_mcp class 4615 calls, continuity 0, 1352 terminal executions, 207.4 active-union minutes. 10분 이상 공백 합 499.6분. 원래 대화 ID와 동일하다고 입증한 집계가 아니다.

### E02

- 위치: `docs/runtime/moonshot-work-duration-2026-10-10.md (local ignored diagnostic)`.
- 사실: conversation API 429와 resume stream 404를 관찰했다. 최초 연결 해제 원인은 미확정이다. MCP/tunnel 상태와 GPT 서비스 오류를 구분해야 한다.

### E03

- 위치: `src/continuity/task-types.ts; src/continuity/task-service.ts:161; src/continuity/task-tools.ts`.
- 사실: freeform checkpoint replacement와 revision CAS가 있다. 단계 상태·의미적 후퇴·대기 enum은 없다.

### E04

- 위치: `src/continuity/task-service.ts:467; src/continuity/task-tools.ts:17`.
- 사실: receipt 존재 검사, artifact hash 검사, refs.slice(0,50). 입력은 max100. workspaceFingerprint는 검사하지 않는다.

### E05

- 위치: `src/continuity/task-service.ts:223`.
- 사실: complete는 unresolved execution을 거부한다. evidence 유효성·필수 단계·blockers/remaining 검사는 하지 않는다.

### E06

- 위치: `src/continuity/task-service.ts:161; src/continuity/task-store.ts`.
- 사실: 관찰은 lock 전이다. reconcile receipts는 writeWorkspace 전에 별도 저장한다.

### E07

- 위치: `src/continuity/task-store.ts:43`.
- 사실: JSON parse, schemaVersion 및 일부 필드만 검사한다. 다른 schema version은 거부한다. storage budget 초과는 fail-closed다.

### E08

- 위치: `src/exec-tools.ts; src/continuity/execution-recorder.ts; README.md:110`.
- 사실: tracked exec/run의 예약·중복 방지·nextCall·증분 출력이 있다. taskRevision/stage binding과 stdin 요청 dedupe는 없다.

### E09

- 위치: `src/file-service.ts:314; src/file-service.ts:417; src/file-service.ts:459; src/file-tools.ts`.
- 사실: write/replace는 direct write다. 파일 변경 도구는 tracked execution과 다른 경로이며 expected digest를 받지 않는다.

### E10

- 위치: `src/tool-result.ts:11; src/file-tools.ts:115`.
- 사실: 기본 success/error result는 text와 structuredContent를 함께 반환한다. read_file 기본 maxBytes는 256 KiB다.

### E11

- 위치: `src/continuity/task-service.ts:404; src/continuity/task-tools.ts:71`.
- 사실: full view는 recent/checkpoint를 일부 축소한 뒤 반환한다. cursor는 reserved이며 handler가 전달하지 않는다.

### E12

- 위치: `src/continuity/context-summary.ts`.
- 사실: summary는 omission/count를 보존한다. task가 있으면 recovery.nextCall은 항상 full context다.

### E13

- 위치: `src/batch-read.ts; src/file-tools.ts`.
- 사실: read_files는 최대16개, 동시4개, 파일별 최대16KiB다. 전체 tool envelope 예산과 digest 조건부 읽기는 없다.

### E14

- 위치: `src/continuity/task-store.ts:282; src/continuity/workspace-snapshot.ts`.
- 사실: 실행 receipt를 전체 읽고 정렬한다. workspace 관찰은 bounded fingerprint를 사용한다.

### E15

- 위치: `src/telemetry.ts; scripts/usage-report.mjs; test/execution-observability.test.ts`.
- 사실: redacted request/process lifecycle metadata와 probe 제외가 있다. UA 분류는 대화 신원이 아니다.

### E16

- 위치: `scripts/start.ps1; scripts/verify-live.mjs; scripts/verify-docker.mjs`.
- 사실: active process 배포 guard와 live/build/catalog 검증은 이미 있다. 다음 스키마 변경의 migration canary는 별도 필요하다.

### E17

- 위치: `src/paths.ts; src/continuity/workspace-identity.ts; src/config.ts`.
- 사실: executionRoot/alias와 플랫폼 의존 경로가 있다. Git 실패는 일부 경로에서 null로 취급한다.

### E18

- 위치: `templates/chatgpt-project-instructions.md; templates/AGENTS.md`.
- 사실: ChatGPT 프로젝트 지침이 있다. 실제 사용과 서버 enforcement의 효과는 별도로 확인해야 한다.

### E19

- 위치: `https://developers.openai.com/plugins/deploy/connect-chatgpt`.
- 사실: custom MCP 갱신은 Refresh 후 metadata 확인과 새 대화의 영향 시험을 포함한다. 게시 plugin 경로는 다르다.

### E20

- 위치: `https://developers.openai.com/plugins/build/mcp-events`.
- 사실: Events는 Work/Cloud 등 지정 surface와 MCP2.0을 요구한다. webhook 구독을 지원하며 기존 일반 chat stream 복구 보장은 아니다.

### E21

- 위치: `test/recovery.integration.test.ts; test/continuity.test.ts; test/file-service.test.ts; test/performance.test.ts`.
- 사실: 기존 테스트에 새 계약의 수용 시험을 추가한다. 현재 준비 작업에서 제품 테스트를 다시 실행하지 않았다.

## 공식 외부 조건

custom MCP metadata 갱신의 기준은 [OpenAI 연결·검증 문서](https://developers.openai.com/plugins/deploy/connect-chatgpt)다. Refresh 뒤 metadata 변경과 새 대화의 영향 시험을 확인한다. 기존 대화 반영은 별도로 확인한다. :codex-annotation{index="1"}

이벤트 지원 조건은 [OpenAI MCP Events 문서](https://developers.openai.com/plugins/build/mcp-events)다. MCP-29에서 현재 SDK·계정·surface의 실제 지원을 먼저 판정한다. 해당 기능은 기존 대화의 stream 복구 완료 증거가 아니다.
