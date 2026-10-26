# 운영 개선 구현 및 검증 기록

기준일: 2026-10-26 KST. 기준 HEAD: `2914d3d68631f788486699c1572047981a5391bf`.

사용자는 현재 HEAD와 기존 계획 문서 변경을 새 기준으로 인정했다. 실행 Run은 `run-2858c3fa-0113-4996-900b-538ee820786c`다. 이전 완료 Run의 상태는 수정하지 않았다. 이 문서는 제품 증거 기록이다. 최종 완료 권한은 해당 Run의 Kernel continuation `action.type=done`에 있다.

## 범위와 결과

[확정 계획](OPERATIONS-2026-10-25-FINAL-PLAN.md)의 W0~W5를 구현하고 격리 검증했다. W6 운영 배포, 운영 재시작, 운영 데이터 변경, 24시간 관측, 실제 rollback, 커밋·푸시는 수행하지 않았다. AC16-CANDIDATE는 운영 배포 증거를 대신하지 않는다.

| Wave | 결과 | 변경 및 증거 |
| --- | --- | --- |
| W0 | pass | 고정 계측, Linux baseline, 동일 fixture 비교, 안전한 오류 분포 |
| W1 | pass | 전체 read 응답 deadline, HTTP 취소, Git/파일 관측 deadline, Compose 설정 |
| W2 | pass | [저장 계약과 mutation matrix](OPERATIONS-STORAGE-CONTRACT.md), 명시적 integrityScan |
| W3 | pass | workspace 메모리 index, 선택 원본 검증, task 조회와 미정산 cursor |
| W4 | pass | stateless drainOnly, 원래 polling 정책 보존, 만료 receipt 복구, 안전한 보고서 |
| W5 | pass | 전체 회귀, 설치 Harness 실제 done, 후보 parity, AC18 호환 시험 |
| W6 | not_verified | AC16-DEPLOYED와 AC17. 별도 운영 실행과 실제 증거 필요 |

최종 source/image build ID는 `src-4dae6963da9b148b3a50`이다. 기준 HEAD의 build ID는 `src-6e8202a04fd70cdef8fc`다. 모든 원시 시험 상태와 로그는 저장소 밖 `%TEMP%/mcp-operations-20261026-evidence`에 둔다.

## 구현 경계

receipt schema-v2와 `persistenceState=ok|degraded`를 유지한다. `persistenceVerification=not_required|verified|pending`은 응답 전용이다. 저장 확인 대기가 끝나도 receipt를 degraded/unknown으로 바꾸지 않는다.

read handler는 입력 검증 직후 monotonic 시작 시각을 잡는다.

```text
effectiveWaitMs = drainOnly ? 0 : min(requestedWaitMs, configuredReadCap)
deadline = responseStartedAt + effectiveWaitMs + 5,000ms
```

기본 read cap은 60,000ms다. 설정 범위는 1,000~300,000ms다. wire waitMs는 기존 0~300,000ms를 유지한다. HTTP abort는 waiter와 응답 대기만 취소한다. ProcessManager가 소유한 terminal 저장 Promise는 계속 진행한다. pending 응답 뒤 같은 ID로 verified 결과를 확인할 수 있다.

관측은 Git과 파일에 하나의 monotonic deadline을 사용한다. Git child는 kill 뒤 close까지 기다린다. 부분 관측은 partial로 표시한다. 전체 관측 시간과 budget 이후 cleanup은 요청 수치이며 저장 schema를 늘리지 않는다. 실제 OS의 lstat/readlink 등 취소 불가 I/O가 예산을 넘으면 cleanup 수치에 남을 수 있다. 주입한 지연 Git/파일 fixture는 2초 예산+500ms 이내에 반환했다.

실행 identity는 `(workspaceId, operationId)`다. TaskStore의 `Map<workspaceId, WorkspaceExecutionIndex>` 안에 operation locator와 task별 ID 집합을 둔다. 원본 receipt는 항상 다시 읽는다. 시작·복구·명시 scan·무효화 후 재구축에서는 전체 schema/owner를 검사한다. 정상 조회는 선택 receipt와 필요한 owner/evidence만 검사한다. 변경 성공 뒤 locator를 갱신하고 실패한 workspace만 무효화한다. 실패한 scan의 이전 index는 재사용하지 않는다. 영속 index/generation, 새 저장 엔진, 프로젝트·모델별 분기는 추가하지 않았다.

`nextCall`은 원래 waitMode/waitMs/maxOutputBytes를 보존한다. `drainOnly`는 해당 호출에만 effective wait=0을 적용한다. 출력 drain이 끝나면 원래 정책을 복원한다. 서버에 polling 세션 상태를 추가하지 않았다.

메모리 만료 뒤 optional taskId/operationId는 쌍으로 검증한다. workspace/task/operation/session/current boot가 일치하는 원본만 복구한다. terminal 결과와 `outputAvailability=unavailable`을 분리한다. 검증 전 correlation 승격, 자동 spawn, 원본 변경은 하지 않는다. 불확실 receipt는 pending/context 안내를 반환한다. 다른 boot는 기존 unknown 오류이며 과거 작업은 get_work_context로 조회한다.

계측은 기존 request AsyncLocalStorage에 고정 수치만 추가했다. task 탐색, receipt read, owner validation, durability sync, persistence, Git, evidence를 분리한다. 단계 시간은 중첩되므로 합산해 전체 elapsed로 해석하지 않는다. 오류 allowlist는 서버와 보고서가 같은 JSON을 사용한다. 보고서는 고정 enum·검증된 ID·수치만 읽는다. 구형 필드 누락은 unobserved다. persistenceVerification, receipt persistenceState, 응답 elapsed/deadline은 별도 축이다. receipt/state 재읽기 차이와 pending journal은 inconclusive다. 보고서는 복구나 원본 write를 실행하지 않는다.

## AC03 조회 확장성

동일 fixture digest는 `f55b41e548fa6233b7791fc4525121dec61734bb86ed466d4bbd3e525be685e4`다. target receipt 10개, 다른 task receipt 100/1,000/10,000개, summary/recent 10, 동시성 1, warm 20회다. Linux Node v22.23.4에서 측정했다. startup과 first는 warm p50/p95에서 제외했다. 이 합성 시험은 프로세스를 spawn하지 않으며 생성/반환/손실/abort는 0이다.

baseline은 W0 계측만 추가한 `src-6d99f6deca706b1aaa6d`다. 확정 HEAD와 polling 비교 기준은 따로 기록한다. Windows 예비 측정은 1,000개 구간에서 중단했으므로 통과 증거로 쓰지 않는다.

| 대상 | 다른 task receipt | startup ms | first ms | warm p50 ms | warm p95 ms | read/조회 | sync/조회 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 100 | 237.6 | 666.7 | 319.5 | 420.7 | 220 | 558 |
| baseline | 1000 | 1863.5 | 5675.1 | 2679.0 | 4033.2 | 2020 | 5058 |
| baseline | 10000 | 17757.0 | 25864.6 | 25644.8 | 29397.6 | 20020 | 50058 |
| candidate | 100 | 564.8 | 90.3 | 51.9 | 76.6 | 5 | 33 |
| candidate | 1000 | 4710.3 | 239.4 | 92.2 | 168.1 | 5 | 33 |
| candidate | 10000 | 22513.6 | 73.5 | 32.8 | 70.5 | 5 | 33 |

통과식: `70.5ms ≤ 2×76.6+100 = 253.2ms`. hot receipt read/sync는 전체 N에 비례하지 않았다. startup은 원본 전체 검증을 포함하므로 확장 비용이 남는다. startup 개선이나 실제 운영 latency 개선은 주장하지 않는다.

## AC07 A/B polling 비교

`continuation-benchmark.mjs`로 동일한 caller가 첫 read 이후 nextCall을 그대로 실행했다. 정책당 3회, 100ms 간격 8회×30,000 bytes, 반환 chunk 16,384 bytes, initial yield=0이다. fixture digest는 `4f96bc27e6748fe448b7f145fc645b742352a6ad1d90d218b0129b11317af89b`다. 같은 Linux Node v22.23.4에서 기준 HEAD와 최종 후보를 비교했다. p95는 표본 3개의 최댓값이다. 운영 통계로 일반화하지 않는다.

| 대상·정책 | 호출/0초 호출 | 첫 출력 p50/p95 ms | 종료 인지 p50/p95 ms | 응답 bytes p50/p95 |
| --- | --- | --- | --- | --- |
| baseline output 1초 | 18/8 | 145.4/191.5 | 846.4/907.5 | 500351/500351 |
| baseline terminal 30초 | 17/15 | 836.9/840.0 | 893.1/910.4 | 500101/500101 |
| candidate output 1초 | 18/8 | 131.6/175.1 | 844.3/882.2 | 505644/505646 |
| candidate terminal 30초 | 17/15 | 845.0/847.1 | 902.0/905.2 | 505149/505150 |

A 구현 비교에서 같은 output 정책의 호출 수와 0초 호출 수는 줄지 않았다. 이 fixture에서 구현에 따른 호출 감소 또는 latency 개선은 확인하지 못했다. 후보의 응답 metadata 때문에 response bytes도 증가했다. 별도의 UTF-8 fixture에서 drain 이후 계속 실행 중일 때 원래 terminal 30초 정책이 복원되는 것을 확인했다.

B 정책 비교에서는 같은 후보의 output 1초에서 terminal 30초로 바꾸면 호출이 18→17로 줄었다. 첫 출력은 늦어졌다. 이 결과는 caller 정책 차이이며 구현 효과로 합치지 않는다. 모든 sample에서 생성=반환=240,000 bytes, 손실=0, abort=0, spawn=1이다. 원시 결과와 파생 p50/p95는 같은 필드 형식으로 보관한다.

## 후보·회귀·rollback 증거

최종 `npm run integration:docker`에서 typecheck, build, nginx 설정, 전체 31개 파일/171개 시험, `npm audit --omit=dev`, HTTP benchmark가 통과했다. HTTP benchmark는 warmup 20 뒤 100개 표본을 수집했다. duration p50/p95는 1.2/2.7ms, setup p50/p95는 0.4/0.7ms다. `check-public-config` 139개 파일과 `git diff --check`도 통과했다.

격리 .env를 Compose에 입력해 yield=3,000/read cap=30,000을 확인했다. 같은 이미지의 diagnostics와 실행이 일치했다. 기본 yield 실측은 3,073ms, 실행별 yield=0 override는 81ms였다. catalog의 drainOnly/taskId/operationId, tracking_required의 spawn 전 거절, wire wait=300,000의 effective=30,000, wait=0 즉시 조회를 확인했다.

실제 설치된 Kernel의 공개 CLI로 격리 Harness 시험을 실행했다. 공식 환경 선택 `MOON_RELAY_TRACK=kernel`을 해당 subprocess에만 적용했다. 설치 runtime DB/receipt는 수정하지 않았다. Harness Run은 `run-31673089-adc0-43be-ab88-355381204fc1`이고 결과는 `status=passed, reportNextAction=done, sideEffectCount=1`이다. 이는 AC15 Harness 증거다. 주 실행 Run의 완료 판정과 구분한다.

AC18은 격리 상태에서 candidate→이전 이미지→candidate 순서로 시험했다. 이전 이미지는 `chatgpt-remote-mcp:local`, image ID `sha256:f966641ebafac7485f8cb6c26e5e1c994f6c90a6a903c2029db1b33ec2cee50e`, build `src-6e8202a04fd70cdef8fc`다. 후보가 생성한 원본 v2의 terminal receipt를 읽고 이전 boot 미정산을 unknown으로 보존했다. 이전 이미지에서 tracked 실행 부작용 1회와 명시적 reconcile을 수행했다. 후보가 다시 열어 그 결과·증거와 전체 무결성을 확인했다. 원본/미정산 삭제와 영속 index 생성은 없었다. 실제 운영 rollback은 수행하지 않았다.

## 검증 중 수정한 결함과 제약

- 초기 전체 시험에서 기존 execution-controls fixture가 100ms 안에 stdout이 온다고 가정해 실패했다. 실제 출력 준비를 기다린 뒤 terminal 대기를 시험하도록 수정했다.
- production audit에서 기존 의존성의 high 2/moderate 2가 검출됐다. 공식 Kernel scope revision으로 package.json/package-lock.json을 추가한 뒤 필요한 버전만 갱신했다. body-parser 2.4.0, fast-uri 3.1.9, ip-address 10.7.5, zod 4.6.6이다. major 업그레이드/force/override/보안 gate 우회는 없다. 최종 production audit는 0건이다.
- 기존 HTTP benchmark가 console 계측 기본 off 때문에 표본 0건을 성공으로 반환했다. 벤치마크에서만 console 수집을 켜고 정확히 100개 표본을 요구하도록 수정했다.
- 보고서가 처음 일치한 receipt를 재확인하지 않는 결함을 수정했다. receipt와 workspace state를 모두 재읽어 변경 중 관측을 inconclusive로 표시한다.
- 후보 이미지에는 build-id 계산에 필요한 전체 source fixture가 포함되지 않는다. 성능 측정은 checkout을 읽기 전용으로 mount한 뒤 격리 복사본에서 수행했다. dev compiler가 필요한 복사본 설치는 `npm ci --include=dev`로 명시했다. 운영 이미지 설정을 바꾸지 않았다.
- Docker의 기존 MCP_AUTH_TOKEN ENV 경고와 proxy header 거절 fixture의 의도된 validation 로그는 남는다. 실제 비밀 값은 출력하지 않았다.

## Acceptance 판정

Kernel 최종 수용 과정에서 report의 전체 누적 경로를 W5 delta로 잘못 제출해 scope 거절을 받았다. Kernel이 관측한 W5 실제 delta로 수정했고 build/test는 fresh passed가 됐다. 이후 단계에만 남은 required-verification ID가 현재 Run 의무 목록에서 사라져, 해당 ID를 명시해도 proof가 실행되지 않는 연결 불일치를 확인했다. 제품 시험 실패나 로컬 Docker 문제는 아니다. 공식 `next --contract-json`으로 같은 수용 기준과 범위의 남은 W5만 재계획했다. 첫 재계획은 같은 연결을 남겼다. 설치 공개 source를 읽어 `normalizeTaskContract`가 changedPaths를 저장하지 않고, requiredVerifications는 보존하는 것을 확인했다. 따라서 기존에 발급된 같은 검증 ID·허용 명령·scope를 계약의 requiredVerifications에 명시했다. 검증을 제거하거나 완화하지 않았다. 공식 next 결과에서 해당 hard 의무가 실행 목록으로 복원됐다. 완료한 W0~W4는 유지됐고 최종 단계는 `step-5-1`이다. 설치 runtime/DB/receipt는 직접 수정하지 않았다. 최종 완료는 이 단계 report의 canonical continuation으로 판정한다.

| AC | 결과 | 닫힌 증거 |
| --- | --- | --- |
| AC01 | pass | operations-deadline: cap, 5초 후처리, pending→verified, 원본 상태 유지, 실제 storage sync queue 지연 |
| AC02 | pass | HTTP abort/terminal 저장 경합, terminal write 1회, listener 제거, recovery.integration 응답 유실/부작용 1회 |
| AC03 | pass | 동일 digest 100/1,000/10,000 warm 20, 고정 read/sync, p95 식 충족, startup 별도 |
| AC04 | pass | 저장 기존 회귀와 operations-storage: previous boot/journal/restart/invalidation, 외부 손상 scan·재시작 거절 |
| AC05 | pass | mutation matrix, 같은 operation의 workspace 독립성, 선택 owner 거절, recent 밖 evidence, 24건 미정산 페이지 합계 |
| AC06 | pass | 느린 Git child kill/reap, unchanged/20MB/지연 read fixture의 2초 예산+500ms, partial 보존 |
| AC07 | pass | A/B 구분 비교, 동일 정책 호출 감소 없음 명시, drain 이후 원래 정책 복원 |
| AC08 | pass | UTF-8 120,000 bytes digest/cursor/다중 drain/손실 0, afterSeq=0 의도적 재읽기, 응답 유실 회귀 |
| AC09 | pass | 설정 기본/범위 거절, Compose→diagnostics→동작, yield override와 wire 0 |
| AC10 | pass | 완료 메모리 만료 뒤 verified/unavailable, 원본 bytes 불변, spawn 0 |
| AC11 | pass | 잘못된 task/operation·다른 boot·unknown·owner 거절, 검증 전 correlation 보호 |
| AC12 | pass | usage-report/usage-correlation: 오류 7/2/1 합계 10, 필터·legacy·오류 축 분리 |
| AC13 | pass | secret/임의 enum 제외, 원본 digest 불변, pending journal·동시 receipt/state 변경 inconclusive |
| AC14 | pass | fixture/build digest, 동일 raw format, p50/p95/read/sync/bytes/abort/spawn 및 startup 분리 |
| AC15 | pass | 전체 171개 회귀: schema-v2/OAuth/approval/complete/output/terminal/identity + 설치 Harness 실제 done |
| AC16-CANDIDATE | pass | 최종 source=image ID, 신규 catalog/옵션, tracking required, 실효 설정 동작 |
| AC16-DEPLOYED | not_verified | W6 운영 배포 미수행 |
| AC17 | not_verified | W6 운영 24시간 관측 미수행 |
| AC18 | pass | 최종 후보 상태를 이전 이미지에서 읽고 실행·복구한 뒤 후보에서 재검증 |

Kernel 내부 acceptance ID와 계획 AC 번호는 자동 생성 순서가 다르다. 예를 들어 내부 AC-16은 계획 AC18이다. 제출은 현재 work unit의 내부 ID 전체를 사용하며 제품 판정은 위 표의 계획 AC 번호로 읽는다.

## 재현 명령과 증거 위치

저장소 root에서 실행한다. Docker는 격리 상태와 후보 이미지에만 사용한다.

```powershell
npm run typecheck
npm run build
npm test
node scripts/check-public-config.mjs
npm run integration:docker
node scripts/operations-candidate-proof.mjs
node scripts/continuity-benchmark.mjs
node scripts/continuation-benchmark.mjs
```

Windows의 core 시험은 기존 test-core가 Linux 격리 실행을 수행한다. 벤치마크는 Linux 격리 복사본에서 Node와 같은 source build ID를 확인하고 실행한다. 기준 polling은 HEAD archive를 별도 build하고 새 runner의 source 인자로 지정한다.

rollback proof는 `scripts/operations-rollback-proof.mjs prepare|old|candidate /proof-state`를 각 이미지에서 실행한다. 세 단계는 같은 격리 상태 mount를 사용한다. entrypoint=node, working directory는 `/opt/chatgpt-remote-mcp`다. 이전 이미지에는 해당 proof 스크립트만 읽기 전용 mount한다.

Harness는 `scripts/harness-compatibility-smoke.mjs`에 설치 공개 launcher, 임시 projects directory를 지정한다. 결과가 blocked/skipped면 AC15 통과로 바꾸지 않는다.

| 증거 파일 | SHA-256 |
| --- | --- |
| `harness-smoke-final.json` | `c65f6e3b751d11588e2474463d45946b764a688a6a312186ef627c4ddcc8ceaa` |
| `integration-docker-release.log` | `958c6979363a559dfaae94f34390e79f30a4559b852a40261cb8b18e0055153c` |
| `release-candidate-proof.json` | `4dfb1e50b1447321bf918e8f36e4d280215bb26d44ac3be21642a7e43319b162` |
| `release-context-linux.json` | `551e318e3a27f1cd79ab379b5770b4ea6d594d6a192aac11e0c8e1c47f47bae0` |
| `release-poll-candidate.json` | `75ace322b7117937208101ca15c8c8131b517d6351a8d7fecf42b6678e9ee2bc` |
| `release-poll-summary.json` | `d392a81e997c00ce44cbb4ea89f2e4448707c8250e879fb498a46c824b24361b` |
| `release-rollback-candidate.json` | `cc579d315538c30d01298b502e449a3120aa6814a6a2e774720d045beb865e05` |
| `release-rollback-old.json` | `2e2cc67f400a95446cad70bb1e2b09073f55044c9eeaf3502fb45695002d3128` |
| `release-rollback-prepare.json` | `4fb335d659d2d673226d8097d20a783a784b5b47446d292024b99a0d39dd44bd` |
| `w0-baseline-context-linux.json` | `77301d61652c94e4a81722ddbcbed501bc5bff8bb3285797170068f49a8f9df9` |
| `w5-poll-baseline.json` | `546731603628d9ed913d8a1006c289df58e64feda7148281cc0adb25210fba78` |

원시 증거는 임시 보관 위치이므로 정리하면 사라질 수 있다. 이 문서는 fixture, 명령, digest와 결과를 남기지만 원시 로그를 canonical source에 복사하지 않는다.

