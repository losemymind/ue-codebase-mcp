# Data classification, handling and retention

Status: implementation baseline complete; data owner, security and operations review sign-off pending.

## Classification levels

The highest classification of any input propagates to derived chunks, embeddings, graphs, caches, manifests, logs and backups unless an approved declassification rule applies.

| Level | Phase 1 examples | Minimum handling |
|---|---|---|
| Restricted | Private Engine/game source and snippets; compile database; SVN credentials; API/OIDC/Agent/provider/database secrets; token values; unredacted failure dumps | Named service/operator access only, encrypted transport/storage, no client exposure except authorized bounded evidence, never log secrets or full code, no unmanaged export |
| Confidential | Symbols/relationships/embeddings; repository URLs and paths; UE metadata; ACL snapshots; user/team membership; job artifacts; audit trails; source-derived query text | Project/user/team authorization, encrypted transport/storage, private backups, redacted telemetry, provider transfer only under explicit policy |
| Internal | Secret-free validated configuration, service inventory, aggregate capacity/health metrics, schema versions | Authenticated workforce/service access; do not publish without owner approval |
| Public | Intentionally published product documentation and approved release metadata | Integrity review; verify that private paths, identities, endpoints and secrets are absent |

Credentials do not become less sensitive when encoded, encrypted or hashed. Token hashes are Confidential and secret values remain Restricted.

## Data inventory and default retention

Defaults below are production baselines. A shorter value may be configured when it still satisfies audit, recovery and product requirements. Any extension needs a named owner, purpose and expiry; legal hold is an audited exception.

| Data | Class | Durable location | Default retention / deletion trigger |
|---|---|---|---|
| Secret values and user/Agent bearer tokens | Restricted | Approved secret manager or process memory only | Never stored in app DB/config/logs; memory cleared on process exit/rotation; secret-manager versions follow corporate rotation policy |
| Hashed API token metadata | Confidential | PostgreSQL | Active life; delete 30 days after expiry/revocation unless needed by an active incident hold |
| Identity, teams and MCP grants | Confidential | PostgreSQL | Active relationship; disable immediately on removal, purge/pseudonymize personal fields within 30 days subject to audit/legal requirements |
| SVN ACL snapshots | Confidential | PostgreSQL | Keep 90 days for authorization investigation; never use a snapshot past its configured freshness TTL for an allow decision |
| SVN workspace/source files | Restricted | Isolated Windows workspace | Job/revision lifetime only; clean after success/failure and within 24 hours unless quarantined for an approved incident; never place in backup |
| Compile database and raw parser intermediates | Restricted | Isolated workspace/staging storage | Generation build lifetime; delete within 24 hours after publish/failure unless an approved diagnostic hold exists |
| Active index generation | Restricted/Confidential | PostgreSQL and protected object storage | Active lifetime |
| Superseded index generations/manifests | Restricted/Confidential | PostgreSQL and protected object storage | Seven days or the two most recent valid generations, whichever retains more rollback coverage; then cryptographic/physical deletion by storage capability |
| Query/provider request and response bodies | Restricted/Confidential | Memory only | Request lifetime; no durable raw-body logging or caching except content-hash-keyed authorized index data |
| Job events and redacted bounded logs | Confidential | PostgreSQL/object storage | 30 days; security incidents may place a scoped audited hold |
| Build/test artifacts when later enabled | Confidential/Restricted | Protected object storage | 30 days by default; preset may shorten, and a release policy may extend with owner approval |
| Audit events | Confidential | PostgreSQL/protected archive | 365 days, append-oriented and access-audited |
| Metrics and redacted traces | Internal/Confidential | Observability backend | Metrics 90 days; traces 30 days; payload/source content is prohibited |
| Backups | Same as source data | Encrypted private backup storage | Seven days, meeting RPO at most one hour and RTO at most four hours; expired copies deleted and restore access audited |

Retention timers apply to replicas, caches and derived exports. Deletion workflows must cover database rows, object versions, local Agent files and queued retry payloads. Backups age out on their own schedule; application deletion is not represented as removal from an immutable pre-existing backup.

## Collection and minimization

- Collect only SVN paths/revisions, C++/module semantics and operational metadata needed for Phase 1.
- Do not reverse-engineer `.uasset`, retain texture/mesh/audio payloads, or begin Phase 2 asset collection.
- Evidence snippets are line- and size-bounded. A client cannot request arbitrary filesystem paths or raw repository archives.
- Audit stores a canonical request hash and selected non-sensitive fields, not bearer tokens, full query bodies or complete source.
- Provider batches contain the minimum authorized chunk text required for embedding/rerank. Endpoint, model and data-processing approval are administrator policy, never caller input.

## Access and authorization

- Effective source access is `fresh SVN ACL snapshot intersection current MCP ACL` at project, team, user, repository and path scope.
- Authorization applies to source and all derived forms, including embeddings, counts, graph edges, caches, logs, artifacts and backups.
- ACL uncertainty, refresh failure or staleness is deny-by-default. ACL reduction invalidates access immediately; it must not wait for index regeneration.
- Break-glass/operator access is named, time-bounded and audited; it does not grant MCP query access.

## Secret references

Versioned YAML and database configuration contain only an opaque `secret_ref` identifying an entry in an approved secret store. They must not contain secret material, fallback plaintext, command substitution or a caller-selected secret provider.

At startup, the configuration layer validates the reference shape and allowed store/namespace. Resolution uses the service identity, keeps the value in memory only, registers its value/fingerprint with redaction without printing it, and fails startup or the dependent capability closed when resolution fails. Rotation replaces the referenced version or secret-manager current value without copying it into application configuration.

## Logging and incident handling

- Structured logs use explicit allowlisted fields. Tokens, cookies, authorization headers, secrets, raw provider bodies, full code, compile commands and full environment blocks are prohibited.
- Paths and user identifiers are included only where operationally required and are classified Confidential.
- Diagnostic quarantine requires a ticket/incident ID, named owner, access list and automatic expiry no later than 14 days unless renewed.
- Security/legal holds record scope, approver, reason and review date. They never make held data available to unauthorized MCP users.

## Verification required before G1

- Seed canary secrets and private source markers, exercise success/error/retry paths, and scan every log, trace, event, artifact and backup manifest.
- Test access removal across direct user, team, project and SVN path changes; cached results must stop immediately.
- Exercise retention cleanup idempotently for completed, failed, cancelled and abandoned jobs.
- Restore a seven-day backup in isolation and verify ACLs/classification survive restoration.
- Obtain named data owner, security and operations approval for provider transfer and every retention exception.

This document records policy; it does not assert that production credentials, provider approval, cleanup jobs, recovery drills or human sign-offs already exist.
