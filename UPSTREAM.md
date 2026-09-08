# Upstream provenance

The server source, tests and npm lockfile were imported from the local
`cokacremote` checkout on 2026-09-08. The deployed upstream checkout was
`kstost/cokacremote` at `d7ceca39a0308d4a91238d35e5599ece30e69a19`.
The five inspected execution-path source files matched after CRLF normalization.
This is an import of the local working tree, not a claim that every imported
file is identical to that upstream commit.

The original MIT license is retained in `templates/UPSTREAM-LICENSE`.
This project now builds its own `src/` with its committed npm lockfile; Docker
does not fetch an evolving upstream branch. See `docs/performance.md` for the
performance changes and deployment procedure.
