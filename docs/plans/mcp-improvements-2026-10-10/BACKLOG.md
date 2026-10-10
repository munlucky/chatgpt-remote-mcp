# 상세 개선 목록

기준과 공통 계약은 [BASELINE.md](BASELINE.md), [CONTRACTS.md](CONTRACTS.md)를 따른다. 모든 항목은 `planned`다. 제품 구현과 수용 시험이 끝나기 전에는 완료로 바꾸지 않는다.

## MCP-01 · 체크포인트 단계 후퇴 방지

- 우선순위: P0. 영역: 상태·복구·완료. 분류: 현재 코드의 계약 공백. 규모: L.
- 문제: 현재 revision만 일치하면 phase·completed·remaining을 교체할 수 있다. 이전 요약이 최신 진행을 덮을 수 있다.
- 변경: 단계 ID, 현재 cursor, 단계별 상태와 명시적 replan 전이를 추가한다. 작업 계약을 새로 발급하지 않는다.
- 선행 항목: MCP-08.
- 근거: E03. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/continuity/task-types.ts`, `src/continuity/task-service.ts`, `src/continuity/task-tools.ts`, `test/continuity.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- 같은 revision으로 완료 단계를 되돌리면 stage_regression을 반환한다.
- 되돌리기는 이유와 영향 단계가 있는 명시적 replan으로만 허용한다.
- 기존 taskId와 프로젝트 계약 ID를 보존한다.

## MCP-02 · 검증 근거의 결과·범위·신선도 확인

- 우선순위: P0. 영역: 상태·복구·완료. 분류: 현재 코드의 계약 공백. 규모: L.
- 문제: receipt는 존재만 확인한다. workspaceFingerprint를 쓰지 않는다. 최대 100개 입력 중 앞 50개만 확인한다.
- 변경: 검증 레코드를 operationId, taskId, stageId, 성공 판정 규칙, 관련 파일 digest와 연결한다. 누락과 변경을 구분한다. 검증기와 결과의 출처를 검사하며 caller 라벨만으로 통과시키지 않는다.
- 선행 항목: MCP-08, MCP-12.
- 근거: E04. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/continuity/task-types.ts`, `src/continuity/task-service.ts`, `src/continuity/task-tools.ts`, `test/continuity.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- 실패·unknown receipt는 검증 통과 근거가 되지 않는다.
- 관련 소스가 바뀌면 이전 검증은 stale이 된다. 무관한 로그 변경은 영향 범위 밖이면 무효화하지 않는다.
- 51번째 이후 근거도 확인하거나 checked/unchecked 수와 미검증 목록을 반환한다.
- artifact의 실제 경로와 digest를 확인한다. 실행 성공과 acceptance 충족을 구분한다.
- reconciliation에도 같은 근거 검사를 적용한다. caller가 붙인 test_passed 라벨만으로 검증 통과를 기록하지 않는다.

## MCP-03 · 완료 처리의 근거와 권한 경계

- 우선순위: P0. 영역: 상태·복구·완료. 분류: 현재 코드의 계약 공백. 규모: M.
- 문제: complete_work는 미해결 실행을 확인하지만 supplied evidence, remaining, blockers를 검증하지 않는다.
- 변경: 엄격 모드에서 필수 단계, 유효한 근거, 남은 작업과 대기를 검사한다. MCP 작업 종료와 Kernel의 프로젝트 완료 판정을 구분한다.
- 선행 항목: MCP-01, MCP-02, MCP-18.
- 근거: E05. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/continuity/task-service.ts`, `src/continuity/task-tools.ts`, `test/continuity.test.ts`, `test/recovery.integration.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- 필수 검증이 stale이거나 미완료이면 completed를 거부한다.
- HTTP 200 또는 프로세스 exit 0만으로 프로젝트 완료를 보고하지 않는다.
- abandoned는 원인과 미확정 효과를 남긴다. 실행 프로세스를 자동 종료하지 않는다.
- 외부 완료 권한이 Kernel이면 그 권한을 대체하지 않는다.

## MCP-04 · 실행 정산과 체크포인트의 일관된 저장

- 우선순위: P0. 영역: 상태·복구·완료. 분류: 현재 코드의 계약 공백. 규모: L.
- 문제: update는 실행 reconciliation을 먼저 저장하고 workspace를 나중에 저장한다. 중간 실패의 일관성이 보장되지 않는다.
- 변경: 작은 transaction journal과 commit marker로 다중 레코드 변경을 복구 가능하게 만든다. 단일 파일 atomic write는 유지한다.
- 선행 항목: MCP-08.
- 근거: E06. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/continuity/task-store.ts`, `src/continuity/task-service.ts`, `src/continuity/execution-recorder.ts`, `test/recovery.integration.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- 각 쓰기 지점에 장애를 넣어도 재시작 뒤 이전 상태 또는 전체 새 상태로 수렴한다.
- requestId의 성공 응답은 commit된 결과와 일치한다.
- 복구 과정은 명령을 재실행하지 않는다.

## MCP-05 · 실행을 최신 단계와 연결

- 우선순위: P0. 영역: 상태·복구·완료. 분류: 현재 코드의 계약 공백. 규모: M.
- 문제: taskId·operationId는 강제할 수 있지만 실행이 어느 체크포인트와 단계에서 시작됐는지는 기록하지 않는다.
- 변경: 실행 예약에 taskRevision, stageId, source scope를 붙인다. 새 변경 단계 시작 전에 필요한 checkpoint를 확인한다.
- 선행 항목: MCP-01, MCP-04.
- 근거: E08, E01. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/exec-tools.ts`, `src/continuity/execution-recorder.ts`, `src/continuity/task-types.ts`, `test/continuity.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- 엄격 모드에서 오래된 단계로 새 변경 실행을 시작하면 spawn 전에 거부한다.
- 동일 operationId의 조회·재응답은 기존 receipt를 돌려준다.
- 명령마다 전체 context를 읽도록 강제하지 않는다. 같은 단계의 연속 실행을 지원한다.

## MCP-06 · 도구 버전·기능 확인과 구형 클라이언트 안내

- 우선순위: P0. 영역: ChatGPT·환경·배포. 분류: 예방·효율 개선. 규모: M.
- 문제: 서버 배포 성공은 기존 ChatGPT 대화가 새 도구를 아는 증거가 아니다. tracking_required가 새 도구 호출만 제시하면 구형 목록에서 막힐 수 있다.
- 변경: catalogDigest, buildId, protocolVersion, 기능 목록을 진단 응답과 기존 실행 오류에 넣는다. 클라이언트 갱신이 필요한 경우를 분명히 안내한다.
- 선행 항목: 없음.
- 근거: E08, E19. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/mcp-server.ts`, `src/tool-metadata.ts`, `src/exec-tools.ts`, `scripts/verify-live.mjs`, `test/tool-metadata.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- 캐시된 구형 도구 목록에서 새 도구가 없으면 같은 실패 호출을 반복하지 않는다.
- 원시 tools/list 결과와 canonical catalogDigest가 일치한다.
- 서버 관측값과 실제 ChatGPT 갱신 확인 상태를 별도로 기록한다.
- 기존 도구의 read-only 진단 경로는 변경 명령을 실행하지 않는다.

## MCP-07 · 파일 변경도 실행 ID로 추적

- 우선순위: P0. 영역: 파일·입력 변경. 분류: 현재 코드의 계약 공백. 규모: L.
- 문제: 파일 편집은 task·operation receipt 경로 밖에 있다. 실행 중복 방지만으로 write/append/replace/patch 재시도를 막을 수 없다.
- 변경: write_file, replace_in_file, apply_patch부터 변경 예약·결과·조회 receipt를 추가한다. 다른 변경 도구도 같은 적용표로 정리한다.
- 선행 항목: MCP-04, MCP-08.
- 근거: E09, E08, E01. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/file-tools.ts`, `src/file-service.ts`, `src/continuity/execution-recorder.ts`, `test/file-service.test.ts`, `test/recovery.integration.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- 같은 ID와 같은 입력의 append가 두 번 들어와도 한 번만 반영한다.
- 같은 ID의 다른 입력은 충돌로 거부한다.
- 반영 후 응답 유실 시 파일 상태와 receipt를 먼저 조회한다.
- 결과를 확인할 수 없으면 unknown으로 남긴다. 자동 재적용하지 않는다.

## MCP-08 · 저장 스키마 검증과 안전한 마이그레이션

- 우선순위: P0. 영역: 상태·복구·완료. 분류: 현재 코드의 계약 공백. 규모: L.
- 문제: 저장 파일은 일부 필드만 검사한다. 현재 스키마 외 버전은 즉시 거부한다.
- 변경: 저장 레코드 전체의 타입·상호 참조·enum을 검증한다. v1 백업, v2 변환, 재시작 검증, rollback 조건을 만든다.
- 선행 항목: 없음.
- 근거: E07. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/continuity/task-types.ts`, `src/continuity/task-store.ts`, `test/continuity.test.ts`, `test/recovery.integration.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- 잘못된 revision·상태·receipt 소유 관계를 읽기 단계에서 거부한다.
- v1 원본을 보존하고 변환을 반복해도 결과가 같다.
- legacy 요약을 verified로 승격하지 않는다.
- 이전 서버가 새 스키마를 읽을 수 없을 때 상태 복구 없이 다운그레이드하지 않는다.

## MCP-09 · 편집 충돌 감지와 단일 파일 원자 쓰기

- 우선순위: P1. 영역: 파일·입력 변경. 분류: 현재 코드의 계약 공백. 규모: L.
- 문제: write/replace는 파일에 직접 쓴다. replace의 읽기와 쓰기 사이 변경을 검사하지 않는다.
- 변경: expectedSha256 또는 명시적 create 조건을 추가한다. 동일 파일 변경을 직렬화하고 임시 파일·fsync·rename을 적용한다.
- 선행 항목: MCP-07.
- 근거: E09. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/file-service.ts`, `src/file-tools.ts`, `test/file-service.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- 사용자 또는 다른 실행의 동시 수정은 content_conflict로 보존한다.
- 서버 중단 후 이전 파일 또는 완전한 새 파일이 남는다.
- 인코딩, 개행, mode, symlink 처리 정책을 명시하고 검증한다.
- 외부 프로세스까지 잠그는 범용 CAS라고 주장하지 않는다.

## MCP-10 · 패치 계획·일괄 편집·부분 실패 결과

- 우선순위: P1. 영역: 파일·입력 변경. 분류: 예방·효율 개선. 규모: M.
- 문제: replace 호출이 많았다. 여러 편집의 순서와 부분 반영 여부를 클라이언트가 직접 추적한다.
- 변경: 기존 apply_patch를 중심으로 dry-run, 파일별 pre/post digest, patch operation receipt를 제공한다. 필요한 경우에만 bounded batch를 추가한다.
- 선행 항목: MCP-09, MCP-13.
- 근거: E01, E09. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/file-service.ts`, `src/file-tools.ts`, `test/file-service.test.ts`, `test/all-tools.integration.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- dry-run은 파일을 변경하지 않는다.
- 문맥 불일치와 부분 반영을 파일별로 반환한다.
- 동일 patch operation 조회가 새 patch 실행을 만들지 않는다.
- 여러 파일의 OS 수준 원자성을 보장한다고 표시하지 않는다.

## MCP-11 · 표준 입력 전송의 중복 방지

- 우선순위: P1. 영역: 파일·입력 변경. 분류: 현재 코드의 계약 공백. 규모: M.
- 문제: write_stdin은 chars를 반복 전송할 때의 요청 ID가 없다.
- 변경: 세션별 stdin requestId와 입력 HMAC, 전송 결과를 저장한다. 재전송과 새 입력을 구분한다.
- 선행 항목: MCP-04, MCP-08.
- 근거: E08. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/exec-tools.ts`, `src/process-manager.ts`, `test/process-manager.test.ts`, `test/recovery.integration.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- 같은 입력 요청이 재도착해도 바이트를 한 번만 전송한다.
- closeStdin 재요청은 같은 결과를 반환한다.
- 전송 여부가 불확실하면 자동 재전송하지 않는다.
- 본문은 로그와 receipt에 저장하지 않는다.

## MCP-12 · 명확한 실행 조회와 최소 결과 요약

- 우선순위: P1. 영역: 상태·복구·완료. 분류: 예방·효율 개선. 규모: M.
- 문제: 재시작 뒤 durable receipt는 남지만 stdout은 사라질 수 있다. 클라이언트가 결과 근거를 다시 찾는다.
- 변경: operationId 직접 조회와 출력 가용성 상태를 제공한다. 검증 결과의 구조화 요약·artifact digest를 명시적 옵션으로 저장한다.
- 선행 항목: MCP-04, MCP-08.
- 근거: E08, E01. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/continuity/execution-recorder.ts`, `src/continuity/task-service.ts`, `src/exec-tools.ts`, `test/recovery.integration.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- receipt가 남고 출력이 없으면 output_unavailable을 명시한다.
- 요약은 exitCode·검증기·검증 대상 digest를 구분한다.
- 원시 명령, 전체 stdout, 코드, 자격 증명을 기본 저장하지 않는다.
- 요약을 만들지 못한 경우 검증 성공을 추정하지 않는다.

## MCP-13 · 전체 MCP 응답의 바이트 예산

- 우선순위: P1. 영역: 출력·조회. 분류: 현재 코드의 계약 공백. 규모: M.
- 문제: 기본 result는 text와 structuredContent에 같은 데이터를 넣는다. 파일 읽기는 기본 256 KiB다. 큰 응답이 실측됐다.
- 변경: 직렬화된 전체 tool result에 예산을 적용한다. text는 짧은 요약, 구조화 데이터는 bounded page로 반환한다.
- 선행 항목: 없음.
- 근거: E10, E13, E01. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/tool-result.ts`, `src/exec-tools.ts`, `src/file-tools.ts`, `src/config.ts`, `test/performance.test.ts`, `test/all-tools.integration.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- text+structuredContent+metadata를 합친 UTF-8 바이트가 설정 예산을 넘지 않는다.
- 한글·emoji·base64·오류 응답도 검사한다.
- 생략한 데이터는 cursor·nextOffset으로 읽을 수 있다.
- 기존 명시적 대용량 전송 모드는 별도 상한과 표시를 갖는다.

## MCP-14 · 파일 조회·검색의 작은 응답

- 우선순위: P1. 영역: 출력·조회. 분류: 예방·효율 개선. 규모: M.
- 문제: read_files는 파일별 상한만 있다. 전체 파일 읽기와 exec 기반 검색이 반복됐다.
- 변경: 전체 batch 예산, metadata/조건부 읽기, 필요한 범위 읽기를 추가한다. bounded search는 기존 도구 확장과 별도 도구의 비용을 비교해 하나를 택한다.
- 선행 항목: MCP-13.
- 근거: E13, E01. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/batch-read.ts`, `src/file-tools.ts`, `src/file-service.ts`, `test/file-service.test.ts`, `test/performance.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- 변경 없는 파일은 digest 기준 not_modified로 답한다.
- 검색은 파일·일치 수·문맥·총바이트를 제한하고 truncation을 명시한다.
- 16개 파일 요청도 전체 응답 예산을 지킨다.
- 필요 범위를 확인하지 않고 모든 파일 본문을 미리 읽지 않는다.

## MCP-15 · 복구 context의 실제 페이지 처리

- 우선순위: P1. 영역: 출력·조회. 분류: 현재 코드의 계약 공백. 규모: M.
- 문제: cursor가 노출됐지만 처리하지 않는다. full 응답은 일부 축소 뒤에도 observation/unsettled가 커질 수 있다.
- 변경: 단계·근거·실행·관찰을 section과 cursor로 조회한다. 생략 수와 전체 미해결 수를 보존한다.
- 선행 항목: MCP-13, MCP-08.
- 근거: E11, E12. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/continuity/task-service.ts`, `src/continuity/task-tools.ts`, `src/continuity/context-summary.ts`, `test/continuity.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- 대량 unknown/running receipt에서도 전체 응답 상한을 지킨다.
- 모든 항목을 페이지로 찾을 수 있다.
- 페이지 누락을 완료·재시도 허가로 바꾸지 않는다.
- summary의 nextCall은 실제 부족한 section만 요구한다.

## MCP-16 · receipt 조회 인덱스

- 우선순위: P1. 영역: 출력·조회. 분류: 예방·효율 개선. 규모: M.
- 문제: listExecutions는 전체 파일을 읽고 정렬한다. task 탐색도 상태 파일 순회에 의존한다.
- 변경: task/operation/상태별 재생성 가능한 인덱스를 추가한다. 원본 receipt를 사실의 기준으로 유지한다.
- 선행 항목: MCP-15.
- 근거: E14. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/continuity/task-store.ts`, `test/continuity.test.ts`, `test/performance.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- 1만 receipt에서 단일 operation 조회가 전체 본문 스캔을 하지 않는다.
- 인덱스 유실 후 원본에서 재구성한다.
- 미해결 receipt는 페이지와 active count에서 누락하지 않는다.

## MCP-17 · 변화에 따른 프로세스 조회 간격

- 우선순위: P1. 영역: 출력·조회. 분류: 예방·효율 개선. 규모: M.
- 문제: read_process의 waitMs와 cursor는 이미 있다. 클라이언트가 짧은 간격으로 다시 호출할 수 있다.
- 변경: outputChanged/stateChanged와 recommendedWaitMs를 제공한다. 기존 long-poll과 증분 조회를 사용하도록 안내한다.
- 선행 항목: MCP-13.
- 근거: E08, E01. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/exec-tools.ts`, `src/process-manager.ts`, `src/process-output-buffer.ts`, `test/process-manager.test.ts`, `test/performance.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- 출력 없는 장기 실행은 bounded backoff로 조회 수가 줄어든다.
- 새 출력·종료는 long-poll을 깨운다.
- hasMore=true이면 잔여 출력을 읽는다.
- active process 0만으로 중단 또는 완료를 판정하지 않는다.

## MCP-18 · 사용자 대기·서비스 대기·정체 상태 구분

- 우선순위: P1. 영역: 상태·복구·완료. 분류: 현재 코드의 계약 공백. 규모: M.
- 문제: TaskRecord에는 active/completed/abandoned만 있다. blocker의 의미는 자유 문장에 있다.
- 변경: execution lifecycle과 별도로 workflowStatus를 둔다. waiting_user, waiting_approval, waiting_service, blocked와 재개 조건을 기록한다.
- 선행 항목: MCP-01.
- 근거: E03, E01, E02. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/continuity/task-types.ts`, `src/continuity/task-service.ts`, `src/continuity/context-summary.ts`, `test/continuity.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- 사용자 입력·승인 대기는 자동 다음 실행 대상으로 반환하지 않는다.
- 무활동만 있으면 stalled로 확정하지 않고 evidence/confidence를 반환한다.
- 429는 retryAfterAt을 지킨다. 없으면 정책상 다음 점검 시각을 명시한다.
- 사용자가 중지한 작업은 이벤트 또는 복구 요약으로 다시 시작하지 않는다.

## MCP-19 · 작업·단계·호출 상관관계

- 우선순위: P1. 영역: 관측·성능·보관. 분류: 예방·효율 개선. 규모: M.
- 문제: openai_mcp는 UA 기반 클래스다. 하나의 대화 ID를 입증하지 않는다.
- 변경: 서버가 검증한 taskId/operationId/stageId와 requestId/sessionId/bootId/buildId를 연결한다. conversation 연결은 명시적 opaque 식별자로만 선택한다.
- 선행 항목: MCP-05, MCP-07, MCP-11.
- 근거: E15, E01. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/telemetry.ts`, `src/http-server.ts`, `src/exec-tools.ts`, `src/file-tools.ts`, `test/execution-observability.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- 원래 작업·probe·다른 클라이언트 호출을 가능한 근거 범위로 구분한다.
- 클라이언트 주장과 서버 검증 필드를 구분한다.
- 토큰·쿠키·환경값·명령·대화·파일 본문을 로그에 넣지 않는다.

## MCP-20 · 병목과 오류 유형을 나누는 사용 보고서

- 우선순위: P1. 영역: 관측·성능·보관. 분류: 예방·효율 개선. 규모: M.
- 문제: HTTP 성공과 toolError·exitCode·원래 작업 진전은 다르다. 호출 간 공백도 장애 시간이 아니다.
- 변경: 단계별 calls/bytes/wait/active-union/반복 조회/오류 코드를 보고한다. 무활동 구간은 unknown, reasoning, explicit_wait, service_error 근거로 구분한다.
- 선행 항목: MCP-19.
- 근거: E15, E01, E02. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `scripts/usage-report.mjs`, `scripts/usage-report.ps1`, `src/telemetry.ts`, `test/execution-observability.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- HTTP 200+toolError와 exit 1을 별도 집계한다.
- 검색의 no-match를 테스트 실패로 자동 분류하지 않는다.
- probe와 다른 작업을 원래 진전으로 세지 않는다.
- 원인 근거 없는 공백을 연결 장애로 보고하지 않는다.

## MCP-21 · 상태 관찰 시점과 제한된 진단

- 우선순위: P1. 영역: 관측·성능·보관. 분류: 현재 코드의 계약 공백. 규모: M.
- 문제: workspace 관찰은 update lock 전에 일어난다. 저장 revision과 관찰 시점이 어긋날 수 있다. Git 관찰 실패의 이유도 제한적이다.
- 변경: 관찰의 snapshot revision/시각/완전성을 표시한다. commit 전에 관련 변경 여부를 재검사한다. protected diagnostics에 이유 코드만 제공한다.
- 선행 항목: MCP-08, MCP-16.
- 근거: E06, E14, E17. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/continuity/workspace-snapshot.ts`, `src/continuity/workspace-identity.ts`, `src/continuity/task-service.ts`, `src/http-server.ts`, `test/continuity.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- 관찰 중 외부 변경이 있으면 stable로 단정하지 않는다.
- Git timeout·권한 오류·비 Git 저장소를 구분한다.
- bounded timeout과 검사 예산을 지킨다.
- public health에 workspace 정보와 자격 증명을 노출하지 않는다.

## MCP-22 · 실행 환경·경로 진단

- 우선순위: P1. 영역: ChatGPT·환경·배포. 분류: 예방·효율 개선. 규모: S.
- 문제: Windows 경로와 Linux 실행 경로, shell과 Node 환경 차이를 클라이언트가 추정할 수 있다.
- 변경: OS, canonical executionRoot, 지원 shell, Node 버전, 안전한 기능 플래그를 제공한다. alias 충돌과 잘못된 경로를 실행 전에 안내한다.
- 선행 항목: 없음.
- 근거: E17, E01. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/paths.ts`, `src/config.ts`, `src/continuity/workspace-identity.ts`, `src/exec-tools.ts`, `test/config.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- Windows cwd를 Linux 실행 경로로 임의 추정하지 않는다.
- alias가 같은 workspace를 가리키는 경우 taskId 선택이 일관된다.
- NODE_ENV와 의존성 설치 원인을 secret 없는 진단 코드로 표현한다.
- 전체 환경 변수와 임의 경로 목록을 출력하지 않는다.

## MCP-23 · ChatGPT Refresh의 완료 판정

- 우선순위: P1. 영역: ChatGPT·환경·배포. 분류: 예방·효율 개선. 규모: S.
- 문제: 서버 tools/list와 verifier만으로 ChatGPT의 실제 도구 갱신을 확인할 수 없다.
- 변경: 서버 catalog 검사, 플러그인 metadata 검사, 새 대화의 영향 도구 호출을 서로 다른 수용 기준으로 둔다.
- 선행 항목: MCP-06.
- 근거: E19. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `scripts/verify-live.mjs`, `test/tool-metadata.test.ts`, `docs/deployment-2026-09-08.md`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- 서버 검사만 통과한 상태는 client_verified가 아니다.
- 직접 연결한 custom MCP에서 Refresh 뒤 metadata 변경을 확인한다.
- 새 대화의 기능 호출과 기존 대화의 도구 사용 가능 여부를 각각 기록한다.
- 게시 플러그인과 custom MCP의 배포 절차를 구분한다.

## MCP-24 · 짧은 ChatGPT 작업 절차와 오류별 다음 행동

- 우선순위: P1. 영역: ChatGPT·환경·배포. 분류: 예방·효율 개선. 규모: M.
- 문제: 이전 작업에서는 continuity 호출이 없었다. 긴 지침만으로 단계 저장과 안전한 재개를 보장하기 어렵다.
- 변경: 기존 템플릿을 context→단계→변경→receipt→필요 시 checkpoint 흐름으로 줄인다. plugin skill 포장은 적용 가능성 확인 후 선택한다.
- 선행 항목: MCP-03, MCP-05, MCP-07, MCP-17, MCP-18, MCP-23.
- 근거: E18, E01, E12. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `templates/chatgpt-project-instructions.md`, `templates/AGENTS.md`, `src/continuity/context-summary.ts`, `test/recovery.integration.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- 재개 시 기존 taskId와 단계부터 확인한다.
- 이미 완료한 변경·검증을 근거 없이 반복하지 않는다.
- unknown mutation, revision conflict, tracking_required 각각 다른 다음 행동을 반환한다.
- 프로젝트 계약·Kernel 작업 단위를 새로 발급하거나 완료 권한을 대신하지 않는다.

## MCP-25 · 실제 작업 흐름의 성능 기준

- 우선순위: P1. 영역: 관측·성능·보관. 분류: 예방·효율 개선. 규모: M.
- 문제: 서버 응답 p95가 낮아도 전체 작업은 길었다. HTTP 미세 벤치마크만으로 해결을 판정할 수 없다.
- 변경: 고정 fixture에서 탐색·10개 편집·검증·중단 복구의 before/after를 측정한다. 동일 acceptance를 유지한다.
- 선행 항목: MCP-13, MCP-14, MCP-17, MCP-20.
- 근거: E01. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `scripts/benchmark.mjs`, `scripts/benchmark-http.mjs`, `test/performance.test.ts`, `test/recovery.integration.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- calls, serialized bytes, read amplification, tool latency, 완료 단계 수를 함께 기록한다.
- 동일 deterministic fixture에서 바이트 50%와 조회·편집 호출 30% 감소를 제안 목표로 검증한다.
- 모델 reasoning 시간을 서버 개선 효과로 과장하지 않는다.
- 1회 모델 실험 결과를 안정된 p95 또는 일반 성능 보장으로 제시하지 않는다.

## MCP-26 · 배포·상태 마이그레이션·설치 버전 일치

- 우선순위: P1. 영역: ChatGPT·환경·배포. 분류: 예방·효율 개선. 규모: M.
- 문제: active-process 배포 guard는 이미 있다. 상태 스키마 변경은 기존 배포 경로보다 더 많은 호환 검증이 필요하다.
- 변경: source/image/runtime/catalog/state schema 일치를 묶은 배포 결과를 만든다. 백업·isolated canary·rollback 조건을 배포 runbook에 추가한다.
- 선행 항목: MCP-08, MCP-23, MCP-32.
- 근거: E16. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `scripts/start.ps1`, `scripts/verify-docker.mjs`, `scripts/verify-live.mjs`, `scripts/build-id.mjs`, `docs/deployment-2026-09-08.md`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- 활성 프로세스가 있으면 기존 guard를 유지한다.
- canary에서 이전 상태 fixture를 변환하고 복구 조회를 통과한다.
- 코드·이미지·실행 buildId와 catalogDigest를 비교한다.
- 상태 호환성을 확인하지 않은 강제 재기동·다운그레이드를 하지 않는다.

## MCP-27 · 명시적인 상태 보관·내보내기·정리

- 우선순위: P2. 영역: 관측·성능·보관. 분류: 예방·효율 개선. 규모: M.
- 문제: 저장 예산 초과는 fail-closed다. 장기 운영의 기록 보관과 복원 절차가 부족하다.
- 변경: 종료 task의 metadata archive, dry-run 보관 정책, 복원 검증을 제공한다. 미해결 기록은 보호한다.
- 선행 항목: MCP-16.
- 근거: E07. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/continuity/task-store.ts`, `src/config.ts`, `scripts/status.ps1`, `test/recovery.integration.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- active/unknown/prepared/running을 자동 삭제하지 않는다.
- 삭제 예정 ID·바이트·보존 기간만 dry-run으로 표시한다.
- archive 복원 후 중복 방지와 receipt 조회를 유지한다.
- stdout·대화·secret을 archive에 추가하지 않는다.

## MCP-28 · 다중 사용자와 이벤트 구독의 소유자 범위

- 우선순위: P2. 영역: ChatGPT·환경·배포. 분류: 지원 조건 확인 후 진행. 규모: M.
- 문제: 현재 운영은 개인 서버다. 이벤트 또는 여러 계정을 지원할 때 task·subscription 소유자 검증이 필요하다.
- 변경: 인증 principal과 task/workspace/subscription 소유 범위를 설계한다. 단일 사용자 배포는 기존 범위를 유지한다.
- 선행 항목: MCP-08.
- 근거: E20. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/auth.ts`, `src/oauth.ts`, `src/continuity/task-store.ts`, `test/auth-security.integration.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- 다른 principal의 task/operation/subscription 조회와 변경을 거부한다.
- UA나 입력 ownerId를 인증 근거로 사용하지 않는다.
- 기존 단일 사용자 상태의 소유권 전환을 명시한다.
- 로그와 응답에 bearer·OAuth 상태 본문을 넣지 않는다.

## MCP-29 · MCP 2.0·Events 지원 가능성 검증

- 우선순위: P2. 영역: 조건부 이벤트. 분류: 지원 조건 확인 후 진행. 규모: M.
- 문제: 공식 Events는 Work/Cloud 등 지정된 surface와 protocol 2026-07-28이 필요하다. 현재 SDK의 해당 경로 지원을 확인하지 않았다.
- 변경: 먼저 isolated spike에서 SDK/transport 지원과 account surface를 검증한다. 기존 tools 경로의 호환성을 비교한다.
- 선행 항목: MCP-06, MCP-23.
- 근거: E20. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `package.json`, `src/mcp-server.ts`, `src/http-server.ts`, `test/mcp.integration.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- server/discover와 events/list 호환 여부를 재현한다.
- 기존 도구 프로토콜과 인증·도구 호출 회귀를 확인한다.
- 지원하지 않는 SDK에서 capabilities만 허위 광고하지 않는다.
- 기존 일반 대화의 끊긴 stream 복구 기능으로 보고하지 않는다.

## MCP-30 · 작업 상태 이벤트 구독

- 우선순위: P2. 영역: 조건부 이벤트. 분류: 지원 조건 확인 후 진행. 규모: L.
- 문제: 프로세스 종료와 작업 상태 변경을 사용자 승인 구독으로 전달하면 반복 브라우저 점검을 줄일 수 있다.
- 변경: process.finished, work.checkpoint_updated, work.blocked 등 최소 이벤트를 정의한다. 구독·필터·만료·해지를 저장한다.
- 선행 항목: MCP-28, MCP-29.
- 근거: E20. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/http-server.ts`, `src/continuity/task-service.ts`, `src/telemetry.ts`, `test/recovery.integration.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- 같은 구독 요청은 중복 구독을 만들지 않는다.
- 필터에 맞는 metadata만 전달한다.
- 재시작 뒤 구독이 유지되고 만료·권한 철회·unsubscribe 뒤 전달이 멈춘다.
- 사용자 중지·승인 대기 상태를 실행 지시로 바꾸지 않는다.

## MCP-31 · 서명 webhook·outbox·중복 이벤트 처리

- 우선순위: P2. 영역: 조건부 이벤트. 분류: 지원 조건 확인 후 진행. 규모: L.
- 문제: Events를 적용하려면 안전한 callback 검증과 재전송 정책이 필요하다.
- 변경: durable outbox, eventId, 서명, callback 검증, 제한된 재시도와 전달 상태를 구현한다.
- 선행 항목: MCP-30, MCP-07, MCP-11, MCP-19.
- 근거: E20. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `src/http-server.ts`, `src/config.ts`, `test/auth-security.integration.test.ts`, `test/recovery.integration.test.ts`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- callback은 HTTPS·공개 주소만 허용하고 연결 시 주소를 재검사한다. redirect를 따라가지 않는다.
- 서명 secret을 전용 제한 저장소에 보관하고 로그·응답·package에서 제외한다.
- 재시도는 동일 eventId와 새 서명을 사용한다. 429의 Retry-After를 지킨다. 410/413을 재시도하지 않는다.
- 2xx 수신과 GPT 작업 진행을 별도로 확인한다. 중복·순서 역전·feedback loop를 검증한다.
- Work 대화에서 구독→수신→정지의 실제 acceptance가 통과해야 기능을 활성화한다.

## MCP-32 · 중단·충돌·저장 실패의 재현 수용 시험

- 우선순위: P1. 영역: 장애 수용 시험. 분류: 예방·효율 개선. 규모: L.
- 문제: 기존 복구 테스트는 있다. 새 상태·편집·budget 경계까지 전체 흐름을 검증해야 한다.
- 변경: 독립 fixture와 장애 주입으로 response 유실, crash, CAS 충돌, 일부 저장 실패, stale 근거와 사용자 대기를 검증한다.
- 선행 항목: MCP-03, MCP-04, MCP-07, MCP-09, MCP-11, MCP-13, MCP-15, MCP-18.
- 근거: E21. [근거 목록](BASELINE.md#근거-목록).
- 예상 변경 파일: `test/recovery.integration.test.ts`, `test/continuity.test.ts`, `test/file-service.test.ts`, `test/performance.test.ts`, `scripts/verify-docker.mjs`. 이 목록은 범위의 시작점이다. 새 파일이 필요하면 해당 항목에 먼저 기록한다.

수용 기준:

- 예약 전·실행 중·효과 반영 뒤 응답 전·commit 중 장애를 각각 재현한다.
- 두 클라이언트와 외부 파일 수정에서도 duplicate effect를 만들지 않는다.
- unknown 상태는 재시도 허가로 바뀌지 않는다.
- 실제 사용자 workspace·계약·프로세스 없이 isolated fixture에서 실행한다.

## 범위 밖의 문제와 조건

- 큰 아키텍처 전환의 실제 구현·타입 오류·의존 경계 수정은 consumer 프로젝트의 작업이다. MCP만으로 해당 코드를 고칠 수는 없다.
- ChatGPT의 모델 추론 시간, 계정 rate limit, 연결 해제의 최초 원인은 서버 내부 시간과 분리한다.
- 토큰 한도·큰 timeout으로 전체 지연을 덮는 변경은 계획하지 않는다.
- 서버 재시작으로 GPT stale generation이 해제됐다고 판정하지 않는다.
- 과거 추적되지 않은 실행에 검증 receipt를 소급 생성하지 않는다.
- 브라우저 stop/resume API 자동 호출과 반복 메시지 전송은 이 패키지의 실행 방식이 아니다.
