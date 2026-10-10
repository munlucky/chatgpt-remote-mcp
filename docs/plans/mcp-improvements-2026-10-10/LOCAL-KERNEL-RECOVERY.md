# 로컬 계정 Kernel 작업 재개

적용일: 2026-10-10 KST. 프로젝트: `C:\dev\chatgpt-remote-mcp`.

사용자가 현재 상태에서 새 작업을 시작하고 계속 진행하도록 승인했다. 로컬 계정의 설치된 Moon Relay Kernel에 있는 공식 workspace recovery 경로를 적용했다.

## 원인

이전 완료 Run `run-11ee4f54-4be3-4f94-8101-84d304039464`는 과거 배포 작업이다. 저장된 workspace identity는 `sha256:f2b2b55cefb591ae0b03881586118c37e223ee7030d195efe450fde23eed7e9e`다.

현재 HEAD는 계획 기준 `e75d99a2bf1fe8deb0e5e6d94d81b011b460da42`다. 현재 상태의 identity는 `sha256:1f55068f8fed9346e55e6eb912966ec0ead5063eedc81a0f27e8847acd8ad61c`다. 기존 미커밋 변경은 계획 문서 6개와 `.gitignore`다.

Kernel은 완료 작업 뒤의 successor가 같은 상태에서 시작하는지 검사한다. 값이 달라 `successor_workspace_continuity_mismatch`를 반환했다. 제품 저장 코드의 실패가 아니다.

## 적용

로컬 계정 런타임: `C:\Users\moon\.moon-relay-kernel`.

1. 현재 Git 상태와 Kernel workspace identity를 다시 확인했다.
2. 사용자 승인에 따라 작업 계약의 `workspaceRecovery.acknowledgedIdentity`에 현재 identity를 넣었다.
3. 설치된 `bin\kernel.ps1 next --contract-json <계약> --invocation-intent new-task --provider codex --json`을 실행했다.
4. Kernel이 새 Run `run-b316c9f0-5b85-4c7a-93a7-d23af003054e`와 `mcp-08-schema` 작업 범위를 발급했다.

이 경로는 기존 완료 근거를 수정하지 않는다. 새 proof baseline을 사용한다. 런타임 DB를 직접 수정하거나 이전 checkout으로 되돌리지 않았다. 복구 기능은 설치된 런타임에 이미 있으므로 소스 코드 교체 또는 전체 런타임 재설치는 필요하지 않았다. 계정 Codex profile doctor도 `ready`를 반환했다.

## 기록과 후속 작업

작업 계약과 연결 응답은 `C:\Users\moon\.moon-relay-kernel\contracts\chatgpt-remote-mcp-storage-20261010\`에 있다. 해당 디렉터리는 런타임 근거이며 Git package에 넣지 않는다.

첫 구현 범위는 MCP-08 → MCP-04다. 기존 MCP taskId와 consumer 프로젝트 계약은 보존한다. 운영 프로세스, PAUSED 자동화, 실제 Docker 배포, commit/push는 이번 범위에 포함하지 않는다. 제품 완료는 별도 시험과 Kernel 판정으로 확인한다.
