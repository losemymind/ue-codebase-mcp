# ADR-005: Windows Native Agent, UE 5.6-compatible Clang and SVN-only Phase 1

- Status: accepted implementation baseline; architecture and security review sign-off pending
- Date: 2026-08-27
- Scope: Phase 1 repository acquisition and C++/module indexing

## Context

The private Unreal Engine Fork and game project require the real UE build environment, compile commands and Windows tooling. The confirmed first release source-control boundary is SVN.

## Decision

- Run privileged repository/toolchain integration in a Windows Native Agent installed as a Windows Service under a dedicated least-privilege identity.
- Support UE `5.6` only. Engine/project compatibility is validated rather than silently approximated.
- Use C++20 and the Clang/LibTooling version compatible with the actual UE 5.6 private Fork/toolchain.
- Generate and consume the real UBT compile database. Do not invent global compiler flags; report translation-unit coverage and require at least 99% at G1, with explicit reviewed exceptions.
- Phase 1 repository acquisition supports SVN only, using read-only credentials and pinned revision sets across Engine and project repositories.
- Treat SVN content, filenames, compile commands and parser inputs as untrusted. Constrain canonical paths to isolated per-job workspaces, bound resources and return versioned hash-bound manifests.
- The Agent claims typed leased jobs and never accepts a user-provided shell command, executable, arbitrary argument list or environment override.

Git and Perforce are outside Phase 1 and remain in the post-G3 extension phase. Their future provider SPI must not weaken SVN regression behavior, evidence semantics or the MCP read-only boundary.

## Consequences

Production indexing requires a Windows host with the exact private Fork/toolchain and real SVN inputs. Cross-platform development can build control-plane components and use test doubles, but cannot claim production compile-database or Engine indexing acceptance.

Agent service installation, credentials, endpoint binding, workspace ACLs, resource limits and cleanup require Windows security/operations review.

## Rejected alternatives

- Linux/container-only indexing: rejected because it cannot be assumed equivalent to the confirmed Windows UE 5.6 build environment.
- Regex-only or guessed-flag C++ indexing: rejected because symbol/relation accuracy and TU coverage require the real compile database.
- Git/Perforce in the first release: rejected by confirmed scope and phase gates.
