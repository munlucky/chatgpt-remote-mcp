# Remote Agent Development Guidelines

This machine is a dedicated remote workspace connected to your AI client via Model Context Protocol (MCP).

## 1. Operating Environment
- Operating System: Ubuntu Linux (Docker Container)
- Working Directory: `/shared` (Maps to the host project directory)
- Execution Privilege: Root access inside the container
- Installed Runtimes: Node.js, Python 3, Git, Nginx

## 2. Agent Principles
1. **Safety First**: Verify current working directory and existing uncommitted changes (`git status`) before modifying or deleting any files.
2. **Context Integrity**: Do not overwrite or delete existing user files unless explicitly requested.
3. **Execution Verification**: When creating or editing code, execute focused tests or verify syntax to ensure non-breaking changes.
4. **Clean Commits**: Make small, incremental changes with clear, descriptive commit messages.

## 3. Recommended Workflow
1. For project work or recovery, call `get_work_context` with the exact `cwd` or existing `taskId` before deciding what to execute. The default summary is compact; request `format=full` when inspecting detailed evidence or reconciling uncertainty.
2. Reuse an existing active task. Create a continuity checkpoint explicitly with `checkpoint_work(mode=create)` only when no active task exists. This is not a replacement for an existing project/Kernel task contract. Update verified milestones with `mode=update` and the current revision.
3. Inspect repository state (`git status`) and compare current files with the checkpoint/receipt. Current workspace state is authoritative. In required tracking mode, even inspection commands need the tracking pair established in step 2.
4. Pass both `taskId` and a caller-generated `operationId` to `exec_command` or `run_script`; required tracking mode rejects missing IDs before spawn. Reuse the same `operationId` only for the exact same logical retry. Follow the returned `nextCall` and `nextSeq`; drain remaining output even after process exit.
5. Never automatically re-run a tracked operation in `prepared`, `running`, or `unknown`. Inspect current files/artifacts and reconcile uncertainty first.
6. Execute focused tests, then broader validation. A receipt with exit code 0 proves that execution was observed; it does not prove unchanged current files still pass.
7. Call `complete_work` only after current workspace/evidence review. Task completion does not implicitly terminate OS processes.
8. Report status concisely to the user.
9. For compact process state, use `list_processes(taskId=..., runningOnly=true)`. Its counts cover matching retained sessions; limited entries and missing output are not proof that the original task completed. Do not overwrite a user-input/approval wait.

## 4. Kernel Commit Standard
When committing changes, adhere to the standard format without fabricating non-existent execution/run IDs:

```text
<type>(<scope>): <summary>

요청 메시지:
<details of user request or changes>

Kernel 작업:
- 작업 목표: <objective>
- 프로젝트: <project name>
- 완료 판정: 승인됨
- Git 마감: 커밋 (or 커밋 및 푸시)
- 검증 참조: <verification results>

변경 경로 (<count>):
- <path 1>
- <path 2>
```
