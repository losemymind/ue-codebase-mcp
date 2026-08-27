# UE Codebase MCP

Production-oriented, read-only semantic indexing and MCP access for Unreal Engine 5.6 codebases. Phase 1 supports SVN only and never exposes code-writing, patching, commit, push, submit, arbitrary shell, or arbitrary file-write capabilities.

## Prerequisites

- Node.js `24.18.0`
- npm `11.16.0`

## Reproducible local verification

The P1-01 foundation deliberately has no third-party packages. A clean checkout can therefore be verified without network access:

```powershell
npm ci --offline
npm run ci
npm run release:check
```

Generated build, coverage, SBOM, and report files are ignored. See `docs/progress/phase-1.md` for task-by-task evidence and blockers.

The authoritative scope and sequencing rules are in `DEVELOPMENT_TASK_PLAN.md`.

