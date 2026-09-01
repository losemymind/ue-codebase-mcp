# Phase 1 observability contract

P1-17 defines one content-safe observability boundary for the MCP server, index coordinator and Windows Agent. The boundary emits structured log and span records and a Prometheus registry. Deployment wiring to collectors and the protected `/metrics` listener belongs to P1-18.

## Correlation and trace propagation

- `X-Correlation-ID` is a UUID. A valid inbound value is continued; otherwise a cryptographically random UUID is generated. Invalid or duplicated headers are rejected instead of copied into output or telemetry.
- `traceparent` accepts only the fixed W3C version-00 form with non-zero 128-bit trace and 64-bit parent identifiers. Every service creates a fresh span identifier and returns its current trace context.
- One Windows Agent iteration reuses the same correlation and trace identity for registration, claim, heartbeat, event, completion or failure requests. The coordinator records the same identifiers in protected audit events.

## Data minimization

Logs and spans are closed records. Only component, operation, outcome, severity, duration, correlation/trace/span identifiers and these bounded attributes are accepted: protocol version, method, status code, tool, error code, disposition, retryable flag, attempt, job kind, lease recovery state and aggregate Agent status.

Authorization headers, bearer tokens, secret references, actor IDs, job IDs, project IDs, paths, queries, source excerpts, request/response bodies and arbitrary messages are not valid telemetry attributes. Sink failures increment `ue_codebase_telemetry_dropped_total`; they never fall back to printing the rejected record or raw exception.

Protected audit events are separate from telemetry. They contain actor, action, project/tool/resource identifiers, outcome, SHA-256 request hash, stable error code and correlation/trace/span identifiers. They never contain bearer credentials, raw query arguments, job payloads or source code. Audit persistence uses one fixed parameterized insert and security-sensitive MCP/job operations fail closed when audit storage is unavailable.

## Metrics and dashboard

The in-process registry exposes only these metric families:

- `ue_codebase_requests_total{component,operation,outcome}`
- `ue_codebase_request_duration_ms{component,operation,outcome}`
- `ue_codebase_telemetry_dropped_total`

No user, Agent, project, job, correlation, trace, tool or error identifier is used as a metric label. The Grafana dashboard at `deploy/observability/grafana/dashboards/phase-1-overview.json` covers operation rate, failure ratio, P95 latency, sink drops, aggregate Agent iteration health and Agent/job API outcomes.

## Retention and access

Follow `docs/security/data-classification-retention.md`: metrics are retained for 90 days and redacted traces for 30 days. Audit access is privileged and project-scoped where applicable. P1-18 must expose metrics only on an internal authenticated or network-restricted listener and must configure collector-side field allowlists again as defense in depth.
