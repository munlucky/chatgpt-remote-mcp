# 운영 개선 배포 기록

검증일: 2026-10-26 KST. 사용자가 커밋·푸시와 Docker 재기동을 요청했다.

제품 커밋: `15c4d1e0a444b62f949c239d48f552b0e0e9d477`. Kernel Git 종료 처리로 `main`에 커밋·푸시했고 원격 해시 일치를 확인했다. [확정 계획](OPERATIONS-2026-10-25-FINAL-PLAN.md)과 [격리 검증 기록](OPERATIONS-2026-10-26-IMPLEMENTATION.md)의 계약을 유지한다.

## 재기동과 식별값

공식 `scripts/start.ps1`로 빌드와 재기동을 수행했다. 재기동 직전 preflight의 `activeManagedProcesses=0`을 확인했다. Compose 프로젝트는 `workmachine`이다. `workmachine`은 running/healthy, `chatgpt-cloudflared`는 running이다. 기존 상태 볼륨을 보존했다.

- 실행 build ID: `src-4dae6963da9b148b3a50`
- 실행 이미지: `sha256:d7498c7f5560902795cd6808b3d72df97f4263f47633ef886aede00b31b62281`
- 보존한 이전 이미지 태그: `chatgpt-remote-mcp:rollback-20261026`
- 이전 이미지: `sha256:f966641ebafac7485f8cb6c26e5e1c994f6c90a6a903c2029db1b33ec2cee50e`

소스 digest, 이미지, 실행 서버 build ID가 일치한다. 운영 장애 조건이 발생하지 않아 실제 rollback은 실행하지 않았다. 배포 전 rollback 호환 시험 AC18은 격리 검증에서 통과했다.

## 배포 후 검증

`npm run post-deploy:verify`가 통과했다. 실제 공개 MCP endpoint와 컨테이너를 검사한 결과다.

| 항목 | 결과 |
| --- | --- |
| 공개 서버 catalog | 도구 28개, digest `ec94afa4ab4e3b74be836b4fdc044cb0f8250987dd870d6244aa2cce0ac519fa` |
| 연속성·실행 추적·최종 checkpoint 광고 | 통과 |
| OAuth·공개 MCP 인증 | 통과, 비인증 요청 401 |
| 최소 health·진단 보호 | 통과 |
| terminal 실행·재조회·공유 receipt boot·오류 분류 | 통과 |
| 활성 managed process | 0 |
| telemetry pending/dropped/writeFailures | 모두 0 |
| Compose 프로젝트·소스 digest·commit helper 일치 | 통과 |
| OAuth access/refresh TTL | 3,600초 / 2,592,000초 |
| OAuth 등록 client 상한·proxy trust hops | 256 / 1 |
| probe secret 설정 | 확인, 값은 기록하지 않음 |

서버 catalog 검증은 실제 ChatGPT 클라이언트의 도구 새로 고침 확인을 대신하지 않는다. 검증 결과의 `realClientVerified=false`를 유지한다. AC16-DEPLOYED의 서버 측 항목은 통과했지만 실제 클라이언트의 신규 필드·옵션 호출 확인이 남아 있으므로 AC16-DEPLOYED 전체는 미검증이다. AC17의 24시간 운영 효과도 아직 검증하지 않았다. W6 전체 완료로 표시하지 않는다.

## 공유 Kernel 검사 수정

커밋 과정에서 공유 Kernel이 `.env.example`의 공개 OAUTH 설정과 숫자 token TTL을 비밀 값으로 오인했다. 사용자가 별도 저장소의 최소 수정·검증·로컬 반영을 승인했다.

`C:/dev/moonshot-relay`의 staging 검사와 관련 회귀 시험 두 파일만 수정했다. 프로젝트 전용 예외는 추가하지 않았다. AUTH 이름 토큰을 OAUTH와 구분하고 숫자 TTL 및 명시적 replacement placeholder를 허용한다. 실제 credential 값, provider token, private key 거절은 유지했다. 빌드·타입 검사·Git 종료 처리 회귀 시험을 통과했고 공식 installer로 반영했다. 공유 저장소 수정은 커밋·푸시하지 않았다.

생성 소스와 설치 staging 검사 SHA-256: `e50fffac7a18842a07cd5005b6b6a702e513376b0facc9837b3ba30eca8ec0ce`.

후속 문서 Run 시작에서 이전 finalization의 커밋 전 snapshot과 커밋 후 상태가 달라 연속성 검사가 중단됐다. HEAD와 남은 계획 문서 2개를 대조했다. 사용자가 요청한 Kernel 커밋 이외의 변경은 없었다. 공식 workspaceRecovery 경로로 이 확인된 기준을 연결했다. DB나 receipt는 수정하지 않았다.

## 증거 보관

원시 재기동·검증 로그는 로컬 임시 위치에 보관한다. 비밀 값과 runtime 산출물은 저장소에 넣지 않는다. `mcp-operations-20261026-post-deploy.json`의 SHA-256은 `8359553e99e53437c4043fcd9b1b29e76882e6318350fb62ced6af7f2fb9da35`다. 임시 파일 정리 시 원시 로그는 사라질 수 있다.
