# ChatGPT Remote MCP

A self-hosted MCP development server with Docker, Cloudflare Tunnel, OAuth,
bounded file operations, process management and persistent usage telemetry.
The server is built from this repository's `src/` and npm lockfile.

## Setup

1. Copy `.env.example` to `.env` or run `scripts/setup-keys.ps1`.
2. Replace placeholder host paths, domain and credentials in `.env`.
3. Configure your tunnel origin to `http://localhost:2999`.
4. Run `scripts/start.ps1` from PowerShell.
5. Connect your MCP client to the configured public URL followed by `/mcp`.

`.env.example` contains examples only. Actual paths, mount aliases, container
names, volume names, timezone and credentials belong in ignored `.env`.
Preserve existing volume names during migration to retain OAuth and user data.
The setup helper generates an approval key; it does not register OAuth clients.

## Development and verification

- `npm ci`, `npm run typecheck`, `npm test`, `npm run build`
- `npm run integration:docker`: isolated Linux tests/build and live deployment checks
- `npm run post-deploy:verify`: source digest and authenticated public MCP checks
- `scripts/usage-report.ps1 -Hours 24`: aggregate actual usage, excluding marked probes

The MCP server publishes 21 tools, including bounded `read_files` batching.
Existing filesystem and process tools remain available. The container has full
access to configured mounts; protect credentials and select mounts deliberately.

See [performance and operations](docs/performance.md) for logging, monitoring,
rollback and deployment details. Runtime reports under `docs/runtime/` are
local and excluded from Git and Docker build inputs.

## License and provenance

MIT. This project incorporates code from `kstost/cokacremote`.
See [upstream provenance](UPSTREAM.md) and the preserved
[upstream license](templates/UPSTREAM-LICENSE).
