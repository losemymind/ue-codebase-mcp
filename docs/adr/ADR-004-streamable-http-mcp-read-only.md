# ADR-004: Streamable HTTP MCP and permanent source-mutation boundary

- Status: accepted implementation baseline; architecture and security review sign-off pending
- Date: 2026-08-27
- Scope: all MCP product versions; Phase 1 exposes retrieval/status tools

## Context

Multiple MCP clients need a standard network interface, but the product is an index/retrieval system rather than a remote development shell. Source mutation and arbitrary execution would materially enlarge privilege and injection risk.

## Decision

- Expose MCP through the standard Streamable HTTP transport behind internal TLS and an authenticated reverse proxy.
- Require authentication on every MCP session/request and JSON Schema validation for every tool input.
- In Phase 1, expose only read-only retrieval and status tools after per-request authorization.
- Permanently forbid MCP tools or hidden parameters that write code/arbitrary files, apply patches, commit, push, submit, launch a general shell, select an executable, or pass arbitrary commands/arguments/environment.
- Compute effective visibility as a fresh SVN authorization snapshot intersected with current MCP project/team/user ACL. Missing, stale, failed or indeterminate authorization is a denial.
- Bound pagination, snippets, graph depth/width, response size and error detail. Evidence includes relative path, line range, SVN revision, index generation and uncertainty.
- Audit actor, tool, scope and outcome without tokens, secrets, full source or raw request bodies.
- Pin the initial implementation to stable MCP revision `2025-11-25`, retaining protocol negotiation compatibility with `2025-06-18` and `2025-03-26`. The Phase 1 HTTP server is stateless and does not issue `Mcp-Session-Id`; Streamable HTTP sessions and server-sent events are optional and can be added only with bounded lifecycle and resumption controls.
- Require exact Host/Origin allowlists, RFC 9728 protected-resource metadata, the `mcp:read` scope, a caller-bound request rate limiter and one total request deadline at the HTTP boundary. Unsupported GET streams return `405`; the server does not emulate SSE.

Later approved `request_reindex`, UBT and UAT operations change index/build/test state only. They accept administrator-defined preset IDs and typed bounded fields, cannot mutate version-controlled source, and do not weaken the permanent prohibitions above.

## Consequences

Clients receive a consistent standard protocol and evidence contract. Some workflows that need edits must remain in the user's IDE/VCS tools. MCP tool enumeration and schemas become security controls and require negative regression tests.

## Rejected alternatives

- stdio as the production-only transport: rejected because the fixed-device multi-user service requires centralized authentication, limits and audit.
- REST-only proprietary search API: rejected because supported clients require MCP interoperability.
- Generic command, file-write or VCS mutation tools: rejected permanently by the confirmed product boundary.
