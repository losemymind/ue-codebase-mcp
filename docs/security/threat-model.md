# Phase 1 threat model

Status: implementation baseline complete; security review and residual-risk acceptance pending.

## Scope and security objectives

The model covers the Phase 1 Streamable HTTP MCP/API control plane, retrieval and index coordination services, PostgreSQL data plane, protected object storage, Windows Native Agent, isolated SVN workspaces, private SVN, OIDC, and an optional approved embedding/rerank provider.

Primary objectives are:

1. Never disclose private code, metadata or existence signals outside `SVN access intersection MCP ACL`.
2. Preserve revision, path, line, manifest and active-generation integrity.
3. Prevent MCP clients from writing code/files, applying patches, committing, pushing, submitting or invoking a general shell.
4. Keep credentials and tokens out of durable configuration, source, logs, traces, events and client responses.
5. Remain available within query/freshness targets without failing open during dependency failure.
6. Make authenticated actions and generation publication attributable and auditable.

## Protected assets

- Private Engine Fork and game source, snippets, symbols, relationships, embeddings and UE-derived metadata.
- Identity, team/project policy, SVN ACL snapshots and authorization decisions.
- SVN, OIDC, provider, database, Agent and object-store credentials.
- Revision sets, compile database, index generations, manifests and evidence locations.
- Durable jobs, leases, Agent results, audit trail, logs, backups and operational configuration.

## Adversaries and assumptions

- An authenticated user attempting cross-project discovery or capability escalation.
- A stolen/expired user or Agent token.
- Malicious input committed to SVN, including filenames, source text, build metadata and repository history.
- A compromised or misconfigured provider, client, proxy, Agent host or operator account.
- Network attackers on internal segments; internal placement is not treated as authentication.

SVN and OIDC are authoritative only for their documented roles. Source content is untrusted input. The Windows host and PostgreSQL platform must be hardened by operations; compromise of their administrative identity is a residual platform risk, not an assumed-safe application event.

## STRIDE register

| ID | Category | Threat / affected boundary | Required mitigation | Verification |
|---|---|---|---|---|
| S-01 | Spoofing | Forged, expired, revoked or wrong-audience user token at TB-1/TB-2 | Require OIDC issuer/audience/algorithm/time validation or hashed bearer token validation; deny anonymous; bounded JWKS cache and fail closed | Negative auth tests for signature, issuer, audience, expiry, not-before and revocation |
| S-02 | Spoofing | Stolen/replayed Agent identity or job lease at TB-4 | Short-lived distinct Agent credential, TLS, attempt-bound lease, nonce/idempotency and capability registration | Replay, expired lease, wrong Agent and duplicate-completion tests |
| T-01 | Tampering | Caller changes project, repository, path, revision or generation after authorization | Typed immutable request context; server-selected active generation; authorize object IDs and normalized paths at use | Parameter substitution and TOCTOU tests |
| T-02 | Tampering | Malicious SVN content/path escapes workspace or corrupts parser | Canonical root confinement, no link/junction escape, bounded streaming parsers, treat compile DB/source as hostile, isolated OS identity | Traversal, junction, oversized XML/source and parser-fuzz fixtures |
| T-03 | Tampering | Agent publishes incomplete or wrong-revision generation | Pinned revision set, attempt/lease binding, schema and hash verification, completeness checks, transactional activation | HEAD-change, mismatched manifest, partial upload and rollback tests |
| T-04 | Tampering | Database/object storage modification | Least-privilege roles, TLS, durable audit, manifest hashes, backup verification and restricted administration | Grant review, integrity checks and restore exercise |
| R-01 | Repudiation | User denies query/admin/job action | Append actor, tool/action, project, outcome, request hash, source and correlation ID; synchronized clocks | Audit completeness and correlation tests |
| R-02 | Repudiation | Agent denies result or retries create ambiguity | Record Agent ID, attempt, lease, revision set, event sequence and manifest hash | Crash/retry/idempotency and ordered-event tests |
| I-01 | Information disclosure | ACL bypass through search, direct IDs, pagination, counts, timing or errors | `SVN ACL intersection MCP ACL` before retrieval and packaging; stale/missing ACL denies; uniform not-visible responses; bounded results | Cross-project negative matrix and side-channel review |
| I-02 | Information disclosure | Secrets or full code in logs/traces/events/errors | Secret-reference configuration, centralized redaction, structured allowlisted telemetry, no raw payload fallback | Secret/source canary scan over every telemetry sink |
| I-03 | Information disclosure | Provider receives unauthorized/excess source or leaks it | Admin allowlisted endpoint/model, data-processing approval, minimum bounded chunks, TLS, no raw request logging, exact/FTS degradation | Provider mock capture, endpoint override rejection and outage tests |
| I-04 | Information disclosure | Backups/artifacts/object URIs become client accessible | Private storage, service credentials, encryption, bounded mediated download only after reauthorization, seven-day backup retention | Anonymous/cross-project fetch negatives and restore-access review |
| D-01 | Denial of service | Oversized/complex MCP input or graph fan-out exhausts service | Proxy/body/rate/concurrency limits, JSON depth/length limits, pagination, query timeout and graph depth/width caps | Load, oversized payload, timeout and cancellation tests |
| D-02 | Denial of service | Index/provider/SVN outage or retry storm exhausts queue/host | PostgreSQL durable leases, bounded retries with jitter, backpressure, per-project quota, circuit breaking and exact/FTS degradation | Dependency fault injection, crash recovery and queue saturation tests |
| D-03 | Denial of service | Clang/UE process consumes disk, memory or CPU | Isolated worker identity/workspace, resource/time limits, bounded logs, cleanup and retrieval capacity reservation | Resource exhaustion, timeout and disk-pressure tests |
| E-01 | Elevation of privilege | Tool schema smuggles command, executable, path or environment override | Closed tool registry and JSON Schema; no command strings/general shell; future execution accepts signed/reviewed preset ID only | MCP enumeration and malicious argument/path injection tests |
| E-02 | Elevation of privilege | MCP-only or SVN-only grant is treated as sufficient | Central policy engine computes intersection at request time from current/fresh inputs; default deny | User/team/project/path grant Cartesian negative tests |
| E-03 | Elevation of privilege | SSRF through OIDC, provider, SVN or artifact endpoint | Administrator-configured allowlist, fixed schemes/ports, DNS/IP policy, redirect control and no caller-provided URL | Link-local, loopback, redirect, DNS-rebind and URL-confusion tests |
| E-04 | Elevation of privilege | Compromised Agent reaches control/data-plane administration | Dedicated network route and service role, internal endpoint authorization, no user-token reuse, DB/storage least privilege | Network-policy and credential-scope review |

## Abuse cases that must remain impossible

- Enumerating an unauthorized symbol/path and learning existence from count, latency, error or cache behavior.
- Using `read_file_excerpt` or an encoded path to leave the authorized repository/revision.
- Supplying `cmd`, executable path, shell metacharacters, arbitrary arguments, environment variables or output path to any MCP tool.
- Coercing an indexing parser to execute repository-controlled scripts or load unapproved compiler plugins.
- Selecting an old generation captured before an ACL reduction.
- Redirecting provider/OIDC/SVN traffic to an attacker-controlled or metadata endpoint.
- Publishing an Agent result for a different revision set, job attempt or project.

## Security state transitions

- ACL snapshot missing, expired, parse-failed or refresh-failed: deny affected repository/path queries and alert; never reuse stale access as an allow decision.
- OIDC key/issuer validation unavailable: existing cryptographically valid tokens may be honored only within the configured safe cache lifetime; unverifiable tokens are denied.
- Semantic provider unavailable: serve authorized exact/FTS results with explicit degradation/uncertainty; do not send to an alternate unapproved endpoint.
- Index publication validation fails: retain the previous active generation, quarantine staging output and emit an audited failure.
- Audit persistence unavailable: security-sensitive mutations and job acceptance fail closed; bounded read-only retrieval policy must be explicitly configured and reviewed.

## Residual risks requiring human review

- Windows host or database administrator compromise can bypass application controls; OS hardening, credential isolation, network segmentation and monitoring require operations validation.
- Embedding vectors may retain information about private source. Provider data terms, region, retention and model-training policy require data/security approval before production enablement.
- Timing side channels cannot be proven absent solely by documentation; representative ACL performance tests and response-shape review are required.
- Real SVN authorization semantics and private Fork compile database behavior require the production URLs/accounts/toolchain inputs listed in the development plan.

No residual risk is accepted by this document. Named security and architecture reviewers must sign the G1 review after controls have executable evidence.
