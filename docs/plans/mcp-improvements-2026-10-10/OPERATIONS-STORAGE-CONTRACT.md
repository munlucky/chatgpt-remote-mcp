# W2 저장 경계와 mutation matrix

원본 `state.json`, execution receipt, transaction journal이 권위다. 저장 schema-v2와 single writer guard를 유지한다. 논리 실행 identity는 `(workspaceId, operationId)`다. 인덱스는 W3에서 `Map<workspaceId, WorkspaceExecutionIndex>` 안의 `Map<operationId, ReceiptLocator>`로 만든다. 영속 index와 generation은 만들지 않는다.

| 원본 변경 경로 | 기존 저장 경계 | W3 캐시 처리 |
| --- | --- | --- |
| task create/update/complete, dedupe | writeWorkspace → atomicWrite | 성공 후 해당 workspace task/owner 자료 갱신, 실패 시 해당 workspace 무효화 |
| prepared | ExecutionRecorder.prepare → writeExecution | 성공 후 locator와 task별 분류 갱신 |
| running | markRunning → writeExecution | 같은 workspace/operation 갱신 |
| exited/spawn_failed | markTerminal/markSpawnFailed → writeExecution | terminal 분류 이동, 재실행 없음 |
| persistence degraded | markPersistenceDegraded → writeExecution | 원본 상태만 반영, 저장 실패면 캐시 무효화 |
| 단일 reconcile | reconcile → writeExecution | unknown resolution 반영 |
| 복수 reconcile + checkpoint/dedupe | withReconciliations → commitWorkspace → journal | commit 완료 뒤 해당 workspace 무효화·전체 재검증. 중간 실패는 recoveryRequired 유지 |
| journal 복구 | recoverTransactionsLocked | 복구 대상 workspace 무효화, 다음 사용 전 원본 전체 검증 |
| schema-v1 migration | initialize → migrateWorkspace | migration 완료·owner 검증 후 구축 |
| 이전 boot prepared/running | initialize → recoverPreviousBootExecutions | unknown 원본 write 후 구축 |
| offline rollback | restoreLegacyBackup → close | 전체 메모리 폐기, 새 시작에서 전체 검증 |
| atomic rename/file sync/directory sync 실패 | atomicWrite 예외 | 성공으로 승격하지 않음. 해당 workspace 캐시 무효화 |

동일 operationId를 다른 workspace에서 사용할 수 있다. 조회·갱신·무효화·execution lock도 workspace 범위를 지킨다. 원본 write와 캐시 publish/invalidate는 기존 storage lock 안에서 수행한다. 실행 중 수동 외부 편집은 지원 writer가 아니다. 무관 receipt의 외부 변경을 매 hot read에서 즉시 검출한다고 보장하지 않는다.

전체 owner/schema 검증은 시작, journal/atomic 복구, 강제 캐시 무효화 후 재구축, 명시적 `TaskStore.integrityScan`에서 수행한다. 선택 receipt는 hot path에서도 원본을 읽고 schema, filename, workspace, task와 참조 owner를 검증한다. 선택 record에 연결된 receipt evidence도 owner 검사를 유지한다. 손상 또는 실패 시 캐시는 원본을 덮어쓰지 않는다.

정상 context 조회는 task별 recent terminal과 미정산 execution을 분리한다. 미정산은 total과 bounded cursor page를 제공한다. checkpoint receipt evidence는 recent N 밖이어도 operationId로 원본을 찾아 검증한다. 전체 실행 목록이 필요한 완료·복구 동작은 task 범위 전체를 조회한다.

기존 `continuity-storage.test.ts`가 migration 중단 6단계, journal 중단 5단계, owner/schema, rename/sync와 실패 후 재조회·재시작을 검증한다. `operations-storage.test.ts`는 명시적 integrity 경계와 동일 operationId의 두 workspace, 상태 전이 원본을 검증한다. W3에서 캐시 재구축·무효화와 hot-path 외부 변경 경계를 같은 fixture에 추가한다.
