# ADR-001: TypeScript runtime and package manager

- Status: accepted implementation baseline; architecture review sign-off pending
- Date: 2026-08-27
- Scope: Phase 1 control-plane, retrieval, coordination and shared packages

## Context

The server-side monorepo needs one reproducible runtime/toolchain contract. Runtime drift would make offline builds, support and security patch assessment ambiguous.

## Decision

- Application and package code uses TypeScript targeting Node.js `24.18.0`.
- Package management uses npm `11.16.0` with lockfile v3 and `packageManager: npm@11.16.0`.
- Node and npm versions are exact, not ranges. CI and deployment fail on a version mismatch.
- Production dependency installation uses `npm ci`; the committed lockfile is authoritative.
- npm workspaces are the monorepo package boundary. New dependencies must pass the permissive-license allowlist, vulnerability policy and SBOM generation.
- Generated JavaScript/build output is deterministic where inputs permit and is not treated as source.

## Consequences

One supported runtime simplifies reproducible builds and incident response. Version upgrades require an ADR amendment, lockfile regeneration, complete CI/security checks and deployment compatibility evidence. Native Windows/UE components remain outside this TypeScript runtime and are governed by ADR-005.

## Rejected alternatives

- Floating `latest`/major-only Node or npm: rejected because rebuilds would not be reproducible.
- Multiple JS package managers: rejected because lockfile and lifecycle behavior would diverge.
- Deno/Bun as the production baseline: rejected because the confirmed plan selects enterprise Node.js and npm.
