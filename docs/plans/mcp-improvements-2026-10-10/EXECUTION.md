# 실행 순서와 검증

## 작업 묶음

항목 내부 순서도 BACKLOG.json의 dependsOn을 따른다. 각 묶음의 변경을 검증한 뒤 다음 묶음으로 간다.

| 묶음 | 항목 | 목적 |
| --- | --- | --- |
| W1 기반 | MCP-08 → MCP-04; MCP-13, MCP-06, MCP-22 | schema/journal, 응답 예산, client·환경 진단. 독립 항목은 순차 또는 안전한 병행이 가능하다. |
| W2 복구·변경 | MCP-01, MCP-12, MCP-02, MCP-05, MCP-07, MCP-09, MCP-11, MCP-15, MCP-17, MCP-18 | 단계와 실제 변경·검증의 연결. |
| W3 수용·운영 | MCP-03, MCP-10, MCP-14, MCP-16, MCP-19, MCP-20, MCP-21, MCP-23, MCP-24, MCP-25, MCP-32, MCP-26 | 완료 guard, 효율·진단, 실제 ChatGPT 및 배포 수용 시험. |
| W4 조건부 확장 | MCP-27, MCP-28, MCP-29 → MCP-30 → MCP-31 | 보관 정책과 Events. surface/SDK 불가 시 이벤트 항목은 blocked_supported_surface로 남긴다. |

P0 항목을 먼저 닫는 것을 목표로 한다. P0가 의존하는 P1은 함께 수행한다. P2를 구현하느라 상태 무결성 작업을 미루지 않는다.

## 첫 구현 작업의 입력

다음 문장을 작업 시작 지침으로 사용할 수 있다:

> 이 저장소의 docs/plans/mcp-improvements-2026-10-10/README.md, CONTRACTS.md, BACKLOG.json을 읽어라. 현재 HEAD와 실제 코드를 다시 확인해라. MCP-08을 먼저 구현하고 검증해라. 기존 v1 상태를 보존하며 전체 스키마 검증과 반복 가능한 migration을 추가해라. 기존 taskId와 프로젝트 계약을 재발급하지 마라. consumer 프로젝트, 현재 실행 프로세스와 PAUSED 자동화를 변경하지 마라. 제품 구현과 해당 수용 시험 결과를 기록한 뒤 MCP-04로 진행해라. 커밋·푸시·실제 Docker 배포는 별도 요청 범위를 따르라.

이 지침은 새 대화나 subagent를 자동으로 생성하는 명령이 아니다. 현재 준비 작업에서 실행하지 않았다.

## 항목 완료 규칙

1. 기준 commit과 현재 diff를 비교한다. 먼저 이미 구현됐는지 확인한다.
2. 해당 항목의 problem·change·acceptance와 공통 계약을 읽는다.
3. 새 필드·오류·호환 정책을 확정하고 해당 항목의 paths를 갱신한다.
4. 가장 작은 관련 수용 시험을 추가하거나 기존 시험을 확장한다.
5. 구현과 테스트를 실행한다. 구현을 복사하는 테스트보다 실패 경계와 실제 효과를 검사한다.
6. 서버/API proof와 실제 ChatGPT proof를 별도로 기록한다.
7. BACKLOG.json의 status와 구현 근거를 갱신한다. 코드만 있거나 acceptance가 빠지면 done이 아니다.

항목 status는 planned → in_progress → verified다. 조건 미충족은 blocked다. 검증 receipt와 구현 commit 없이는 verified로 바꾸지 않는다. 구현 변경을 시작할 때 completionEvidence 필드를 추가한다.

## 검증 명령

실행 예시다. 이번 문서 준비 작업에서 아래 제품 시험은 실행하지 않았다.

```powershell
npm run typecheck
npm test -- test/continuity.test.ts test/recovery.integration.test.ts
npm test -- test/file-service.test.ts test/process-manager.test.ts
npm test -- test/performance.test.ts test/tool-metadata.test.ts
```

변경 경계에 해당하는 시험만 먼저 실행한다. 묶음 종료 시 `npm test`, `npm run build`로 제품 회귀를 확인한다. Docker 검증은 `npm run integration:docker`의 isolated 환경을 사용한다. 실제 컨테이너 재기동은 배포 요청과 active-process guard를 따른다.

## 필수 재현 시나리오

| 시나리오 | 기대 결과 |
| --- | --- |
| 이전 checkpoint 요약으로 돌아감 | stage_regression 또는 명시적 replan. |
| 같은 operation의 응답 유실 후 재요청 | 효과 1회. 기존 결과 조회. |
| append/patch/stdin 중복 입력 | 중복 효과 없음 또는 확인 불가 unknown. |
| effect 뒤 receipt 저장 실패 | 재실행 없음. 상태 조회와 명시적 정산. |
| 여러 reconciliation 중 하나가 실패 | journal 복구로 일관된 checkpoint/receipts. |
| 완료 검증 뒤 관련 소스 변경 | stale evidence. strict completed 거부. |
| 51번째 evidence 누락 | 전체 통과로 보고하지 않음. |
| context 1만 receipts / 대량 unresolved | 예산 내 응답과 완전한 페이지 조회. |
| 사용자 승인 대기 / explicit stop | 자동 재개하지 않음. |
| Git 관찰 timeout / 외부 파일 변경 | completeness와 이유를 보존. |
| old catalog + required tracking | refresh 경로 안내. 동일 오류 반복 없음. |
| isolated 새 스키마 migration + downgrade | 상태 복원 조건을 지킨 rollback. |

## ChatGPT 연결 갱신 수용 기준

서버 catalog 검사는 MCP-06에서 자동화한다. ChatGPT 측 검사는 MCP-23에서 실제 UI와 도구 호출로 확인한다. 아래 3개 결과를 섞지 않는다:

- server_verified: raw tools/list, schema, catalogDigest가 배포와 일치한다.
- plugin_metadata_verified: 연결 화면의 metadata가 변경됐다.
- client_verified: 새 대화에서 영향 도구를 실제 호출했다. 기존 대화의 가능 여부는 따로 기록한다.

현재 사용 중인 기존 대화를 임의로 중지하거나 다른 대화로 옮기지 않는다. live acceptance를 수행할 때 사용자 작성 중인 입력을 덮어쓰지 않는다. Refresh 확인만으로 기존 응답 생성이 해제됐다고 기록하지 않는다.

## 성능 검증

baseline은 같은 fixture와 같은 acceptance로 비교한다. 모델 호출 시간과 MCP 처리 시간을 구분한다.

- 주 지표: 동일 완료 단계 수, 변경 효과 중복 0, 응답 바이트, 조회·편집 호출 수.
- 보조 지표: 서버 p50/p95, state 읽기 수, process active 시간, caller 대기.
- 제안 목표: fixture 응답 바이트 50% 감소, 조회·편집 호출 30% 감소.
- 목표 미달 시 결과를 그대로 남긴다. 입력 크기나 acceptance를 줄여 통과시키지 않는다.
- 모델을 포함한 E2E는 여러 실행 조건과 한계를 기록한다. 1회 성공은 일반 속도 보장이 아니다.

## 배포 종료 기준

구현 → 관련 시험 → 전체 회귀 → isolated Docker → source/image/runtime/catalog/schema 일치 → ChatGPT acceptance 순서로 확인한다. active 실행 중에는 기존 배포 guard를 유지한다.

상태 migration 백업과 rollback 검증이 완료되지 않으면 strict 정책을 활성화하지 않는다. 새 SDK/protocol 또는 Events는 기존 도구와 인증의 회귀까지 통과해야 활성화한다.

브라우저 반복 자동화는 재개하지 않는다. GPT 서비스 429·stream 장애의 최초 원인은 별도 서비스 증거 없이 MCP 결함으로 확정하지 않는다.

