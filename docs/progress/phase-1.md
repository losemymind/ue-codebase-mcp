# Phase 1 progress record

This record is append-only by task. It captures reproducible commands, results, known limitations, and the next authorized task. Phase 2 remains frozen until all G1 criteria and required human sign-offs pass.

## Environment baseline

- Development branch: `codex/phase-1-foundation`
- Node.js: `24.18.0` (exact)
- npm: `11.16.0` (exact)
- Package manager: npm with lockfile v3
- Third-party dependency count at P1-01: zero

## P1-01 — monorepo and quality/release foundation

Status: complete on 2026-08-27.

Deliverables:

- Initialized Git repository and authorized development branch.
- Workspace directory contract, lockfile, exact runtime policy, deterministic build manifest.
- Formatting, security-boundary lint, unit test, build, license audit, CycloneDX SBOM, and release checks.
- Least-privilege Windows CI baseline.
- Default-deny permissive-license policy.

Verification commands:

```powershell
npm ci --offline
npm run ci
npm run release:check
git status --short --branch
```

Results:

- `npm ci --offline`: passed; no packages downloaded and dependency tree was already complete.
- `npm run ci`: passed; format, boundary lint, 3 unit tests, build, license audit, and CycloneDX generation all succeeded.
- `npm run release:check`: passed for version `0.1.0`.
- Two clean builds produced identical SHA-256 `EFB05799F697EEFB5CABC05A235FF4500B0D87489B73C6AC2016D3D8B23EF494` for `dist/build-manifest.json`.
- Third-party dependency count: zero; license audit passed.

Known limitations:

- No production SVN, UE 5.6 Fork, OIDC, provider, cloud, or fixed-device inputs are configured or simulated as production.
- Human architecture/security sign-off is not automatable and will remain an explicit G1 input.

Next work: P1-02 and P1-04 may proceed in parallel.

## P1-04 — initial PostgreSQL and pgvector migrations

Status: implementation complete on 2026-08-27; live PostgreSQL acceptance remains blocked by the local environment.

Deliverables:

- Transactional bootstrap and core up/down migrations with an ordered manifest and explicit reverse-dependency rollback.
- Phase 1 sections 5.1, 5.2, 5.3, and 5.5: 33 business tables for identity/ACL, SVN repositories and generations, C++ semantics/FTS/pgvector, persistent jobs, auditing, backup, and evaluation.
- Primary/foreign/unique/check constraints, partial and reverse-lookup indexes, one-active-generation enforcement, time/state invariants, automatic `updated_at`, GIN FTS, and a 1536-dimension cosine HNSW baseline.
- Dependency-free PowerShell migration runner with contiguous-history validation, `ON_ERROR_STOP`, target-version upgrade/rollback, and libpq `PG*` environment configuration so credentials need not appear in arguments.
- Applied migration SHA-256 persistence and drift detection before any later upgrade or rollback.
- Default structural integration tests plus an opt-in live test that exercises empty upgrade, version-1-to-version-2 upgrade, negative constraints, rollback, and re-upgrade only when the database name ends in `test`.

Verification commands:

```powershell
node --test tests/integration/database-migrations.test.mjs
$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('database/migrate.ps1', [ref]$null, [ref]$errors) > $null; [System.Management.Automation.Language.Parser]::ParseFile('database/test-migrations.ps1', [ref]$null, [ref]$errors) > $null; if ($errors.Count -gt 0) { exit 1 }
npm run format:check
npm run lint
npm test
npm run build
npm run license:check
npm run ci
```

Results:

- Structural migration suite: passed, 5/5 tests.
- Both PowerShell scripts: parser validation passed.
- Repository formatting, lint, full test, build, and license checks: passed.
- `npm run ci`: passed; 8/8 repository tests passed and the CycloneDX SBOM reported zero dependencies.
- No dependency was added; the permissive-license dependency count remains zero.
- Live `psql` verification was not run: neither `psql` nor Docker is installed in this environment. Therefore empty-database upgrade, prior-version upgrade, PostgreSQL-enforced constraints, and rollback are not claimed as actually passed.

Known limitations:

- Live acceptance requires PostgreSQL with pgvector and a disposable database whose name ends in `test`; configure standard libpq `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, and `PGDATABASE`, then run `npm run db:test:live`.
- The baseline ANN index covers 1536-dimensional embeddings. P1-12 must add model-specific partial ANN indexes if the approved provider uses a different configured dimension; no provider choice is fabricated here.
- Schema ownership and runtime/migration role grants depend on the deployment identity model and remain part of the later deployment baseline.

Next work: P1-04 live acceptance when a disposable PostgreSQL+pgvector test database is available; otherwise continue only with dependency-unblocked Phase 1 tasks. Phase 2 remains frozen.

## P1-02 — architecture, threat model, data classification and ADRs

Status: implementation complete on 2026-08-27; architecture/security/data-owner review sign-off pending. P1-02 is not considered globally done under the Definition of Done until those human reviews are recorded.

Deliverables:

- C4 system context, container and control-plane component views, including generation/query invariants.
- Explicit network/execution/authority/operations trust zones and boundary controls.
- Phase 1 STRIDE threat register, abuse cases, fail-closed states and residual risks.
- Data classification, propagation, minimization, retention/deletion and secret-reference rules.
- ADR-001 through ADR-005 locking the exact TypeScript/Node/npm baseline, PostgreSQL search data plane, PostgreSQL durable queue, Streamable HTTP MCP read-only boundary, and Windows/UE 5.6/Clang/SVN Phase 1 platform.
- Permanent MCP exclusions for code/arbitrary file writes, patch application, commit, push, submit and general shell/command execution.

Verification commands:

```powershell
npm run format:check
npm run lint
```

Results:

- `npm run format:check`: passed; all scanned repository text files met the line-ending, final-newline and whitespace policy.
- `npm run lint`: passed; the repository security-boundary lint reported no forbidden evaluation, misplaced process-execution import or private-key material.

Known limitations:

- No architecture, security, data-owner or operations reviewer has signed these documents; no sign-off is claimed.
- Production network policy, Windows service account, SVN ACL semantics, OIDC settings, provider data terms and secret-store integration require the real environment inputs listed in the development plan.
- Documentation establishes required controls; implementation and executable negative-test evidence remain in their dependent Phase 1 tasks.

Next work: obtain P1-02 human review/sign-off; P1-03 may implement the documented configuration and secret-reference contracts, while independent P1-04 work may continue. Phase 2 remains prohibited until every G1 criterion and signature passes.

## P1-03 — versioned configuration and secret references

Status: implementation complete on 2026-08-27; production secret-store and configuration approval remain external inputs.

Deliverables:

- Closed v1 project, repository, provider, and preset JSON Schemas plus validated YAML examples.
- Dependency-free TypeScript loader for a deliberately restricted YAML subset with duplicate/unknown-field rejection, immutable results, and bounded inputs.
- UE 5.6-only and SVN-only repository rules, HTTPS provider hostname allowlist, and provider data-processing approval gate.
- Opaque `secret://` references only; interpolation, plaintext credential fields, traversal, and secret-valued environment overrides are rejected.
- Typed `reindex`, `ubt_build`, and `uat_test` presets aligned with the database job kinds, with no command, arbitrary arguments, environment, or output path.
- Safe log projection that excludes repository URLs, secret references, and provider payloads.

Verification results:

- P1-03 configuration suite: 10/10 passed.
- Offline installation, full CI, release check, and deterministic build passed with zero third-party dependencies.

Known limitations and inputs:

- The accepted YAML surface is documented and intentionally smaller than full YAML; anchors, aliases, tags, multiple documents, and interpolation are prohibited.
- Production requires the approved secret store/namespace, service identity and rotation policy; no secret-store adapter or credential was fabricated.
- The checked-in SVN/provider examples are disabled `.invalid` placeholders. Real read-only SVN secret references and provider endpoint/model/dimensions/data-processing approval remain required.

Next work: P1-05, P1-06, and P1-16 may consume the validated contracts. Phase 2 remains frozen.

## P1-05 — OIDC, bearer tokens, and ACL policy

Status: dependency-unblocked implementation complete on 2026-08-28; production OIDC, database repository adapters, and security acceptance remain pending.

Deliverables:

- Strict RS256 JWT verification for issuer, audience/authorized party, signature, expiry, not-before, issued-at, key use/operations, minimum RSA size, and duplicate JSON fields.
- Bounded JWKS cache with injected fetcher and key-rotation refresh; verification failures expose one uniform error.
- Bearer token issue, memory-hard scrypt hash with external pepper, authentication, rotation, expiry, and revocation. Only the hash and metadata are repository-facing.
- User/team/service project policy with role thresholds and effective source access equal to current MCP grant intersected with a matching fresh SVN ACL snapshot.
- Fail-closed and non-enumerating responses for disabled/missing principals, projects, repositories, stale ACLs, cross-project IDs, invalid paths, and repository errors.

Verification commands and results:

```powershell
node --test tests/security/auth.test.mjs
npm run ci
```

- P1-05 security suite: 4/4 passed, including wrong issuer/audience/signature/algorithm, expiry, JWKS rotation, bearer rotation/revocation, stale ACL, one-sided grants, traversal, and cross-project denial.
- Full repository CI: 29/29 passed after integration with P1-06 and P1-16.

Known limitations and inputs:

- The repository interfaces use deterministic in-memory test doubles. PostgreSQL adapters and live row/transaction behavior require the P1-04 live database environment.
- Production requires OIDC issuer, audience, claim mapping, approved algorithms, JWKS URI/network policy, token pepper secret reference, and revocation operations. No production identity was fabricated.
- Cross-project leakage is covered at the policy boundary; full API/query-side channel testing remains dependent on P1-15.

Next work: connect these interfaces to P1-15 and production database adapters when their dependencies and inputs are available.

## P1-06 — typed SVN adapter

Status: dependency-unblocked implementation and local synthetic SVN acceptance complete on 2026-08-28; production SVN ACL semantics remain pending.

Deliverables:

- Typed checkout, update, info, log, summarize-diff, status, and ACL snapshot operations using one fixed absolute `svn.exe`.
- Controlled arguments, `--non-interactive`, XML mode for structured outputs, bounded output/time, minimal environment, no shell, and no credential command-line fields.
- Strict bounded XML parser that rejects DTD/entity declarations, unknown entities, duplicate attributes, excess depth/nodes, and malformed documents.
- Repository URL allowlist, workspace root confinement with real-path junction checks, revision pin verification, classified/redacted errors, and bounded telemetry.
- A real local synthetic SVN repository fixture built with TortoiseSVN `svn/svnadmin 1.14.2`.

Verification commands and results:

```powershell
node --test tests/integration/svn-adapter.test.mjs
npm run ci
```

- P1-06 suite: 3/3 passed.
- The integration test performed real import/checkout/log/diff/status/update operations and demonstrated that a revision-1 workspace remained pinned after HEAD advanced to revision 2.
- XML security and typed-command negative tests passed; secret references never entered invocation arguments or telemetry.

Known limitations and inputs:

- `file://` is enabled only by the explicit test option. Production accepts administrator-allowlisted HTTPS or `svn+ssh` roots.
- Local file repositories cannot reproduce the company's server-side authz configuration. Real SVN URL, trunk/stable/release paths, read-only account secret reference, certificate/SSH trust, subject mapping, and ACL change behavior are required for production acceptance.
- ACL probe failures are `indeterminate` unless SVN reports a recognized denial/not-found code; authorization consumers must fail closed.

Next work: P1-07 can build the multi-repository read-only workspace and revision-set manager over this adapter.

## P1-16 — Windows Agent and internal job lease

Status: dependency-unblocked implementation complete on 2026-08-28; real Windows Service installation and PostgreSQL-backed lease acceptance remain pending.

Deliverables:

- Strict internal register/claim/heartbeat/event/complete/fail contracts for UE 5.6, SVN and typed reindex work only.
- Revision-set and resource-policy validation that rejects unknown fields, other VCS kinds, commands, arguments, environment, working directory, and arbitrary output path.
- Attempt-fenced leases, heartbeat extension, event sequencing/idempotency, expired-lease recovery, bounded retry, stale-attempt rejection, and idempotent completion reference coordinator.
- Windows Agent loop with injected short-lived credential provider, transport, clock and typed handler; failure diagnostics are fixed redacted categories.
- HTTPS internal transport with manual redirects, bounded JSON response, origin confinement and separate Agent bearer authentication.
- Windows Service management baseline defaulting to plan-only, exact service name/path confinement, and virtual-account/gMSA-only identity without password input.

Verification commands and results:

```powershell
node --test tests/unit/windows-agent.test.mjs
powershell -NoProfile -Command "[void][ScriptBlock]::Create((Get-Content -LiteralPath 'deploy/windows-service/manage-agent-service.ps1' -Raw))"
npm run ci
```

- P1-16 suite: 4/4 passed for typed contract denial, crash lease recovery, attempt fencing, duplicate completion, handler execution and bounded retries.
- Service script parser validation passed; no service mutation was executed.
- Full repository CI: 29/29 passed.

Known limitations and inputs:

- `LeaseCoordinator` is an executable reference/test double, not a replacement for the P1-04 PostgreSQL `FOR UPDATE SKIP LOCKED` implementation.
- Production requires the signed packaged Agent executable, fixed-device install root, TLS endpoint/certificates, approved service virtual account or gMSA, filesystem ACLs, short-lived credential resolver, and administrator installation rehearsal.
- The development machine service was not installed or changed.

Next work: add the production PostgreSQL coordinator adapter and perform the fixed-device crash/restart/service rehearsal when external inputs are available. Phase 2 remains frozen.

## P1-07 — pinned multi-repository read-only workspaces

Status: dependency-unblocked implementation complete on 2026-08-28; Windows service-account ACL rehearsal with real Engine/project repositories remains pending.

Deliverables:

- Canonical, immutable revision sets for Engine/game/plugin SVN repositories with deterministic SHA-256 identity and credential-free URLs.
- Per-project/per-revision-set workspace isolation, exclusive preparation lock, staging checkout, clean-status/revision verification, and atomic ready-directory publication.
- Existing workspace revalidation before reuse; any mixed/drifted revision or local modification fails closed.
- Best-effort read-only file modes, no source-mutating API, exact-root removal guards, interrupted-staging cleanup, and resumable rebuild from the immutable revision set.
- Repository-independent adapter interface so tests cannot silently replace pinned revisions with current HEAD.

Verification commands and results:

```powershell
node --test tests/unit/workspace-manager.test.mjs
npm run ci
```

- P1-07 suite: 3/3 passed.
- Multi-repository checkouts used exactly the requested revisions; simulated remote HEAD changes did not alter the reusable workspace.
- An injected interruption during the second repository checkout left no published manifest or final workspace.
- Full repository CI: 32/32 passed.

Known limitations and inputs:

- Node file modes are a defense-in-depth marker on Windows, not a substitute for NTFS ACLs. Production requires the dedicated service identity, workspace volume/root and explicit deny-write ACL rehearsal.
- Real Engine/game multi-repository URLs and revision strategy are required to validate externals, server certificates, working-copy size, cleanup time and disk layout.
- The manager allows `file://` revision sets for synthetic tests; production configuration still accepts only the P1-03/P1-06 administrator-allowlisted SVN protocols.

Next work: P1-08 and P1-11 are unblocked at the interface level. P1-08 production acceptance still requires the real UE 5.6 Fork/toolchain and build command.

## P1-11 — UE project, plugin, module, and target model

Status: static parser, synthetic gold tests, and real private-corpus audit complete on 2026-08-28; first-party HT rules parse fully, while third-party helper/base-rule attribution and human gold review remain pending.

Deliverables:

- Non-executing `.uproject`/`.uplugin` JSON normalization for modules, types, loading phases, plugin enables, and current/legacy platform allow/deny lists.
- Bounded C# lexical scanner for `Build.cs`/`Target.cs` that removes comments without executing source and rejects malformed/oversized input.
- Public, private and dynamically loaded module dependencies with precise source path/line/column and normalized nested platform/configuration conditions.
- Target type and `ExtraModuleNames` extraction with conditional provenance.
- Explicit diagnostics for dependency expressions that cannot be statically reduced to literal module names; unsupported logic is not silently invented.
- Bounded, non-executing corpus audit CLI with sanitized root-relative failures, aggregate reason counts, symlink exclusion and no `Content` traversal.
- Real-syntax compatibility for UE descriptor comments/trailing commas/BOMs/source-build associations, repeated names with distinct module entries, unsupported condition diagnostics and C# verbatim-string matching.

Verification commands and results:

```powershell
node --test tests/unit/module-model.test.mjs
node --test tests/unit/module-corpus-audit.test.mjs
npm run ci
npm run release:check
```

- P1-11 synthetic gold suite: 4/4 passed, covering Public/Private/Dynamic dependencies, Win64 and configuration conditions, nested blocks, descriptor compatibility, target modules, comments and malformed input.
- Updated P1-11 parser/audit suites: 9/9 passed. Full repository CI: 47/47 passed; build, boundary lint, permissive-license audit and zero-dependency CycloneDX SBOM generation passed. Release policy passed for `0.1.0`.
- Real corpus after evidence-driven fixes: Engine+HT parsed 3,552/3,705 files (95.87%); HT project parsed 312/357 (87.39%); HT first-party `Source` parsed 16/16 (100%).
- All 45 remaining HT hard failures are third-party plugin helper/platform `.Build.cs` fragments without a direct `ModuleRules` declaration. Computed dependencies and unsupported conditions remain explicit diagnostics.

Known limitations and inputs:

- The parser intentionally does not execute arbitrary C# rules. Helper functions, computed lists and condition forms outside the reviewed static subset are emitted as diagnostics and require the real corpus coverage report.
- The real private Fork/project corpus is now available and audited, but it is from modified/partial working copies and cannot serve as clean pinned-revision G1 evidence.
- Remaining full-scope hard failures are 103 non-direct `ModuleRules` files and 50 non-direct `TargetRules` files. These require helper/base-class attribution or explicit UE reviewer scope decisions; the parser will not execute C# or invent inheritance.
- Named reviewers and approved gold expectations are still required. Detailed results are in `docs/progress/p1-11-real-corpus-audit.md`.

Next work: correlate descriptor/UBT module identities with indirect/helper rule files and obtain UE gold review; feed accepted module results into P1-08/P1-09 only after their gates. Phase 2 remains frozen.

## P1-08 — UE 5.6 compile database acquisition and validation

Status: interface, normalization, synthetic validation, and real-environment preflight complete on 2026-08-28; real generation is blocked by the absent compatible x64 Clang installation, and the 99% TU gate has not run.

Deliverables:

- Typed, workspace-confined UnrealBuildTool `GenerateClangDatabase` invocation for a fixed `UnrealBuildTool.exe`, project, target, Win64 configuration and output path.
- Strict `compile_commands.json` reader supporting `arguments` and Windows command-line representations without invoking a shell.
- Clang/clang-cl-only validation, workspace confinement, duplicate TU rejection, deterministic normalized hashes, output-flag removal, and include/forced-include/macro extraction.
- Explicit, bounded response-file expansion supplied by a workspace-confined caller map; missing, escaping, nested-too-deep or oversized response files fail fast.
- Reproducible TU coverage report separating raw coverage from named/reasoned/risk-documented exemptions and computing the fixed 99% gate without lowering it.
- Fork-verified UBT arguments now include explicit `-OutputFilename=compile_commands.json` and `-NoExecCodeGenActions` so output naming is deterministic and the acquisition step does not run code-generation actions.
- A sanitized real-environment report records the supplied local Engine/project inputs, SVN revision state, Fork version/toolchain requirements, controlled UBT attempt and exact continuation conditions.

Verification commands and results:

```powershell
node --test tests/unit/compile-database.test.mjs
npm run ci
npm run release:check
```

- P1-08 synthetic suite: 6/6 passed for Windows quoting, normalization, macro/include/forced-include extraction, response files, escape/driver/duplicate rejection, coverage accounting and fixed UBT arguments.
- The real UBT executable and `HTEditor Win64 Development` target were reached, then failed closed with `Clang x64 must be installed in order to build this target.` No output directory or compile database was created.
- Fork source/config inspection established minimum Clang `18.1.3`, preferred Clang `18.x`/`19.1.x`, and the suggested Visual Studio component ID `Microsoft.VisualStudio.Component.VC.Llvm.Clang`.
- Full repository CI passed 42/42 tests after the Fork-specific invocation update; build, boundary lint, permissive-license audit and zero-dependency CycloneDX SBOM generation passed. Release policy passed for `0.1.0`.
- No real coverage percentage is claimed because the generator did not produce an artifact.

Known limitations and exact external inputs:

- Received and validated: local Engine/project roots, matching SVN working-copy URLs, UE `5.6.1` Fork, real UBT executable, `HT.uproject`, and an available `HTEditor` target.
- Blocking host input: an x64 Clang accepted by the Fork is not installed in any UBT-discovered location. Installing the Fork-suggested Visual Studio LLVM component is an explicit host mutation and was not performed implicitly.
- Working-copy limitation: Engine reports `24636M`; project reports `85567MP`. Both contain local modifications and the project is partial/sparse, so they may support diagnostics but not clean pinned-revision G1 evidence.
- Transport-policy limitation: the supplied SVN roots use plaintext HTTP, while the approved production configuration accepts only allowlisted HTTPS or `svn+ssh`. No insecure production exception was fabricated.
- Still required: approved clean Engine/project revisions and target matrix/reviewer confirmation before final coverage acceptance.
- Required: a full workspace scan defining the expected TU denominator and named reviewers for any exemption. Synthetic fixture approval names are test data only.
- Detailed evidence and the reproducible command are in `docs/progress/p1-08-real-environment-preflight.md`.

Next work: after a compatible Clang is explicitly installed/provided, rerun the recorded generator command and coverage report. P1-09 production indexing remains blocked by this gate; unrelated Phase 1 work may continue.

## P1-03 — versioned configuration and secret-reference model

Status: implementation complete on 2026-08-27; required architecture/security review and production secret-store/provider/SVN inputs remain pending.

Deliverables:

- Closed project, SVN repository, OpenAI-compatible provider, and administrator preset JSON Schemas at version 1, with corresponding non-production YAML examples.
- Zero-third-party-dependency TypeScript configuration package using a documented restricted YAML subset, strict unknown/duplicate/required-field rejection, bounded input, immutable validated output, and fail-fast error codes.
- Enforced UE `5.6` and SVN-only Phase 1 boundaries; repository URLs cannot carry credentials, and provider endpoints require HTTPS plus an administrator-configured exact hostname allowlist.
- Opaque `secret://<approved-store>/<path>` references as the only credential shape. Plaintext credential fields, interpolation syntax, malformed/traversing references, and secret environment overrides are rejected without echoing values in diagnostics.
- Per-configuration environment override allowlists limited to project status and repository/provider/preset enablement. Unknown `UE_MCP_*` variables fail rather than silently changing behavior.
- Typed reindex/UBT/UAT preset shapes with bounded resource policy and no command, executable, arbitrary arguments, environment, or output path fields.
- Safe logging projection that omits configuration payloads and redacts credential references. Provider enablement additionally requires explicit data-processing approval.
- Production build validation and packaging for Node.js 24 native TypeScript stripping, all v1 Schemas, and all YAML examples. Internal workspace links are excluded from third-party license/SBOM dependency counts.

Verification commands:

```powershell
node --test tests/unit/config.test.mjs
npm ci --offline --ignore-scripts
npm run ci
npm run release:check
```

Results:

- Dedicated P1-03 suite: passed, 10/10 tests, including valid examples and negative tests for schema version, unknown/duplicate fields, UE/VCS restrictions, plaintext/interpolated secrets, endpoint allowlisting, provider approval, command/argument injection, environment overrides, redaction, and unsupported YAML features.
- Offline lockfile install: passed and linked the first-party private config workspace without downloading a package.
- Full repository CI: passed, 18/18 tests; format, lint, build, permissive-license audit, and CycloneDX SBOM generation succeeded.
- Release policy: passed for version `0.1.0`.
- Third-party dependency count remains zero.

Known limitations:

- The dependency-free YAML reader intentionally supports only one document containing indentation-based mappings, sequences, and scalar values. Flow collections, anchors, aliases, tags, merge keys, multiline scalars, odd indentation, and interpolation are rejected; these are deliberate security/operability constraints, not accepted YAML features.
- Example SVN/provider domains are reserved `.invalid` placeholders and both integrations are disabled. No production endpoint, credential, data-processing approval, or secret value is fabricated.
- This task validates and carries opaque secret references but does not implement a production secret-store adapter. That adapter requires the approved store, namespace, service identity, access policy, and rotation contract.
- Provider hostname validation is configuration-time policy. Redirect/DNS/IP enforcement still belongs to the later provider transport implementation and its SSRF tests.
- P1-02 architecture/security/data-owner sign-off is still pending, so global Definition of Done review requirements are not claimed complete.

Next work: obtain P1-02/P1-03 security and architecture review; provide the approved secret-store contract, SVN URLs/read-only identities, and provider endpoint/model/data-processing approval when dependent Phase 1 integrations begin. Continue only dependency-safe Phase 1 work; Phase 2 remains frozen.
