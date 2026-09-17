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
1. For a new long task or a request to continue previous work, call `get_work_context` before deciding what to execute.
2. Inspect repository state (`git status`) and compare current files with any returned checkpoint/receipt. Current workspace state is authoritative.
3. Create a task explicitly with `checkpoint_work(mode=create)` only when no matching active task exists. Update milestones with `checkpoint_work(mode=update)` and the current revision.
4. For commands whose duplicate execution could be unsafe, pass both `taskId` and a caller-generated `operationId` to `exec_command` or `run_script`. Reuse the same `operationId` only for the exact same logical retry.
5. Never automatically re-run a tracked operation in `prepared`, `running`, or `unknown`. Inspect current files/artifacts and reconcile uncertainty first.
6. Execute focused tests, then broader validation. A receipt with exit code 0 proves that execution was observed; it does not prove unchanged current files still pass.
7. Call `complete_work` only after current workspace/evidence review. Task completion does not implicitly terminate OS processes.
8. Report status concisely to the user.

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

