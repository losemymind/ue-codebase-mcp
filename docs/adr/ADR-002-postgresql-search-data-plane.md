# ADR-002: PostgreSQL search and metadata data plane

- Status: accepted implementation baseline; architecture review sign-off pending
- Date: 2026-08-27
- Scope: Phase 1 durable application, index, graph and retrieval data

## Context

Phase 1 needs transactional identity/ACL and generation data, exact/full-text retrieval, embeddings and relationship traversal while minimizing operational systems.

## Decision

Use PostgreSQL as the single initial data plane, with:

- native relational tables and constraints for identity, ACL, repositories, revisions, symbols, relationships, jobs and audit;
- PostgreSQL full-text search (FTS) for lexical/BM25-like retrieval;
- pgvector for embeddings and vector similarity;
- transactional generation staging/publication so queries see one complete active generation;
- project/repository/generation predicates and application authorization on every retrieval path;
- encrypted connections, least-privilege roles, tested migrations and the required backup/restore policy.

Embeddings and FTS rows inherit the classification and ACL of their source. Vector proximity, hit counts and graph existence are not authorization-safe metadata by themselves.

## Consequences

The initial platform has fewer consistency and operational boundaries. PostgreSQL capacity, vacuum, vector indexes and FTS ranking must be benchmarked against 10 concurrent queries, P95 at most 5 seconds, P99 at most 10 seconds and the indexing freshness targets.

OpenSearch, Qdrant or another specialized store may be proposed only during Phase 3 if measured evidence shows this baseline cannot meet SLOs. That change requires a new ADR, stable retrieval interface, cost/operations analysis, full ACL regression and rollback path.

## Rejected alternatives

- OpenSearch plus a separate vector database from Phase 1: rejected due to extra consistency, ACL and operational failure modes without benchmark evidence.
- In-memory or local-file indexes as the durable source: rejected because they do not meet transactional publication, recovery and multi-service requirements.
