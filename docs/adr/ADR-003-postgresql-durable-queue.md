# ADR-003: PostgreSQL durable job queue

- Status: accepted implementation baseline; architecture review sign-off pending
- Date: 2026-08-27
- Scope: Phase 1 indexing and Agent coordination jobs

## Context

Index work must survive API/Agent crashes, bind execution to an immutable revision set and publish at most one valid result without introducing another infrastructure dependency.

## Decision

Use a PostgreSQL durable queue stored with job and generation metadata.

- Claim ready work in a short transaction using `SELECT ... FOR UPDATE SKIP LOCKED`.
- Each claim creates an attempt-scoped lease with owner and expiry. Heartbeats extend only the matching active attempt.
- Completion/failure/cancellation transitions are conditional and idempotent; an expired or superseded attempt cannot publish.
- A retry retains the pinned revision set and increments attempt metadata. Backoff, maximum attempts and terminal error class are durable.
- Job events have monotonic per-job sequence numbers and redacted bounded payloads.
- Generation activation is a separate validated transaction; queue completion alone never makes staging data queryable.
- Payloads are typed and versioned. They contain IDs and secret references, never credentials, shell commands or arbitrary environment/argument strings.

## Consequences

Queue and publication state can participate in database transactions, simplifying recovery and idempotency. Workers must keep claim transactions short, indexes must support ready-job selection, and monitoring must cover lease age, retry rate, starvation and table growth.

A dedicated broker would require operational need and a later ADR while preserving lease/idempotency semantics.

## Rejected alternatives

- In-memory queues: rejected because process restart loses work and attribution.
- Filesystem/watch-folder queues: rejected because locking, recovery, ACL and observability are insufficient.
- Redis/RabbitMQ/Kafka in Phase 1: rejected because the confirmed scale does not justify another durable system before PostgreSQL measurements.
