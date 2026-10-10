# MCP-08 / MCP-04 저장 기반 구현

구현일: 2026-10-10 KST. 기준 HEAD: `e75d99a2bf1fe8deb0e5e6d94d81b011b460da42`.

Kernel Run: `run-b316c9f0-5b85-4c7a-93a7-d23af003054e`. 작업 순서: `mcp-08-schema` → `mcp-04-transaction`.

## MCP-08

`task-types.ts`의 저장 schemaVersion은 2다. installation metadata는 별도 schemaVersion 1을 유지한다. installationId와 HMAC 키를 새로 발급하지 않는다.

`storage-schema.ts`는 저장 레코드의 전체 타입, enum, 정수 revision, timestamp, ID, digest, checkpoint와 observation을 검사한다. task map 키, active pointer, mutation dedupe 결과의 소유자와 revision을 검사한다. receipt는 파일명, workspaceId, taskId 및 callerResolution 소유 관계를 검사한다. 잘못된 데이터는 `state_corrupt`, 알 수 없는 저장 버전은 `unsupported_schema`로 거부한다. 검증 오류에는 저장 본문을 넣지 않는다.

`storage-migration.ts`는 v1 원본 바이트를 workspace의 `schema-v1/`에 보존한다. 원본과 변환 결과 digest를 manifest에 저장한다. pending marker 뒤에 변환한다. 재시작은 중단 위치에 관계없이 동일한 v2 레코드로 수렴한다. 원본이나 현재 레코드가 예상 digest와 다르면 복구를 거부한다. 정상 rollback 뒤 v1 서버가 상태를 변경했다면 새 업그레이드는 `schema-v1-<원본 집합 digest>/`에 별도 백업을 만든다. 이전 백업은 보존한다. `schema-rollback.json`과 이전 백업 digest로 새 세대 사용을 확인한다.

기존 taskId, operationId, requestId, 상태, revision과 요약을 보존한다. legacy checkpoint와 completion 요약은 `caller_claim`이다. verified 단계나 성공 근거를 새로 만들지 않는다. context의 task에도 legacy 구분을 반환한다.

`TaskStore.restoreLegacyBackup(workspaceId)`는 writer guard 아래에서 수행하는 offline 유지보수 API다. 마이그레이션 이후 새 기록이나 상태 변경이 있으면 `rollback_unsafe`로 거부한다. 전체 백업 복원에 성공하면 store를 닫는다. 운영 서비스를 먼저 중지하고 복원을 끝낸 뒤에만 v1 서버를 시작해야 한다. 최신 상태를 보존하지 않은 downgrade는 허용하지 않는다. 운영 데이터에는 이 API를 실행하지 않았다.

## MCP-04

`ExecutionRecorder.withReconciliations()`는 대상 실행 lock을 일정한 순서로 잡는다. 모든 정산을 먼저 검사한다. 이후 `TaskStore.commitWorkspace()`가 receipt, checkpoint, task revision, workspace revision, requestId 성공 결과를 같은 journal에 저장한다. 읽기·쓰기·복구는 store 단위 잠금을 공유한다. 실패한 commit 뒤에는 잠금 안에서 복구 여부를 다시 확인한다. 다른 workspace에서 진행 중인 journal을 복구가 삭제하지 않는다. create·complete와 callerResolution 근거도 저장 전에 전체 소유 관계를 검사한다.

`storage-journal.ts`의 commit marker가 저장 결정이다. marker 이전 장애는 이전 상태를 유지한다. marker 이후 장애는 저장된 전체 새 상태로 복구한다. 대상 레코드 digest, journal digest, 파일명과 소유 관계를 검사한다. conflict가 있으면 덮어쓰지 않는다. snapshot은 receipt 뒤에 적용한다. 성공 응답은 전체 적용과 journal 정리 뒤에 반환한다.

준비 journal, commit marker와 대상 증가분에 필요한 저장 예산을 commit 전에 확인한다. 정상 읽기 전에 실패한 transaction 복구를 수행한다. 재시작 시 journal 복구를 boot recovery보다 먼저 수행한다. 복구는 metadata만 쓴다. shell, script, 파일 변경 효과를 다시 실행하지 않는다.

`storage-durability.ts`는 journal payload 삭제를 directory fsync로 영속화한 뒤 commit marker를 삭제한다. migration marker 삭제도 같은 규칙을 사용한다. POSIX의 fsync 실패는 성공으로 숨기지 않는다. 원자 쓰기는 새 상위 디렉터리 항목도 동기화한다. Windows는 Node directory fsync를 지원하지 않아 file fsync와 rename을 사용한다. Windows 전원 장애까지 동일한 영속성을 보장한다고 기록하지 않는다.

재시도에서 digest가 같아 쓰기를 생략한 레코드도 file fsync와 상위 directory fsync를 다시 수행한다. 기존 백업도 원본 교체 전에 같은 영속성 검사를 받는다. rename 후 fsync 실패를 바이트 일치로 통과시키지 않는다. Windows의 파일 동기화는 내용을 절단하지 않는 `r+` handle을 사용한다.

journal 적용 전에 payload와 commit marker의 영속성을 먼저 확인한다. 생성·완료의 dedupe 결과를 읽을 때도 snapshot을 다시 동기화한다. 메모리의 실패 상태가 없어지는 재시작 뒤에도 같은 규칙을 적용한다. 동기화 실패가 계속되면 성공 응답을 반환하지 않는다.

단일 파일 rename과 여러 저장 레코드 journal을 구분한다. 외부 명령의 효과나 여러 사용자 파일을 원자 transaction으로 보장하지 않는다.

## 검증과 상태

관련 격리 시험은 46/46을 통과했다. 저장 시험 36개와 기존 continuity·recovery 시험 10개다. 시험은 손상 revision·enum·receipt 소유자·파일명·dedupe 소유자·active pointer를 검사한다. migration 쓰기 6곳과 transaction 쓰기 5곳에 장애를 넣는다. 원본 보존, 재시작 수렴, 전체 정산, requestId 재조회, 재실행 없음, rollback 조건도 검사한다. 독립 검토 후에는 동시 workspace commit과 복구, create·complete·callerResolution의 교차 task 참조, 정리 단계 장애, fsync 실패 전파, 변경된 v1 상태의 재업그레이드 시험을 추가했다.

독립 검토 전 Windows의 전체 `npm test`는 POSIX 경로, shell과 파일 권한을 전제하는 기존 시험에서 실패했다. 당시 100개 중 79개 통과, 21개 실패다. 이 결과를 제품 전체 회귀 통과로 기록하지 않는다.

동일 시점의 Kernel `integration:docker`는 Linux 전체 100/100, typecheck, build, nginx 설정, 운영 의존성 검사(취약점 0개)를 통과했다. `report-04-retry-result.json`에 build digest `sha256:49c36d8f479e4c003352d9dd2803f935fef3705b5ee248d584e7beeddbcfe9f8`와 Docker digest `sha256:353417b4fbf61aa7b345b0432ff1722b64883a1f0b6c1788218e9e3efe9ab790`가 있다. 독립 검토는 중요 지적 5개와 문서 지적 1개를 반환했고, 위 수정과 추가 시험으로 대응했다. 첫 수정 뒤 Linux 111/111 회귀와 build도 통과했다. `report-storage-review-repair-result.json`의 Docker digest는 `sha256:f48a631cb43e73d7574b88416248d35e2add7f4692da6e0435732a367803ff5c`다. 두 번째 검토는 rename 뒤 fsync 실패의 재시도 지적 2개를 반환했고 위 재동기화와 추가 시험으로 대응했다. 해당 수정은 Linux 113/113 및 build를 통과했고 `report-storage-fsync-repair-result.json`의 Docker digest는 `sha256:42b96cf43f8ba8caa4c60fa46c64d1142eb878b7d60620f307b89fa65abaa659`다. 세 번째 검토의 commit 결정 및 dedupe 영속성 지적 2개도 수정했다. 현재 상태의 새 hard proof는 `report-storage-decision-repair-result.json`, 최종 독립 검토와 완료 판정은 계정 런타임의 최신 receipt를 따른다. 운영 컨테이너를 재시작하지 않는다.

Kernel의 최종 hard proof와 독립 security-review receipt는 계정 런타임에 저장한다. 연결·보고 JSON과 검증 로그의 위치는 `C:\Users\moon\.moon-relay-kernel\contracts\chatgpt-remote-mcp-storage-20261010\`다. 최종 완료는 `kernel next.action.type=done`으로만 판단한다.

BACKLOG의 상태는 `in_progress`다. 제품 구현은 있으나 구현 commit이 없으므로 계획의 `verified` 규칙을 충족했다고 표시하지 않는다. commit/push, 실제 배포, ChatGPT Refresh와 다른 30개 항목은 이번 구현 결과에 포함하지 않는다.
