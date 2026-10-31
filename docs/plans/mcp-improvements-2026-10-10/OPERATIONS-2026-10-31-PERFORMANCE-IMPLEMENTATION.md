# Moonremote Continuity 성능 개선 — 구현·격리 검증 기록

검증일: 2026-10-31 KST
기준 HEAD: `0fbc17b` (수정 전 원본)
현재 작업트리 source build ID: `src-68279e84cae185e799fc`
범위: 작업 일반 실행·복구 경로. 특정 프로젝트·Harness·OS 전용 분기 없음.

## 1. 원인과 안전 경계

운영 중 실행 기록이 약 5,100개까지 쌓였으며, 동일 작업공간에 약 1,000개 또는
2,900개의 Receipt가 누적된 경우 요청당 파일 조회가 각각 약 2,200회,
8,900회까지 커졌다. `writeExecution`, `writeWorkspace`, `commitWorkspace`의
`#executionRecords()` 전체 파일 읽기와 `syncFileAndParents()` 반복 호출이
정상 경로에서 작업공간 이력 크기에 따라 증폭되었다.

기존 `OPERATIONS-STORAGE-CONTRACT.md`의 D-OPS02-01을 유지한다.
원본 state/receipt/journal과 단일 writer guard가 권위이며, 인덱스는 메모리
힌트일 뿐이다. 부팅·복구·명시적 integrity scan에서는 전체 원본을 검증한다.
hot path는 변경 기록 및 소유·참조 계약을 검증한다. 별도 DB, 파일 감시,
영속 인덱스, 프로젝트 전용 임계값은 추가하지 않는다.

## 2. 구현

| 단계 | 구현 내용 | 상태 |
| --- | --- | --- |
| W0 | 기존 계측 활용, `storageLockWaitMs` 고정 숫자 추가 | 구현 완료 |
| W1 | 전체 Receipt 재읽기를 기존 `WorkspaceExecutionIndex` 기반 소유 관계 검증으로 전환. 변경 대상 schema·참조 검증 및 동일 ID의 task owner 불변성 검사 | 구현 완료 |
| W2 | 성공적으로 sync한 파일의 내구성 증명을 프로세스 메모리에서 재사용. 파일 변경 시도·복구·인덱스 무효화 후 재검증 | 구현 완료 |
| W3 | 잠금 대기 계측 후 실제 경합 판단. 격리 p50 약 0.04ms로 잠금 구조 변경은 보류 | 의도적 보류 |
| W4 | Git HEAD·branch·status를 동일 deadline 아래 병렬 조회. 전·후 두 snapshot 비교 유지 | 구현 완료 |
| W4 | `read_process`의 빈 폴링 정책 조정 | 배포 후 클라이언트 관측 필요 |
| W5 | 격리 Linux typecheck/build/전체 자동 테스트/코드 비교 | 완료 |
| W5 | Windows Host, 배포·실클라이언트, 24시간 운영 관측 | 미완료 |

### 변경 파일

- `src/continuity/task-store.ts`
- `src/continuity/metrics.ts`
- `src/continuity/workspace-snapshot.ts`
- `test/operations-performance.test.ts` (신규)
- `test/continuity-metrics.test.ts`
- `test/operations-deadline.test.ts`

동기화 경로에서 성공 증명은 파일 경로 단위로 유지한다. 파일 쓰기가 실패하면
이전에 성공한 증명도 무효화한다. journal 복구가 필요할 때는 증명을 모두
무효화한다. 외부의 임의 파일 변경은 지원 writer 경계 밖이며, 기존과 같이
선택 기록 조회, 명시적 scan, 재시작에서 검출한다.

## 3. 동일 환경 기준선 비교

수정 전 HEAD 코드와 개선본을 각자 격리 빌드하고, 동일 Linux ext4에서
동일한 형식의 Receipt 10/1,000/3,000개를 초기 상태로 구성했다.
매 조건에서 새 `executionRecorder.prepare()`와
`markSpawnFailed()` 각각 5회 측정한 단계별 중앙값이다.

| 기존 Receipt 수 | prepare 수정 전 | prepare 수정 후 | terminal 수정 전 | terminal 수정 후 |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 28.2ms | 18.9ms | 27.1ms | 13.4ms |
| 1,000 | 606.6ms | 16.8ms | 595.7ms | 10.2ms |
| 3,000 | 1,682.5ms | 18.3ms | 1,693.4ms | 10.7ms |

3,000건에서 `receiptReads` 중앙값은 상태 변경 묶음당 6,007회 → 2회,
`syncCalls`는 19회 → 10회였다. `prepare` 단계만 비교하면 92배,
종료 기록 저장 단계는 약 158배 개선됐다.

측정 대상은 명령 실행 **준비·기록 저장 구간**이다.
사용자 체감 ChatGPT 턴/네트워크/실제 자식 프로세스/테스트 실행시간의
개선 배수를 뜻하지 않는다. 각 5회이므로 운영 p95 판정으로 사용하지 않는다.

### Git 관측 (Windows 공유 9p 경로)

같은 실제 소스 경로에서 `observeWorkspace`를 각 4회 실행했다.

- 수정 전: 723~748ms
- 수정 후: 606~620ms
- 모든 결과 `completeness=complete`, fingerprint 대상 6개

부하와 파일 변경 규모가 다른 운영 요청에서는 별도 재측정이 필요하다.

## 4. 회귀·안전 검증

격리 Linux 디렉터리에서 `npm ci --include=dev`, `npm run typecheck`,
`npm run build`, `vitest run`을 실행했다. **36개 테스트 파일,
206 passed / 2 Windows-only skipped / 0 failed**.

신규 회귀 테스트는 Receipt 이력 180개 이후에도 hot-path 파일 읽기
횟수가 제한되는지, 성공한 fsync가 중복되지 않는지, 명시적 인덱스
무효화 후 전체 원본을 다시 읽는지 확인한다.

기존 fsync 오류 및 deadline 장애 주입 테스트는 내구성 확인을 명시적으로
무효화한 뒤 동일한 실패 상황을 재현하도록 갱신했다.
`continuity-storage`, `operations-storage`, `operations-deadline`,
`operations-observation` 등 전체 회귀가 통과했다.

### 배포 및 종료 전 필수 게이트

1. 실제 Windows Host 전용 2개 테스트와 설치 Harness 호환성을 검사한다.
2. Kernel 공식 review/승인 및 Git 종료 규약을 만족한 뒤 한국어 상세
   메시지로 커밋·푸시한다. 임의 승인 영수증·우회 Git 작업은 하지 않는다.
3. 관리되는 재기동 전 실행 중 프로세스와 사용자 작업을 확인하고,
   이미지·소스 `buildId`를 일치시킨다.
4. `post-deploy:verify`와 실제 ChatGPT 원격 명령·exact-once·중단 복구를 검증한다.
5. 배포 후 같은 빌드의 최소 24시간 로그에서 Receipt 읽기,
   `storageLockWaitMs`, `read_process` 빈 조회와 오류율을 재측정한다.
6. 같은 작업·동일 결과를 기준으로 로컬 Codex 대비 전체 소요시간을 측정한다.
   장시간 조회의 대기시간과 실제 작업시간은 분리한다.

현재까지 **코드 구현 및 격리 검증만 완료**했다.
운영 이미지 재빌드·Docker 재기동·Git 커밋·푸시는 수행하지 않았다.

## 5. 추가 확인: 저빈도 reconciliation 트랜잭션

3,000개 Receipt를 가진 동일 fixture에서 `commitWorkspace()` 단일 트랜잭션도
실측했다. 수정 전 약 2,159ms, 개선 후 약 491ms(각 한 번 측정),
`receiptReads` 3,005회 → 0회였다.

남은 약 0.5초에는 `#measureBytes()`의 전체 저장 용량 재확인이
포함될 수 있다. 이 경로는 일반 `exec_command` 실행/종료가 아니라
checkpoint와 복수 reconciliation의 journal commit에서 사용된다.
저장 용량 상한의 안전한 전역 정산 계약을 교체해야 하므로 이번 변경에서는
제거하지 않았다. 실제 운영에서 충분한 빈도와 잠금 경합이 확인되면
그때 별도 개선한다. 서로 다른 실행으로 1회 측정한 값은 p50으로 표기하지 않는다.
