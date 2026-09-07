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
1. Inspect repository state: `git status`
2. Read project documentation: `README.md`, package files
3. Plan edits with minimal disruption
4. Execute and test
5. Report status concisely to the user

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

