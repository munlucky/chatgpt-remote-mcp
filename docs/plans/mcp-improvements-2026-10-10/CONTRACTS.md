# 구현 전에 고정할 공통 계약

이 문서는 제안 계약이다. 현재 서버가 아래 신규 필드를 지원한다고 주장하지 않는다. 기존 v1 호출과 상태는 마이그레이션 및 기능 정책으로 보호한다.

## 1. 상태와 권한

기존 taskId, workspaceId, operationId, requestId, revision CAS를 유지한다. 프로젝트 계약 ID와 Kernel work unit을 새로 발급하지 않는다.

다음 필드를 추가하는 설계를 기준으로 한다:

| 필드 | 의미 |
| --- | --- |
| schemaVersion | durable storage 형식. wire catalog 버전과 별개다. |
| stageId / cursor | caller가 선언한 단계 ID와 현재 위치. 자연어 phase와 구분한다. |
| stageState | pending, running, blocked, verified, skipped. skipped에는 이유가 필요하다. |
| workflowStatus | executing, waiting_user, waiting_approval, waiting_service, blocked, ready_to_close. |
| nextAction | inspect, execute, verify, checkpoint, wait, close 중 하나. 명령 본문은 저장하지 않는다. |
| completionAuthority | MCP lifecycle 또는 외부 project authority. Kernel을 대체하지 않는다. |
| evidenceState | verified, stale, missing, unchecked. 기존 evidence=present와 구분한다. |

단계 상태와 nextAction은 권한 부여가 아니다. 필요 근거와 사용자 대기를 함께 반환한다. nextAction=execute가 unknown 실행을 재시도하게 만들면 안 된다.

verified 단계에서 이전 cursor로 돌아가는 경우는 기본 거부한다. 명시적 replan은 이전 상태, 사유, 영향을 받는 단계와 검증 무효화를 기록한다. 계약 자체를 재발급하지 않는다.

migration은 기존 completed 문장을 caller_claim으로 보존한다. verified 단계나 성공 근거를 만들어 내지 않는다. 기존 종료 작업을 임의로 다시 열지 않는다. compatibility 상태를 별도 표시한다.

## 2. 단계·실행·검증 연결

실행 예약은 taskId, operationId, taskRevision, stageId, toolKind, inputHmac를 연결한다. 대상 scope와 source digest는 예산 안에서 보존한다. 서명과 입력 HMAC 키는 공개하지 않는다.

검증 기록은 다음 항목을 갖는다:

- 실행 receipt ID와 검증 대상 stageId.
- 검증기 ID 또는 검사 종류. 원시 shell command는 아니다.
- exit 상태, timeout, 성공 판정 규칙과 구조화 요약.
- 검사한 파일·artifact 범위와 digest.
- 관찰 시각, completeness, producer와 유효성 상태.

exit 0은 acceptance 전체 충족과 다르다. 검증기가 보고한 검사 범위와 필수 acceptance를 매핑해야 한다. 검색처럼 exit 1이 정상 결과일 수 있는 도구는 tool outcome과 verification outcome을 별도로 정의한다.

검증기의 정의 digest와 결과 출처를 확인한다. 서버가 등록·실행한 검증기 또는 기존 외부 authority가 발급한 검증 근거를 사용한다. caller가 임의 명령에 test_passed 이름을 붙인 것은 성공 근거가 아니다. 정산 근거에도 같은 규칙을 적용한다.

전역 workspace fingerprint만으로 모든 근거를 무효화하지 않는다. 관련 파일 또는 정의된 의존 scope가 바뀌면 stale이다. scope가 불완전하면 unchecked다. missing/unchecked/stale을 verified로 바꾸지 않는다.

최대 근거 수를 넘는 입력은 명확히 거부한다. 허용한 모든 근거는 검사하거나 페이지 기반 검증 상태로 표시한다. 일부만 확인한 응답은 전체 통과가 아니다.

## 3. 변경 예약과 불확실한 결과

변경 공통 흐름은 reserve → effect → durable result → response다. exec/run에 있는 흐름을 파일 편집과 stdin으로 확장한다.

같은 operation/request ID와 동일 입력은 기존 결과를 반환한다. 다른 입력은 충돌이다. dedupe 조회를 위해 사용자 입력 본문을 저장하지 않는다.

효과가 반영됐는지 확인할 수 없으면 unknown으로 남긴다. unknown에 대한 timeout이나 연결 오류는 재실행 허가가 아니다. 현재 파일 digest, 프로세스, 외부 효과를 확인하는 read-only 경로를 먼저 제공한다.

단일 파일의 atomic rename과 여러 상태 레코드의 journal commit을 구분한다. 여러 파일·외부 명령을 하나의 원자 transaction으로 보장하지 않는다. 외부 프로세스의 파일 수정까지 서버 lock이 통제한다고 표시하지 않는다.

journal에는 변경 metadata와 복구에 필요한 제한 정보만 넣는다. 저장 실패 뒤 receipt와 checkpoint가 서로 모순되지 않도록 commit marker로 복구한다. 복구는 효과를 다시 실행하지 않는다.

## 4. 응답 예산과 조회

초기 기본값 제안:

| 응답 | 제안 기본값 | 예외 |
| --- | ---: | --- |
| 일반 tool result 전체 | 64 KiB | text, structuredContent, metadata의 직렬화 바이트 합계다. |
| process 출력 page | 16 KiB | 기존 compact 흐름을 유지한다. |
| 일반 read_file page | 16 KiB | 명시적 요청은 설정된 전송 상한 안에서 허용한다. |
| read_files 전체 | 일반 result 예산 이내 | 파일별 상한 외에 전체 상한을 적용한다. |
| context | 작은 summary + section page | full이라는 이름으로 무제한 응답을 허용하지 않는다. |

위 숫자는 구현 전 fixture 측정으로 조정할 수 있다. 최종 값과 호환 영향은 config와 문서에 기록한다. UTF-8 경계, JSON escape, base64 expansion과 text 중복을 실제 직렬화 결과에서 계산한다.

생략된 항목은 omittedCounts와 cursor/nextOffset으로 조회할 수 있어야 한다. unresolved 전체 수, task revision, workflowStatus와 안전한 다음 조회는 작은 응답에 남긴다. context page 조회 중 revision이 바뀌면 snapshot 경계 또는 page_conflict를 표시한다.

추가 도구는 기존 도구의 확장으로 해결할 수 없는 경우에만 만든다. catalog 크기와 schema 노출 비용도 성능 기준에 넣는다.

## 5. 완료와 대기

strict completion은 필수 단계, 유효한 근거, unresolved execution, 남은 작업과 blocker를 확인한다. failure receipt와 caller summary를 성공 근거로 쓰지 않는다.

MCP completed는 이 서버의 작업 기록 종료다. Kernel 프로젝트 완료는 Kernel의 기존 완료 권한으로 판정한다. 외부 권한의 receipt를 조작하거나 대체하지 않는다.

abandoned는 명시적인 중지 기록이다. 살아 있는 프로세스를 자동 종료하지 않는다. active pointer와 살아 있는 실행의 관계는 acceptance에서 별도로 고정한다. 사용자 중지가 프로세스 termination 권한을 뜻한다고 추정하지 않는다.

waiting_user와 waiting_approval은 자동 실행을 막는다. waiting_service는 이유와 retryAfterAt을 보존한다. 사용자가 멈춘 작업은 이벤트, idle count 또는 monitor 시간만으로 다시 시작하지 않는다.

## 6. rollout과 legacy 호출

필드 추가만으로 구형 도구 캐시가 갱신됐다고 보지 않는다. 서버 진단에 기능 버전과 catalogDigest를 제공한다. 기존 client가 호출할 수 있는 경로로 refresh 필요를 안내한다.

정책은 observe → enforce 순서로 활성화한다. observe는 누락을 표시하지만 legacy 실행을 임의로 verified로 바꾸지 않는다. enforce는 ID·단계·근거의 필수 조건을 spawn 또는 effect 전에 확인한다.

현재 required exec tracking을 임의로 낮추지 않는다. 새 정책 활성화는 해당 client acceptance 통과 후 진행한다. 작업별·배포별 설정과 rollback 조건을 구분한다.

## 7. Events의 적용 경계

Events는 MCP-29 spike 통과 후 MCP-30~31에서 적용한다. 사용자 승인 구독과 최소 metadata를 사용한다. 전달 성공과 모델의 실제 작업 진행은 다른 상태다.

process.finished는 프로세스 종료 이벤트다. 작업 또는 프로젝트 완료 이벤트와 같지 않다. work.blocked는 원인 metadata다. 사용자 승인 대기를 bypass하는 실행 지시를 넣지 않는다.

구독 signing secret은 별도 제한 저장소에 필요하다. telemetry, 진단 문서, snapshot export, package payload에 복사하지 않는다. callback 보안과 outbox의 실제 통과 기준은 MCP-31을 따른다.
