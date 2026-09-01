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

Status: interface, guarded source-tree generation, strict normalization and real Engine+HT coverage audit complete on 2026-08-28; the technical TU gate passed at 29,254/29,255 (99.9966%), while clean pinned-revision evidence and review of one explicit exception remain pending.

Deliverables:

- Typed, workspace-confined UnrealBuildTool `GenerateClangDatabase` invocation for a fixed `UnrealBuildTool.exe`, project, target, Win64 configuration and output path.
- Strict `compile_commands.json` reader supporting `arguments` and Windows command-line representations without invoking a shell.
- Clang/clang-cl-only validation, workspace confinement, exact duplicate-variant rejection, distinct multi-configuration TU preservation, deterministic normalized hashes, output-flag removal, and include/forced-include/macro extraction.
- Explicit, bounded response-file discovery and expansion through an injected reader; workspace escape, missing/NUL/oversized content, count/total-byte limits, excessive nesting and expanded argument overflow fail fast without exposing file contents.
- Reproducible TU coverage report separating raw coverage from named/reasoned/risk-documented exemptions and computing the fixed 99% gate without lowering it.
- Fork-verified UBT arguments include explicit `-OutputFilename=compile_commands.json` and `-NoExecCodeGenActions`; the Fork nevertheless runs UHT during source-target creation, which is recorded as an `Intermediate` side effect.
- Guarded PowerShell acquisition script follows the project's source-Engine convention by temporarily moving `InstalledBuild.txt`, restoring it in `finally`, verifying its SHA-256, rejecting backup collisions and supporting `-WhatIf`.
- Reproducible compile-database audit CLI reporting raw/normalized coverage, response-file bounds, source-root distribution, compiler drivers and extracted-argument coverage.
- A sanitized real-environment report records the supplied inputs, revisions, generation/restoration evidence, full coverage, the single non-Clang action and exact continuation conditions.

Verification commands and results:

```powershell
node --test tests/unit/compile-database.test.mjs
powershell -NoProfile -File tools/generate-ue-compile-database.ps1 -EngineRoot <absolute-engine-root> -ProjectFile <absolute-uproject> -Target <editor-target> -Configuration Development -OutputFile <absolute-compile_commands.json> -TemporarilyDisableInstalledBuild
npm run compile-db:audit -- --database <absolute-compile_commands.json> --workspace-root <absolute-engine-root> --workspace-root <absolute-project-root>
npm run ci
npm run release:check
```

- The project-owned `BuildEditor.bat` confirmed that `InstalledBuild.txt` is an intentional source-tree build switch. The guarded generation removed only that semantic switch, restored its original SHA-256 in `finally`, and UBT completed in 57.02 seconds.
- Full repository CI passed 52/52 tests; build, boundary lint, permissive-license audit, zero-dependency CycloneDX SBOM and release policy all passed.
- Real audit normalized 29,344 Clang actions representing 29,254 of 29,255 unique TUs (`99.99658178089216%`). The fixed technical `>=99%` gate passed.
- Action distribution: Engine 21,155; project 8,189; outside roots 0. All normalized actions yielded include paths, forced includes, definitions and unique hashes.
- The audit loaded 30,546 response files totaling 130,100,892 bytes within calibrated hard limits and preserved 90 distinct multi-variant TUs.
- One generated `VisualStudioDTE/dte80a.cpp` action uses `cmd.exe` to invoke MSVC for type-library output. It is explicitly excluded from Clang normalization with a documented symbol-omission risk and requires named reviewer approval.

Known limitations and exact external inputs:

- Received and validated: local Engine/project roots, matching SVN working-copy URLs, UE `5.6.1` Fork, UBT, `HT.uproject`, `HTEditor`, and accepted VS2022 Clang `19.1.5`.
- Source-tree convention resolved: `InstalledBuild.txt` intentionally suppresses Engine rebuilds for ordinary developers and can be safely toggled with the guarded, hash-verified workflow. It is no longer a technical blocker.
- Working-copy limitation: Engine reports `24636M`; project reports `85567MP`. Both contain local modifications and the project is partial/sparse, so they may support diagnostics but not clean pinned-revision G1 evidence.
- Transport-policy limitation: the supplied SVN roots use plaintext HTTP, while the approved production configuration accepts only allowlisted HTTPS or `svn+ssh`. No insecure production exception was fabricated.
- Still required: approved clean Engine/project revisions, production target matrix and a named UE reviewer decision for the sole `dte80a.cpp` exception.
- Production checkout also requires approved encrypted SVN endpoints/read-only trust and credential references, or an explicit reviewed HTTP policy exception.
- Detailed evidence and the reproducible command are in `docs/progress/p1-08-real-environment-preflight.md`.

Next work: reproduce the guarded generation in a clean P1-07 pinned workspace and obtain the exception/target-matrix reviews. P1-09 production indexing remains governance-blocked until those P1-08 inputs are accepted; unrelated Phase 1 work may continue.

## P1-09 — Clang symbols, locations, documentation, and UHT metadata

Status: dependency threshold satisfied and implementation in progress on 2026-08-29; bounded clang-doc normalization, raw libclang cursor extraction, exact source ranges, UHT metadata extraction and their fail-closed merge are implemented, while production process orchestration, real-corpus execution and reviewer acceptance remain in progress.

Deliverables in this increment:

- Real VS2022 `clang-doc 19.1.5` LibTooling probe over a C++20 gold fixture, proving the available tool emits stable Clang-USR-derived IDs, class/template/function structure, overload separation, documentation and declaration/definition lines.
- Bounded dependency-free clang-doc YAML parser rejecting aliases, tags, tabs, duplicate fields, malformed IDs, excessive depth/size/line counts and unsupported scalar forms.
- Normalized symbol model for namespaces, classes/structs/unions, functions/methods/constructors/destructors, ownership, signatures, deterministic signature hashes, template parameters, documentation, location hints and field-member hints.
- Stable IDs are explicitly encoded as `clang-doc-sha1:<id>` because clang-doc exposes its SHA-1 `SymbolID` derived from the Clang USR, not the raw USR string. No application-generated name hash is represented as a Clang USR.
- Non-executing UHT scanner for `UCLASS`, `UFUNCTION` and `UPROPERTY`, including balanced nested arguments, specifiers, `meta`, Blueprint exposure, declaration names and source lines; comments, strings and preprocessor macro definitions do not create false annotations.
- Declaration-line attachment disambiguates overloaded UFUNCTIONs and reports unmatched/ambiguous annotations instead of silently assigning metadata.
- Gold fixtures cover a documented template, a UCLASS, two documented overloaded UFUNCTIONs and a UPROPERTY.
- A fixed C++20 `libclang` cursor executable emits bounded JSONL for raw Clang USRs, semantic owners, definitions/declarations, exact start/end line and column, fields, macros, types, result types and raw comments. Emission is confined to the configured workspace.
- A typed invocation and strict JSONL reader reject path escapes, unknown fields, conflicting USR records, plugins, executable Clang extensions, output/module-cache options, oversized output and malformed ranges. Anonymous or otherwise unusable identities are validated and counted rather than silently becoming symbols or failing a complete TU.
- The native build script fixes the reviewed source file, output confinement, VS2022 toolset, Windows SDK, clang-c headers/import library and `/W4 /WX`; it provides `-WhatIf` and exposes no arbitrary compiler/source/argument field.
- Raw cursor USRs are correlated to clang-doc using `SHA-1(raw USR)`, exactly matching clang-doc's published SymbolID derivation, but the persisted stable identity remains the raw USR. A mismatch in qualified name or kind fails closed.
- The merge layer combines raw identities and exact cursor ranges with clang-doc documentation/template parameters and declaration-line UHT metadata. Unmatched clang-doc IDs and unmatched/ambiguous UHT annotations remain explicit report fields.
- A bounded no-shell process runner revalidates the complete typed invocation, uses a minimal environment, enforces timeout and combined stdout/stderr limits, supports cancellation, never returns raw stderr in classified failures and rejects Clang error diagnostics by default.

Verification commands and results:

```powershell
node --test tests/unit/symbol-model.test.mjs tests/unit/uht-metadata.test.mjs tests/unit/cursor-stream.test.mjs tests/unit/cursor-runner.test.mjs tests/unit/clang-cursor-native.test.mjs tests/unit/symbol-merge.test.mjs
powershell -NoProfile -File tools/build-clang-cursor-indexer.ps1 -LlvmRoot <VS2022-LLVM-root> -ClangCIncludeRoot <clang-c-include-root> -VcToolsRoot <VS2022-toolset-root> -WindowsSdkRoot <Windows-SDK-root> -WindowsSdkVersion <version>
npm run ci
npm run release:check
```

- P1-09 focused tests: 17/17 passed.
- Full repository CI: 69/69 passed; build, boundary lint, permissive-license audit, zero-dependency CycloneDX SBOM and release policy passed.
- The live clang-doc probe mapped four documentation records and emitted distinct IDs for the two `Gold::UGoldActor::Overload` signatures.
- The native tool built successfully with VS2022 Clang `19.1.5`, MSVC toolset `14.38.33130`, Windows SDK `10.0.22621.0` and the Engine-provided clang-c API header. The rebuild used `/W4 /WX` and produced no diagnostic.
- The live native gold probe exited `0` with zero parse errors and emitted 18 records, 15 distinct raw USRs, two field records, four macro records and two distinct overload USRs. `Gold::UGoldActor` remained the qualified name rather than acquiring a translation-unit path.
- The merged gold set passed for the class, template, overload separation, declaration/definition association, field raw USR, documentation and all four UHT annotations including the previously unresolved UPROPERTY.

Known limitations:

- The native executable and the Engine/VS libclang runtime are not yet packaged. Bundling `libclang.dll` requires explicit Apache-2.0-with-LLVM-exception notices, SBOM representation and reproducible artifact checks; the generated local `dist` binary is not committed.
- The bounded runner is implemented, but it is not yet joined to durable batch/checkpoint orchestration over the normalized P1-08 compile commands. The live probe is engineering evidence, not a claim that the full 29,254-TU corpus has been indexed.
- Cross-TU deduplication, retry/checkpoint behavior, database persistence and a bounded real Engine+HT throughput/memory benchmark remain required.
- The UHT scanner covers the reviewed macro grammar but has not yet been audited over the full private Engine+HT corpus.
- Clean pinned-revision evidence and the named UE review of the P1-08 `dte80a.cpp` exception remain governance prerequisites for production acceptance. No P1-09 completion claim is made in this increment.

Next work: add durable batch/checkpoint orchestration over normalized compile commands, settle compliant libclang runtime packaging, then run a calibrated Engine+HT corpus sample before database persistence and named gold review. Phase 2 remains frozen.

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

## P1-09 increment — durable cursor batches, checkpoints, and cross-TU deduplication

Status: implementation complete on 2026-08-29; compliant native-runtime packaging, calibrated real-corpus sampling, database persistence, and governance acceptance remain pending.

Deliverables:

- A bounded cursor batch orchestrator consumes only P1-08 `NormalizedCompileCommand` records whose deterministic content hashes are revalidated before execution. The compile-database compiler is never executed; every action is rebuilt as a typed invocation of the fixed `clang-cursor-indexer.exe` boundary.
- Batch plans are bound to the immutable revision-set hash, native-tool artifact hash, executable identity, batch size, ordered normalized action hashes, and a deterministic SHA-256 plan hash. Resume fails closed when any of those inputs drift.
- Successful bounded batches are written as immutable, fsynced, rename-published JSON checkpoint shards. Every shard carries a SHA-256 envelope, exact action range/hashes, attempt count, bounded aggregate and contiguous sequence number; missing, reordered, oversized, tampered, foreign, or unexpected checkpoint state is rejected.
- Checkpoint roots must remain below an explicit existing state root and are canonicalized after creation. The design permits only fixed checkpoint filenames and bounded crash-temporary files; it exposes no general file-write or command interface.
- Retry is capped at three attempts and limited to classified process start, timeout, and nonzero-exit failures. Invalid output, diagnostics-policy failures, output-limit failures, plan errors, and semantic conflicts are not retried. A shard is committed only after every action in that batch succeeds.
- Concurrency is explicitly bounded to eight and batch size to 64. Plans are limited to one million actions and 100,000 checkpoint shards.
- Cross-TU merge uses the raw Clang USR as identity, deterministically deduplicates locations and documentation, and retains aggregate diagnostics/unidentified counts. Contradictory qualified names, kinds, owners, signatures, types, result types, or libclang versions fail closed instead of silently merging.
- The build manifest import now validates the new orchestration module. `.gitattributes` was corrected to match the existing repository-wide LF policy and format gate for PowerShell files, so a fresh Windows worktree no longer creates a self-contradictory CI state.

Verification commands and results:

```powershell
node --test tests/unit/cursor-batch.test.mjs
npm run ci
npm run release:check
```

- Focused durable-batch suite: 4/4 passed. It covers restart without repeated successful work, transient-only retry, complete-batch checkpoint publication, plan drift, checkpoint tampering, cross-TU USR conflicts, fixed-executable enforcement, forbidden compiler arguments, and checkpoint-root confinement.
- Full repository CI: 73/73 passed; formatting, security-boundary lint, build, permissive-license audit and zero-dependency CycloneDX SBOM generation passed.
- The existing real synthetic SVN fixture initially failed under the offline sandbox identity with Windows `E720005`; the same dedicated test and full CI passed under the repository-owner execution context. No test threshold or assertion was changed.
- Release policy passed for `0.1.0`.

Known limitations and next work:

- Checkpoints durably retain per-batch normalized cursor aggregates but are not the final PostgreSQL symbol/location persistence layer. P1-04 live database acceptance and the later generation staging contract are still required before database publication.
- The native tool/runtime package hash must come from the compliant, reproducible artifact workflow; no hash is fabricated by orchestration. Runtime packaging must include Apache-2.0-with-LLVM-exception notices and explicit SBOM representation.
- The real Engine/project working copies remain modified/partial diagnostic inputs. They may support a bounded throughput/memory sample but cannot be represented as clean pinned-revision G1 evidence.
- Clean pinned revisions, encrypted SVN policy acceptance, the production target matrix, and named UE review of `dte80a.cpp` remain external governance blockers. Phase 2 remains frozen.

Next work: implement and verify the compliant libclang runtime artifact workflow, then run a calibrated bounded Engine+HT sample when the runtime artifact and diagnostic working-copy safeguards are satisfied.

## P1-09 increment — compliant and reproducible libclang runtime package

Status: technical packaging implementation and live reproducibility evidence complete on 2026-08-29; formal license/release review, signed artifact provenance, calibrated corpus sampling, database persistence, and governance acceptance remain pending.

Deliverables:

- The fixed native build now passes `/Brepro` to both compilation and linking while preserving C++20, `/W4`, `/WX`, the reviewed source file, fixed toolchain roots, and repository-confined output.
- A closed runtime policy pins LLVM Project `libclang` version `19.1.5`, license expression `Apache-2.0 WITH LLVM-exception`, the only accepted runtime relative path, the exact DLL SHA-256, the exact Visual Studio vendor-notice SHA-256, byte limits, and required Clang/Apache/LLVM-exception notice markers.
- The dependency-free packager accepts only four named path inputs, never starts a process or shell, requires the cursor executable to remain under the repository, fixes all output names, refuses an existing output directory, and verifies every binary/notice input before creating output.
- Each runtime directory contains the cursor executable, `libclang.dll`, the complete hash-pinned vendor `ThirdPartyNotices.txt`, a project notice summary, a package-specific CycloneDX 1.5 SBOM, and a deterministic runtime manifest.
- The manifest records sorted file sizes/SHA-256 values, a deterministic `SOURCE_DATE_EPOCH`, and a package artifact hash suitable for P1-09 batch-plan binding. Runtime/notice drift, missing markers, symlinks, oversized inputs, path escape, output collision, malformed policy, and unsupported input shapes fail closed.
- The root license gate and CycloneDX generator now include declared bundled-native components in addition to npm packages. `Apache-2.0 WITH LLVM-exception` is explicitly allowlisted, documented, and represented as an SBOM license expression; the runtime is no longer hidden behind the previous zero-npm-dependency result.
- The normal build copies `THIRD_PARTY_NOTICES.md`; generated native binaries, runtime copies and packages remain under ignored `dist` paths and are not committed.

Verification commands and results:

```powershell
node --test tests/unit/clang-cursor-native.test.mjs tests/unit/native-runtime-package.test.mjs
powershell -NoProfile -File tools/build-clang-cursor-indexer.ps1 <fixed toolchain inputs> -OutputFile <repro-a>
powershell -NoProfile -File tools/build-clang-cursor-indexer.ps1 <fixed toolchain inputs> -OutputFile <repro-b>
npm run native:package -- --runtime-root <VS LLVM x64> --notices-file <VS ThirdPartyNotices.txt> --executable <repro-a> --output-directory <package-a>
npm run native:package -- --runtime-root <VS LLVM x64> --notices-file <VS ThirdPartyNotices.txt> --executable <repro-b> --output-directory <package-b>
npm run ci
npm run release:check
```

- Focused native/package suite: 5/5 passed. It covers fixed reproducible flags, package determinism, hash and notice enforcement, native SBOM/license metadata, path/output confinement, malformed policy, and absence of process/shell execution.
- Two independent builds in different output directories produced identical cursor executable SHA-256 `5a80a720b6f0d4f139d4125e7220598ee2c647bb5707a9630cd7135e06932d3d`.
- Both real packages produced artifact hash `92e081422a74811b4f57bbdd6c8397fa4c30aa1c96cf428df90aedf749e188a5` with pinned `libclang.dll` SHA-256 `097a23f872b1084953e1b0bde6ce36b2d565ebc3b3f1ec296bdcf61538ca581b` and vendor-notice SHA-256 `782815bd1256f9ad798211eee4b0e574ddd113bd07700c6921ab25c591fbcda7`.
- Full repository CI: 76/76 passed; build, formatting, boundary lint, native-aware permissive-license audit, and CycloneDX generation with one declared native dependency passed.
- Release policy passed for `0.1.0`.

Known limitations and next work:

- Hash pinning and notice/SBOM inclusion provide technical compliance controls, not formal legal approval. The packaged runtime and license treatment still require the named release/license reviewer before production distribution.
- Authenticode signing, external provenance/attestation and final installer integration remain P1-18/P3-12 work; no signing identity or trust decision is fabricated here.
- Visual Studio/LLVM upgrades intentionally fail the current policy. Updating a DLL or vendor notice requires an explicit version/hash/license/SBOM review plus repeated binary/package reproducibility evidence.
- The live package used the accepted VS2022 Clang/libclang 19.1.5 environment and ignored `dist` artifacts only. It does not resolve the modified/partial working-copy, clean pinned-revision, HTTP SVN policy, target-matrix, or `dte80a.cpp` reviewer blockers.

Next work: use the reproducible artifact hash in a calibrated, bounded Engine+HT sample run; record throughput, peak working set, diagnostics, retries, deduplication and checkpoint behavior without presenting the diagnostic working copies as clean G1 evidence. Phase 2 remains frozen.

## P1-09 increment — calibrated Engine+HT cursor sample and real-corpus hardening

Status: bounded diagnostic sampling and the associated production-boundary hardening are complete on 2026-08-29; the evidence is explicitly non-G1 because both working copies are modified/partial and the sample uses a diagnostic language profile with a nonzero error allowance. Database persistence, named gold review, clean pinned-revision evidence, and governance acceptance remain pending.

Deliverables:

- Windows command-line limits no longer force large normalized actions onto the process command line. Each action now writes a bounded 8 MiB, newline-delimited, content-addressed argument file below the existing checkpoint state root; the native tool accepts only the fixed `--arguments-file`/`--arguments-root` form, validates the canonical root, size, line grammar and forbidden options, and never invokes a compiler or shell.
- Argument files are immutable, hash-named, atomically published, byte-verified on reuse, and coalesced by content hash when concurrent actions share the same arguments. This closes the real concurrent-rename race found by repeated focused testing.
- P1-08 normalization strips reviewed compiler/PCH write artifacts before orchestration, including object, PDB, dependency, serialized-diagnostic, module-cache/output, saved-temporary and precompiled-header options. `/FI` forced includes remain distinct from `/Fi` preprocessed output.
- The fixed native boundary now returns stable safe exit classes for rejected input, initialization, parse failure/crash/invalid arguments/AST-read failure, record limits and output failure. The runner maps only those classes, redacts raw stderr, and preserves default zero-error diagnostic enforcement.
- A named `ue-msvc-cxx20` diagnostic profile derives include paths, forced includes and definitions from the revalidated normalized command while using the fixed `c++`/C++20/MSVC language baseline. It intentionally omits driver/code-generation/debug flags that libclang's parse API rejected with `CXError_ASTReadError`; the profile name is part of the immutable batch-plan hash and is not silently selected for production.
- The immutable plan hash also binds concurrency, retry count, timeout, output ceiling and diagnostic-error ceiling. A checkpoint produced under the diagnostic 64-error allowance therefore cannot be resumed under the production zero-error default or any other changed execution policy.
- Strict JSONL handling was hardened against real libclang output: bounded multiline documentation is normalized; translation-unit path text and unusable ranges are counted as unidentified rather than persisted as fake identities; division operators remain valid qualified names; empty type/result spellings may be enriched by a nonempty declaration.
- Raw-USR records with contradictory nonempty identity/type metadata, seen for template instantiations in the real corpus, are no longer arbitrarily merged or allowed to fail an otherwise useful TU. The complete ambiguous USR is discarded and every affected record/location is counted as unidentified, both within one TU and across TUs. Compatible raw-USR locations remain deterministically deduplicated.
- The benchmark selector is deterministic, root-balanced, variant-deduplicated and Clang-only. It verifies the exact compile-database SHA-256 and packaged artifact hash, expands only bounded workspace-confined response files, caps sampling at 16 actions per root, concurrency at four, and emits an immutable report labeled `diagnostic-modified-partial-not-g1`.
- The benchmark independently recomputes the runtime artifact hash from the fixed ordered five-file manifest and verifies the size and SHA-256 of the executable, DLL, both notice files and package SBOM before accepting the native tool hash.
- Generated arguments, checkpoints, reports, native binaries and runtime packages remain under ignored paths and are not committed.

Verification commands and results:

```powershell
node --test tests/unit/compile-database.test.mjs tests/unit/cursor-stream.test.mjs tests/unit/cursor-runner.test.mjs tests/unit/cursor-batch.test.mjs tests/unit/cursor-benchmark.test.mjs tests/unit/clang-cursor-native.test.mjs
powershell -NoProfile -File tools/build-clang-cursor-indexer.ps1 <fixed toolchain inputs> -OutputFile <repro-final-a>
powershell -NoProfile -File tools/build-clang-cursor-indexer.ps1 <fixed toolchain inputs> -OutputFile <repro-final-b>
npm run native:package -- <fixed verified inputs for repro-final-a/package-final-a>
npm run native:package -- <fixed verified inputs for repro-final-b/package-final-b>
npm run native:benchmark -- <hash-pinned Engine+HT diagnostic sample inputs>
npm run ci
npm run release:check
```

- Focused compile/cursor/native/benchmark suite: 30/30 passed. Repeating the concurrency-sensitive batch suite three times produced 15/15 passes after argument-file write coalescing.
- Full repository CI: 84/84 passed; formatting, security-boundary lint, build, native-aware permissive-license audit, and CycloneDX generation with one declared native dependency passed. Release policy passed for `0.1.0`.
- Two final independent `/Brepro` builds produced identical executable SHA-256 `e1298d75c2a0e33965caf01aea4b9ce31416f6a989f217a2df1affdcb9eb4896`. Their complete runtime packages both produced artifact hash `0527b0eeffc1ea4dddd801b27f39a7a5487eef4142674e4c5f4a4a1ba6d6ad43`, retaining the pinned libclang and vendor-notice hashes recorded above.
- The final policy-bound two-per-root sample verified compile database SHA-256 `a561f7292bd22b2a28871cc85a0760c93c81cdd8a343304efb351964cab07a8d`, selected four deterministic actions, expanded seven response files/131,723 bytes, and completed in 458,946 ms at one-action concurrency with two checkpoints and four total attempts. Re-running the identical plan from those checkpoints completed in 4,397 ms without increasing the persisted attempt count.
- That four-action diagnostic sample emitted 375 diagnostics including 45 errors, 37,319 unidentified/ambiguous records, 205,757 unique symbols, 153,341 deduplicated symbol records and 160,948 deduplicated locations. The coordinator's in-process peak RSS observation was 1,651,572,736 bytes.
- A separate one-per-root run sampled OS working sets every 100 ms: 240,363 ms for two actions, 187 diagnostics including 22 errors, 14,477 unidentified records and 163,001 unique symbols. Peak coordinator working set was 1,348,239,360 bytes, peak native-child working set was 1,361,555,456 bytes, and the maximum same-sample combined working set was 1,597,394,944 bytes.

Known limitations and next work:

- The diagnostic profile first failed closed when the full normalized driver arguments produced `parse-ast-read-error`; a four-error allowance then failed closed as `diagnostic-errors`. The completed samples used the explicit maximum diagnostic-only allowance of 64 errors per action and observed substantial real parse errors. Production remains default-deny at zero; these results measure behavior and resource bounds, not semantic acceptance.
- The sample is four of 29,344 normalized Clang actions and does not establish full-corpus throughput, memory, correctness or completion. The fixed C++20/MSVC profile must be reviewed against the production target/configuration matrix before it can become an accepted indexing profile.
- The modified/partial Engine and project working copies, intentionally present `InstalledBuild.txt`, HTTP SVN URL, and non-Clang `dte80a.cpp` exception remain diagnostic inputs only. They cannot supply clean pinned-revision or named-reviewer G1 evidence.
- P1-09 still needs final PostgreSQL symbol/location persistence integration and named Engine+project gold review. Formal release/license review, encrypted SVN policy acceptance or an approved exception, clean revisions, the production target matrix, and the named UE reviewer for `dte80a.cpp` remain the external blockers.

Next work: continue P1-09 with bounded transactional database persistence and named-gold comparison using the now checkpointed aggregate contract. Do not widen the diagnostic argument/error profile without review, and do not enter Phase 2 until every technical gate and human G1 sign-off is complete.

## P1-09 increment — bounded transactional symbol persistence

Status: migration, fixed transaction contract, deterministic/idempotent import behavior, and synthetic rollback evidence complete on 2026-08-31; live PostgreSQL+pgvector acceptance remains blocked because this environment has neither `psql` nor a configured disposable test database. Named-gold comparison and governance acceptance remain pending.

Deliverables:

- Migration `0003_p1_09_symbol_persistence` extends the existing Phase 1 schema without rewriting migration `0002`. It preserves `name`, `display_name`, raw `owner_usr`, type/result spellings, template parameters and clang-doc ID in addition to the existing USR, qualified name, kind, signature, exact locations, documentation and UHT/Blueprint metadata.
- `index_generations` now carries an all-or-nothing symbol import marker: checkpoint plan hash, canonical payload hash, symbol/location counts and completion timestamp must be either entirely null or entirely present. The migration is transactional, checksum-tracked and has a targeted down migration.
- The index coordinator exposes a dedicated symbol-persistence subpath with no general SQL or command input. It accepts only an existing generation UUID, revision-set hash, checkpoint plan hash, bounded indexed symbols and explicit source-path-to-file-UUID bindings.
- The import locks one generation row, requires the exact revision set and `building` state, rejects unmarked pre-existing symbol rows, validates every file UUID against that generation, and uses only eight named parameterized SQL statements.
- Symbols, owner links, exact locations and metadata are written in batches capped at 1,000 rows and 8 MiB JSON. The complete generation fingerprint is written last in the same caller-provided transaction; any row-count mismatch or adapter failure aborts the entire import.
- Canonical payload hashing is input-order independent, uses persistent file UUIDs instead of machine-specific absolute roots, sorts symbol/location/UHT metadata deterministically, and rejects duplicate USRs/locations. Windows and POSIX source paths are normalized independently of the coordinator host OS.
- A completed import is idempotently reusable only when plan hash, payload hash and both counts match exactly. Revision, plan, payload, file or dirty-generation drift fails closed. Database adapter errors are reduced to a safe `transaction-failed` class without returning driver details.
- Raw owner USRs whose owner symbol is outside the accepted aggregate remain stored, leave `owner_symbol_id` null, and are explicitly counted as unresolved rather than silently discarded.
- The opt-in destructive migration rehearsal now targets version 3, tests partial-import marker rejection, rolls migration 3 back independently to version 2, then verifies full rollback/re-upgrade. It still refuses databases whose name does not end in `test`.

Verification commands and results:

```powershell
node --test tests/integration/database-migrations.test.mjs tests/unit/symbol-persistence.test.mjs
npm run ci
npm run release:check
```

- Focused migration/persistence suite: 10/10 passed. It covers the version-3 migration contract, full-field persistence, deterministic hashing, owner resolution/unresolved counts, complete rollback, idempotent resume, revision/plan/file/dirty-state drift, duplicate identities/locations, bounded fixed statements and error redaction.
- Full repository CI: 89/89 passed; formatting, boundary lint, build, native-aware license policy and CycloneDX generation with one declared native dependency passed.
- Release policy passed for `0.1.0`.
- `where.exe psql` returned no executable and `PGDATABASE` is unset. No mocked adapter result is represented as live PostgreSQL acceptance.

Known limitations and next work:

- `SymbolPersistenceDatabase` is a narrow transactional port, not a fabricated production connection. The approved PostgreSQL driver/pool, service role, TLS policy, statement timeouts and deployment secrets remain required before wiring the port to production.
- Migration SQL and transaction semantics have static/synthetic evidence only until `npm run db:test:live` runs against a disposable PostgreSQL test database with pgvector. That live run must cover empty upgrade, v2-to-v3 upgrade, v3-only rollback, full rollback and re-upgrade.
- Persistence deliberately does not mark a generation `ready` or publish it. P1-14 staging validation and atomic publication remain separate Phase 1 work and cannot consume this diagnostic corpus as accepted G1 data.
- Modified/partial Engine+HT working copies, HTTP SVN policy, clean pinned revisions, the target matrix and named review of `dte80a.cpp` remain unchanged external blockers.

Next work: implement the P1-09 named-gold comparator and exercise it over the committed synthetic class/template/overload/field/UHT fixture. Run live migration/persistence acceptance only when a disposable PostgreSQL+pgvector test database and approved connection policy are available. Phase 2 remains frozen.

## P1-09 increment — versioned symbol gold comparison and review binding

Status: deterministic synthetic-gold comparison is technically complete on 2026-08-31; named UE reviewer approval and representative clean Engine+project acceptance evidence remain pending, so the comparator deliberately reports acceptance failure.

Deliverables:

- A closed version-1 symbol-gold schema pins 11 reviewed core expectations from the committed C++/clang-doc/UHT fixture: four macros, the namespace, template class and field, UObject-style class, two distinct overloads, and the reflected property.
- Every expectation fixes the raw USR, owner, name/display/qualified name, kind, type/result, normalized documentation, clang-doc ID, template parameters, UHT specifiers/metadata, Blueprint exposure, and exact relative declaration/definition ranges. Absolute, parent-traversing and platform-specific gold paths are rejected.
- The fixture is calibrated to the live VS2022 libclang `19.1.5` probe. Its 18 raw records merge into 15 symbols; the only four permitted extras are location-specific parameter symbols. Any other extra kind fails instead of silently expanding the accepted set.
- The strict parser rejects unknown/missing fields, unsupported versions/exposures, duplicate expectation IDs/USRs/locations, invalid clang-doc IDs, excessive input, malformed paths, and incomplete review records.
- Comparison is keyed by raw USR and fails closed for missing symbols, non-allowlisted extras, or drift in any expected field. It rejects duplicate actual USRs and source locations outside the configured workspace.
- Reports contain only controlled expectation IDs, mismatch codes and field names. Unexpected actual USRs, paths and values are not echoed, so private-corpus identities are not exposed through failure diagnostics.
- Human approval is bound to the canonical expectation payload SHA-256. The current payload hash is `60728f4b37a0d11c7a1b3a66c7364d02967131c690d8132bb1aee725e23436dc`; changing any technical expectation invalidates an older approval automatically.
- The committed fixture intentionally has `review.status = pending` with no fabricated reviewer or timestamp. A perfect technical match therefore produces `technical_pass = true` and `acceptance_pass = false` until a named reviewer signs the exact payload.

Verification commands and results:

```powershell
node --test tests/unit/symbol-gold.test.mjs tests/unit/symbol-merge.test.mjs
npm run ci
npm run release:check
```

- Focused gold/merge suite: 6/6 passed. It covers the exact native capture, clang-doc/UHT merge, allowed parameter extras, approval binding and invalidation, missing/drifted/unexpected symbols, error redaction, and closed-schema negative cases.
- The live ignored native package replay emitted the expected 18 records with zero diagnostics and zero errors before the committed expectations were written; no generated binary was added to Git.
- Full repository CI: 93/93 passed in the repository-owner execution context; formatting, boundary lint, build, native-aware license policy and CycloneDX generation with one declared native dependency passed.
- The first offline-sandbox CI attempt passed 92/93 and reproduced only the known Windows SVN fixture `E720005` ownership failure. The unchanged suite then passed 93/93 under the repository owner; no threshold or assertion was weakened.
- Release policy passed for `0.1.0`.

Known limitations and next work:

- This committed synthetic gold proves comparator behavior and the pinned libclang extraction contract; it is not representative clean Engine+HT correctness evidence and cannot substitute for a named UE reviewer.
- Review approval must name a real reviewer, timestamp the decision and bind the exact payload hash. No approval is inferred from automated tests or from the diagnostic modified/partial corpus sample.
- Live PostgreSQL+pgvector migration/persistence acceptance remains blocked by the absent disposable test database, approved driver/pool, TLS policy and deployment secret contract.
- Modified/partial Engine+HT working copies, the HTTP SVN endpoint policy, clean pinned revisions, the production target matrix, formal native license/release review and named review of `dte80a.cpp` remain unchanged external blockers.

Next work: treat P1-09 technical implementation as complete but not accepted. Continue unblocked Phase 1 work in plan order, while leaving live database rehearsal, representative Engine+project gold approval and all G1 governance items explicitly pending. Phase 2 remains frozen.

## P1-10 increment — bounded relation aggregation foundation

Status: the typed in-memory aggregation boundary is complete on 2026-08-31; native extraction, checkpoint integration, persistence and relation-gold precision/recall evidence remain pending, so no P1-10 acceptance claim is made.

Deliverables:

- A dedicated relation index accepts only versioned shards containing the four extracted symbol-edge kinds in current P1-10 scope: `calls`, `references`, `inherits` and `overrides`. File `include` edges use a separate typed record; arbitrary database edge types are not accepted through this boundary.
- Structural `owns` edges cannot be supplied by an extractor. They are derived at confidence `1` only from the already validated symbol owner USR, preventing an untrusted TU record from inventing ownership.
- Symbol and file edges are deterministically sorted and deduplicated across TU shards. Duplicate semantic evidence retains the highest bounded confidence while exact include evidence collapses by source, destination, line and column.
- Extracted endpoints must resolve to the accepted full symbol set before publication. Unresolved semantic and owner edges are counted separately and discarded without returning their private USRs.
- All optional semantic evidence locations are all-or-none, absolute, bounded and confined below one of at most 64 configured workspace roots. Include source and destination files are both confined; self-includes, path escapes and partial locations fail closed.
- The closed shard/edge contract rejects unknown fields, unknown edge types, duplicate symbol identities, invalid confidence/coordinates, self inheritance/override and self ownership. Inputs are capped at one million shards and eight million records per edge family.
- The normal build imports the new module. It performs no process execution, filesystem writes, SQL or command interpretation.

Verification commands and results:

```powershell
node --test tests/unit/relation-index.test.mjs
npm run ci
npm run release:check
```

- Focused relation aggregation suite: 4/4 passed. It covers ownership derivation, cross-TU duplicate/confidence handling, unresolved-edge redaction, order independence, workspace confinement, closed records, unsupported types, partial evidence and invalid identity relationships.
- Full repository CI: 97/97 passed in the repository-owner execution context; formatting, boundary lint, build, native-aware license policy and CycloneDX generation with one declared native dependency passed.
- Release policy passed for `0.1.0`.

Known limitations and next work:

- The current libclang JSONL protocol still emits symbols only. No synthetic relation is represented as native evidence; the protocol/parser/checkpoint upgrade must be versioned and preserve rejection of mixed or unrecognized records.
- `calls`, `references`, `inherits`, `overrides` and `include` extraction semantics need a committed C++ gold corpus, live libclang `19.1.5` calibration and a review-bound precision/recall evaluator. The required acceptance threshold remains at least 95% for both metrics.
- Relation persistence must resolve accepted USRs and file bindings transactionally against the same generation. This foundation does not write `symbol_edges` or `file_dependencies` and does not mark any generation ready.
- All P1-09 external blockers and global G1 governance blockers remain unchanged. P1-10 work does not authorize Phase 2.

Next work: version the native cursor stream for bounded relation records, add strict parser/checkpoint support and calibrate a committed relation gold for calls/references/inherits/overrides/includes/owns before adding transactional persistence. Phase 2 remains frozen.

## P1-10 increment — versioned relation protocol and durable checkpoint aggregation

Status: the TypeScript protocol/parser and cross-TU checkpoint integration are complete on 2026-08-31; the native C++ emitter, committed relation gold, transactional persistence, live calibration, and named-reviewer acceptance remain pending.

Deliverables:

- Cursor JSONL protocol version 2 adds closed `symbol_edge` records for `calls`, `references`, `inherits`, and `overrides`, plus closed `file_edge` records for `include`. Protocol version 1 remains symbol-only; relation records mixed into v1 are rejected.
- Native records cannot emit `owns`. Unknown edge kinds, unknown fields, partial or escaped evidence, invalid confidence/coordinates, self inheritance/override, self includes, malformed USRs, and unsupported record types fail closed.
- Parsed relation records are normalized into the existing version-1 `RelationShard` contract while the enclosing cursor aggregate remains backward compatible with symbol-only P1-09 checkpoints.
- Relation-shard merging is reusable independently of endpoint resolution. It validates workspace confinement, deterministically sorts and deduplicates semantic/include evidence, and retains the highest confidence for duplicate semantic evidence.
- Cursor batch checkpoints optionally persist a validated relation shard and paired source record counts. Legacy symbol-only checkpoints remain readable; partial relation metadata, mixed relation modes, non-canonical/tampered shards, and incompatible state fail closed.
- Batch reports now expose source and deduplicated counts for both symbol and file edges. Resume preserves the exact report and does not repeat completed native actions.
- Existing P1-10 endpoint resolution and derived ownership behavior remain unchanged: unresolved private USRs are counted without disclosure, and `owns` is derived only after accepted symbol resolution.

Verification commands and results:

```powershell
node --test --test-reporter=spec tests/unit/cursor-stream.test.mjs tests/unit/relation-index.test.mjs tests/unit/cursor-batch.test.mjs
npm run ci
npm run release:check
```

- Focused protocol/relation/checkpoint suite: 19/19 passed. It covers strict v1/v2 separation, edge validation, path confinement, cross-TU deduplication, highest-confidence retention, checkpoint resume, mixed-mode rejection, and paired-count tamper rejection.
- Full repository CI: 100/100 passed; formatting, security-boundary lint, build, native-aware permissive-license audit, and CycloneDX generation with one declared native dependency passed.
- Release policy passed for `0.1.0`.

Known limitations and next work:

- The fixed C++20 libclang executable still emits protocol version 1 symbols only. No relation is represented as native evidence by this increment.
- The next P1-10 increment must implement and calibrate native `calls`, `references`, `inherits`, `overrides`, and `include` emission, while continuing to prohibit native `owns` records.
- A committed C++ relation gold and review-bound evaluator must prove precision and recall of at least 95% without treating automated technical success as named UE reviewer acceptance.
- Any native binary change requires repeated `/Brepro` builds and renewed runtime artifact hash, SBOM, notice, diagnostic sample, and formal release/license review evidence.
- Relation persistence must resolve accepted USRs and file bindings transactionally within the same building generation and must not publish or mark that generation ready.
- All recorded P1-09, clean-revision, encrypted-SVN, production-target-matrix, database, license, reviewer, and global G1 governance blockers remain explicit. Phase 2 remains frozen.

Next work: continue P1-10 from the fixed native emitter and committed relation-gold corpus on the single `codex/phase-1-foundation` development line after repository consolidation. Do not enter Phase 2.

## P1-10 increment — native relation extraction and versioned accuracy gold

Status: native extraction, multi-root protocol invocation, reproducible runtime packaging, synthetic accuracy calibration and real diagnostic-corpus checkpoint replay are technically complete on 2026-08-31. Transactional relation persistence, named UE review and representative clean-revision acceptance remain pending, so P1-10 is not yet accepted.

Deliverables:

- The fixed C++20/libclang executable now emits JSONL protocol version 2. A recursive cursor visitor preserves the enclosing callable and type USRs while extracting `calls`, `references`, `inherits` and `overrides` symbol edges with exact spelling evidence, plus workspace-confined `include` file edges.
- `include` destinations come from `clang_getIncludedFile`, semantic targets come from `clang_getCursorReferenced`, and override targets come from the bounded `clang_getOverriddenCursors` API. Empty/oversized identities, missing coordinates and files outside configured roots are not emitted.
- Native output continues to prohibit `owns`. Ownership remains derived only by the trusted aggregate from accepted symbol `owner_usr` values. A single shared two-million-record cap covers symbols and relations and fails with the existing classified record-limit exit instead of silently truncating output.
- The native CLI and typed Node invocation accept one primary source root plus at most 63 related Engine/project roots. Roots must be absolute, existing and canonically unique; the source must remain below the primary root. Root scope is included in the checkpoint plan hash, so a cross-root policy change cannot reuse stale checkpoints.
- A committed three-file C++ fixture covers nested includes, inheritance, declaration/definition overrides, calls, ordinary references and structural ownership. Its closed version-1 gold contains all 36 final symbol edges and two include edges observed from the live libclang `19.1.5` capture.
- The relation-gold parser rejects unknown/missing fields, paths with absolute/platform/parent traversal syntax, duplicate IDs or identities, unsupported types, partial evidence, malformed review records and thresholds below 95%. The evaluator reports precision and recall, fails confidence drift, caps/redacts mismatch diagnostics and never returns an unexpected private USR or path.
- Review approval is bound to the canonical threshold-and-expectation payload SHA-256 `636a36bc566ab136af05e366bd552bf2f24a26ad2dfcb2a93764c57ba53eaecd`. The committed review remains `pending`; a perfect automated match is technical evidence only and deliberately leaves `acceptance_pass = false`.

Verification commands and results:

```powershell
node --test --test-reporter=spec tests/unit/clang-cursor-native.test.mjs tests/unit/cursor-stream.test.mjs tests/unit/cursor-runner.test.mjs tests/unit/cursor-batch.test.mjs tests/unit/relation-index.test.mjs tests/unit/relation-gold.test.mjs
powershell -NoProfile -File tools/build-clang-cursor-indexer.ps1 <fixed toolchain inputs> -OutputFile <repro-a>
powershell -NoProfile -File tools/build-clang-cursor-indexer.ps1 <fixed toolchain inputs> -OutputFile <repro-b>
npm run native:package -- <fixed verified inputs for repro-a/package-a>
npm run native:package -- <fixed verified inputs for repro-b/package-b>
npm run ci
npm run release:check
```

- Focused native/protocol/checkpoint/relation/gold suites passed 28/28. Full repository CI passed 104/104; build, formatting, security-boundary lint, native-aware permissive-license audit and CycloneDX generation with one declared native dependency passed. Release policy passed for `0.1.0`.
- The packaged executable replayed the committed fixture with zero diagnostics/errors and 16 accepted symbols. Endpoint resolution reported zero unresolved semantic or owner edges; all 38 expected edges matched with precision `1`, recall `1` and no mismatch. Human acceptance correctly remained false.
- Two independent `/Brepro` builds produced identical executable SHA-256 `57ead11018161e2ac7246486eb07e279e99304ee068a84d3ff5345b200d0a987`. Both complete runtime packages produced artifact hash `7f5cd7ab82ef57ba6c56575c8e99a011940bcf202aa25509af69bd69fef6711e`, retaining the pinned libclang and vendor-notice inputs.
- The current compile database has changed to SHA-256 `92bb2d47e9461157d2e5c6a579af7cba38cef37625fb6142f133c55370dd82c6` and contains no independent Engine TU, so the old one-per-Engine/project selection failed closed. A replacement diagnostic-only selection used one deterministic HT `Source` action and one HT plugin action while retaining the Engine and project roots for parsing.
- That modified/partial non-G1 sample completed two actions in 209,911 ms, expanded four response files/69,107 bytes and recorded 70 diagnostics including three errors under the explicit 64-error diagnostic allowance. It produced 66,815 unique symbols, 243,844 source symbol-edge records/229,118 unique edges and 2,644 source include records/2,619 unique edges without reaching the output or record limits.
- Re-running the exact diagnostic plan restored both protocol-v2 checkpoints in 13,139 ms. Attempt count remained two, checkpoint count remained two and no native action was repeated.

Known limitations and next work:

- The committed relation gold is a complete synthetic extraction fixture, not representative clean Engine+project accuracy evidence. A named UE reviewer must inspect and approve the exact payload; the private production corpus needs separately versioned reviewed expectations before the ≥95% gate can be accepted.
- `references` intentionally includes callable-scoped namespace, type, declaration and member references and therefore overlaps call sites with `calls`. This live-calibrated semantic contract must be reviewed before it is treated as the final production query policy; automated gold success does not settle that product decision.
- The real sample is diagnostic evidence only: its working copies are modified/partial, it permits parse errors and its database no longer supplies a balanced Engine TU. It cannot establish clean pinned-revision, production target-matrix, performance or G1 acceptance.
- Relation persistence remains the next P1-10 implementation step. It must atomically resolve accepted symbol USRs and file bindings against the same building generation, persist `symbol_edges` and `file_dependencies`, fingerprint idempotent imports, roll back partial writes and never publish or mark the generation ready.
- Formal native license/release review, live PostgreSQL+pgvector rehearsal, encrypted SVN policy, clean revisions, target-matrix approval, named relation-gold review and all global G1 governance items remain explicit blockers. Phase 2 remains frozen.

Next work: implement bounded transactional relation persistence on the existing single `codex/phase-1-foundation` line, then obtain named review and clean representative accuracy evidence. Do not create another development branch or enter Phase 2.

## P1-10 increment — bounded transactional relation persistence

Status: migration, fixed transaction contract, deterministic/idempotent import behavior and synthetic rollback evidence are complete on 2026-08-31. Live PostgreSQL acceptance, named relation-gold review and representative clean Engine+project evidence remain pending; P1-10 is technically implemented but not formally accepted.

Deliverables:

- Migration `0004_p1_10_relation_persistence` adds an all-or-nothing relation import marker to `index_generations`: plan hash, canonical payload hash, persisted symbol-edge/file-dependency counts and completion timestamp must be entirely null or entirely populated. A second database constraint prohibits a completed relation import before symbol import completion.
- The index coordinator exposes a dedicated relation-persistence port with no general SQL, table, command or path-write input. It accepts one existing generation UUID/revision-set hash/plan hash, one validated final `RelationIndex`, and explicit absolute-path-to-file-UUID bindings.
- The transaction locks the generation, requires exact revision identity, `building` state and completed symbol import, then proves that no managed P1-10 symbol edge or include dependency touching the generation already exists. Other independently managed edge families are not claimed or deleted. Incoming file IDs and every endpoint USR must resolve inside that same generation before any graph row is inserted.
- Seven fixed named parameterized SQL statements perform generation locking, dirty-row counting, file validation, symbol resolution, symbol-edge insertion, include-dependency insertion and final fingerprint completion. Source/destination symbol and file joins independently enforce the generation boundary; short writes fail closed.
- Writes are bounded to 1,000 rows and 8 MiB JSON per batch. The completion marker is written last in the same caller-provided transaction. Any missing binding, cross-generation/missing endpoint, row-count mismatch or adapter exception aborts all writes; adapter details are reduced to one safe `transaction-failed` class.
- Canonical payload hashing is input-order independent and replaces absolute paths with persistent file UUIDs. It binds extraction/deduplication/unresolved provenance counts plus the complete accepted occurrence evidence, including columns and confidence, even though the existing database graph schema stores semantic symbol edges at line granularity and include dependencies by file pair.
- Storage coalescing is explicit and measured: same semantic symbol endpoint/type/file/line occurrences retain the highest confidence, while repeated include occurrences for one source/destination file pair become one dependency. Reports distinguish extracted records, accepted edges, persisted semantic rows, coalesced occurrences and unresolved counts instead of silently claiming every occurrence became a row.
- Empty accepted relation indexes are fingerprinted without fabricated symbol/file lookups. Completed imports are idempotently reusable only when plan hash, full payload hash and both persisted counts match exactly. Plan/payload/revision drift fails closed.
- Relation persistence never changes generation status, publishes a generation or marks it ready. P1-14 staging validation and atomic publication remain separate required work.

Verification commands and results:

```powershell
node --test --test-reporter=spec tests/integration/database-migrations.test.mjs tests/unit/relation-persistence.test.mjs tests/unit/relation-index.test.mjs tests/unit/relation-gold.test.mjs tests/unit/symbol-persistence.test.mjs
npm run ci
npm run release:check
```

- Focused migration/symbol/relation/gold/persistence coverage passed, including completed and empty imports, order-independent hashing, semantic coalescing, idempotent resume, missing symbol/file bindings, symbol-import prerequisite, dirty generation, short writes, rollback, error redaction and malformed input rejected before opening a transaction.
- Full repository CI passed 111/111; formatting, security-boundary lint, build, native-aware permissive-license audit and CycloneDX generation with one declared native dependency passed. Release policy passed for `0.1.0`.
- The destructive live migration rehearsal now targets version 4, statically includes partial relation-marker and relation-before-symbol negative cases, rolls migration 4 back independently to version 3, then continues the existing version-3 rollback/full rollback/re-upgrade sequence.
- `where.exe psql` returned no executable and `PGDATABASE` is unset. No fake adapter result is represented as live PostgreSQL acceptance.

Known limitations and next work:

- `RelationPersistenceDatabase` is a narrow transactional port, not a fabricated production connection. The approved PostgreSQL driver/pool, service role, TLS policy, statement/transaction timeouts and deployment secret contract remain required before production wiring.
- Migration SQL, generation locking, constraints and rollback have static/synthetic evidence only until `npm run db:test:live` runs against a disposable PostgreSQL+pgvector database whose name ends in `test`.
- Exact occurrence columns and repeated include locations remain in checkpoint/gold payloads and their bound hash; the pre-existing Phase 1 database graph intentionally stores line-level symbol evidence and one semantic dependency per file pair. Query evidence policy must preserve this distinction rather than presenting a coalesced graph row as every original occurrence.
- Named review of the exact relation-gold payload, clean pinned Engine+project accuracy evidence, production target/configuration approval, encrypted SVN policy, formal native license/release review and all global G1 governance items remain explicit blockers. Phase 2 remains frozen.

Next work: treat the dependency-unblocked P1-10 implementation as technically complete but not accepted. Continue with the next unblocked Phase 1 dependency path while scheduling live migration rehearsal and named clean-corpus relation review; do not create another development branch or enter Phase 2.

## P1-12 increment — AST-aware chunks, FTS and embedding pipeline

Status: deterministic symbol-aware chunking, FTS-backed transactional storage, provider-neutral batching/cache/retry controls and embedding persistence are technically implemented on 2026-08-31. Live PostgreSQL+pgvector rehearsal, an approved production provider/executor, model-specific ANN validation and representative retrieval evaluation remain pending, so P1-12 is not formally accepted.

Deliverables:

- The Clang indexer converts exact declaration and definition ranges into bounded chunks associated by the same stable USR. Preferred definition locations also anchor normalized documentation chunks. Input source text is injected explicitly; missing files and invalid/empty ranges are counted instead of triggering arbitrary filesystem reads or invented snippets.
- Chunk output is deterministic across symbol/source ordering. Each row carries a SHA-256 stable identity, SHA-256 content hash, estimated provider-neutral token count, exact source coordinates when applicable and deterministic part index/count. Oversized ranges split on lexical segments under configurable byte/token budgets without losing content.
- Migration `0005_p1_12_chunk_persistence` extends `code_chunks` with stable/content hashes, source ranges and split identity, adds generation-scoped stable-key uniqueness, and binds completed chunk imports to an all-or-nothing plan hash/payload hash/count/timestamp marker that requires symbol import completion. Pre-P1-12 rows receive extension-free placeholders and remain dirty/unpublishable until rebuilt.
- The chunk coordinator uses only fixed named parameterized SQL. It locks the building generation, validates exact revision/plan state, proves the target is empty, resolves every used file and stable USR in that same generation, validates stable/content/token fingerprints, inserts bounded batches and records completion last in the same transaction. Replays succeed only for the identical fingerprint; partial, cross-generation, short and adapter-failure paths roll back and return redacted error classes.
- The pre-existing `simple` generated `tsvector` and GIN index provide the Phase 1 lexical/FTS data plane for every inserted chunk. Query fusion/ranking and retrieval evaluation remain P1-13 work; this increment does not misrepresent PostgreSQL FTS as a completed hybrid ranker.
- The provider SDK accepts only an already enabled and data-processing-approved provider configuration. It validates content SHA-256, deduplicates identical content before transfer, enforces item/byte/estimated-token batch bounds, validates finite response dimensions, retries only caller-classified transient failures and opens a bounded circuit breaker.
- Every retry of one batch reuses a deterministic idempotency key. The project UUID is included in cache and idempotency identities, preventing cross-project cache reuse while allowing same-project reuse across generations. Provider request/response bodies remain confined to the injected executor and are never included in pipeline errors or reports.
- A persistent cache adapter reads an existing same-project `chunk_embeddings` row by provider/model/dimensions/content hash and keeps new results in a run-local cache until persistence. Completed content therefore avoids a new provider request; a crash between provider success and database commit relies on the executor transmitting the unchanged provider idempotency key.
- Embedding persistence locks the generation, requires completed chunk import, resolves every stable chunk key and exact content hash, rejects partial prior state, and inserts dimension-checked pgvector rows transactionally. An exact completed replay is read-only. The provider configuration dimension ceiling is now aligned with the database constraint at 16,000.
- No network client, credential resolution, provider endpoint or production approval was fabricated. The executor/cache/database surfaces remain narrow injected ports for later deployment wiring.

Verification commands and results:

```powershell
node --test --test-reporter=spec tests/unit/code-chunking.test.mjs tests/unit/chunk-persistence.test.mjs tests/unit/embedding-pipeline.test.mjs tests/unit/embedding-persistence.test.mjs tests/unit/config.test.mjs tests/integration/database-migrations.test.mjs
npm run ci
npm run release:check
where.exe psql
```

- Focused P1-12/config/migration coverage passed 36/36 before final integration, including declaration/definition/documentation association, deterministic splitting and identity, missing sources, transactional resume/rollback, cache deduplication, project isolation, fixed retry idempotency, circuit breaking, response validation, content drift and redacted failures.
- Full repository CI passed 130/130. Formatting, security-boundary lint, build, native-aware permissive-license audit and CycloneDX generation with one declared native dependency passed. Release policy passed for `0.1.0`.
- The destructive migration rehearsal now targets version 5, exercises partial chunk-marker and chunk-before-symbol constraint failures, rolls migration 5 back independently to version 4 and then performs the existing complete rollback/re-upgrade sequence.
- `where.exe psql` found no executable. The SQL and transaction behavior therefore have static and synthetic evidence only; no fake adapter result is represented as live PostgreSQL acceptance.

Known limitations and next work:

- `EmbeddingBatchExecutor` is a contract, not an approved HTTP client. Production wiring must resolve the configured secret out of process arguments/logs, enforce TLS and the endpoint allowlist, transmit the exact idempotency key in the provider-supported mechanism, apply real timeout/rate policy and prove request bodies never reach telemetry.
- Billing deduplication is guaranteed locally for completed cache entries and duplicate content in one run. Exactly-once billing across an ambiguous network failure additionally depends on the approved provider honoring the stable idempotency key; that behavior requires provider-specific fault-injection evidence and must not be assumed from the interface alone.
- Token counts are conservative provider-independent estimates for storage and batch bounds, not claims about a provider tokenizer. The approved model may require a reviewed tokenizer adapter and recalibrated limits.
- The baseline ANN index covers the configured example's 1,536 dimensions. If an approved provider uses another dimension, a model-specific partial ANN index and live query plan/performance evidence are required; no provider/model choice is fabricated here.
- No clean representative Engine+project chunk corpus, FTS relevance gold, embedding quality evaluation or live provider outage/rate-limit exercise has run. These and all existing P1-09/P1-10/G1 blockers remain explicit. Phase 2 remains frozen.

Next work: keep the single `codex/phase-1-foundation` development line. Treat P1-12 core implementation as technically complete but not accepted; continue with dependency-unblocked P1-13 hybrid retrieval while leaving live database/provider and named corpus review as explicit acceptance work. Do not enter Phase 2.

## P1-13 increment — authorized hybrid retrieval and bounded rerank

Status: the fixed read-only retrieval store, exact/lexical/vector/graph fusion, deterministic diversity packing, optional provider-neutral rerank and a versioned bilingual fusion gold are technically implemented on 2026-08-31. Live PostgreSQL query-plan evidence, production path-ACL wiring, approved query embedding/rerank provider behavior and representative clean-corpus Recall@20 remain pending, so P1-13 is not formally accepted.

Deliverables:

- A retrieval store exposes four fixed named parameterized SQL statements/families for exact symbol-to-chunk lookup, PostgreSQL lexical FTS, pgvector similarity and one-hop graph signals. Callers cannot supply SQL, table names, operators or edge clauses. Query, limit, provider/model/dimension, finite vector, graph direction/type and result fields are strictly bounded; database details are reduced to safe error classes.
- Every statement selects one explicit project/generation only when both project and generation are `active`. It accepts a nonempty trusted repository/path-prefix authorization scope plus an ACL-context hash, joins files back to a repository in the same project and applies path authorization before ranking. Exact and graph symbol hits are hydrated to authorized stable chunks inside SQL, so all four channels return one compatible chunk candidate shape.
- FTS uses `plainto_tsquery('simple')`, `ts_rank_cd` and the existing generated GIN `tsvector`. It is documented as PostgreSQL lexical FTS rank, not BM25. Query strings are NFC-normalized and parameterized.
- Vector lookup is pinned to the server-configured provider/model/dimension profile. The 1,536-dimensional path uses the matching partial HNSW expression and explicit `vector(1536)` casts; other approved dimensions use the bounded generic pgvector path and make no ANN performance claim. Similarity is clamped to a nonnegative candidate score before fusion.
- Graph lookup is one-hop and candidate-bounded. Both anchor and candidate symbols must have an authorized same-generation source location/chunk; non-null edge evidence files must also pass same-project, same-generation path authorization. Edge types and direction come from closed allowlists.
- Weighted reciprocal-rank fusion combines incomparable exact/FTS/vector/graph score scales without adding raw scores. It deduplicates source-local and cross-source stable chunk keys, rejects conflicting identities, preserves complete per-channel rank/score/contribution evidence, uses stable chunk keys for tie breaks and keeps the top exact hit first by default.
- Diversity packing applies independent per-symbol and per-file caps and a final UTF-8 response budget. Disabled zero-weight channels cannot introduce candidates. No total count, arbitrary offset or unbounded snippet package is produced.
- Optional rerank receives only the already authorized and bounded hybrid set. The configured provider must be enabled, data-processing-approved and have a rerank model. Requests have bounded query/item/body sizes, stable project-scoped idempotency keys and safe transient retries. Response keys must exactly match the input set; rerank can only reorder, never add a candidate. Provider/rerank failure preserves the hybrid order and reports a typed degradation.
- A coordinating retrieval function runs mandatory exact+FTS channels, optionally requests vector/graph channels, fuses and packs candidates, applies rerank when configured and returns explicit requested/degraded signal lists. Inactive scope or mandatory lexical failure fails closed; optional dependency outages degrade without exposing underlying request/database/provider bodies.
- The committed six-case English/Chinese fusion gold requires overall, English and Chinese Recall@20 to each be at least 90%. Its parser rejects extensions, weak thresholds, duplicates, unknown cases and incomplete approval. The current deterministic fusion result is 1.0 for all three measures, but review remains `pending`; the canonical payload SHA-256 is `44d008cbda0416c646bd2088c4da30c10338f3e095a668e2bc47fef83af74234` and automated success does not mark acceptance.

Verification commands and results:

```powershell
node --test --test-reporter=spec tests/unit/hybrid-ranking.test.mjs tests/unit/retrieval-store.test.mjs tests/unit/rerank.test.mjs tests/unit/hybrid-retrieval.test.mjs tests/unit/retrieval-gold.test.mjs
npm run ci
npm run release:check
where.exe psql
```

- Focused P1-13 coverage passed 30/30, including deterministic fusion/ties, exact preservation, zero-weight exclusion, source deduplication, identity conflicts, symbol/file diversity, active scope, path authorization contract, fixed embedding profile, 1,536/generic vector paths, graph allowlists, response budget, optional degradation, rerank set integrity/idempotency and bilingual Recall@20/review binding.
- Full repository CI passed 160/160. Formatting, security-boundary lint, build, native-aware permissive-license audit and CycloneDX generation with one declared native dependency passed. Release policy passed for `0.1.0`.
- `where.exe psql` found no executable. SQL syntax, plans, indexes, transaction snapshots and malicious cross-generation/cross-project rows therefore have static/synthetic evidence only; no fake adapter result is represented as live PostgreSQL acceptance.

Known limitations and next work:

- The current `svn_access_snapshots` table has repository/subject/revision scope but no path column, while the policy engine and security model require path-level SVN authorization. The store can enforce a trusted path scope before ranking, but production code cannot yet derive a complete path scope from the database alone. A reviewed external authorization-scope provider or schema migration plus negative live tests is required before P1-13 security acceptance.
- `files` binds a repository but not a repository branch/revision directly. In a generation containing multiple branches of one repository, evidence revision mapping is ambiguous. Production evidence packaging must validate one branch per repository or add an explicit file-to-revision binding before claiming 100% revision accuracy.
- The six-case gold proves parser/evaluator and fusion behavior over deterministic synthetic candidates. It does not prove Chinese semantic retrieval, UE identifier tokenization or production relevance. A named bilingual corpus with actual indexed Engine+project queries, expected stable USR/path/range evidence and an approved provider/model must independently achieve English and Chinese Recall@20 ≥90%.
- The query-vector value is a trusted upstream input pinned to the configured embedding profile. Approved query-embedding HTTP execution, credential/TLS/timeout policy, provider outage capture and end-to-end vector quality remain deployment/integration work.
- Rerank does not create authorization or recover filtered candidates. Exactly-once billing across ambiguous network failure still depends on the approved provider honoring the stable idempotency key.
- P1-14 atomic generation publication is not implemented. The store deliberately sees only `active` generations, so a real end-to-end query cannot pass until P1-14 publishes one. Cursor pagination and MCP response evidence contracts remain P1-15 work.
- No live concurrency/P95/P99, HNSW `EXPLAIN`, timing-side-channel, ACL-reduction or production-scale high-fanout exercise has run. All existing G1, P1-09, P1-10 and P1-12 external blockers remain explicit. Phase 2 remains frozen.

Next work: keep the single `codex/phase-1-foundation` line and implement P1-14 generation staging validation, atomic publication, rollback and GC. This will make the already active-only P1-13 store testable end to end without weakening the recorded ACL/provider/live-database acceptance gates. Do not enter Phase 2.

## P1-14 increment — generation validation, atomic publication, rollback and GC

Status: the fixed generation lifecycle coordinator and migration are technically implemented on 2026-08-31. It creates revision-pinned staging generations, validates a locked completeness snapshot, atomically swaps the project active generation, supports fenced rollback and performs retention-safe two-phase garbage collection. Live PostgreSQL concurrency/query evidence, a production manifest store and exact workspace-manifest-to-database revision-set binding remain pending, so P1-14 is not formally accepted.

Deliverables:

- Migration `0006_p1_14_generation_publication` adds manifest and validation hashes, the approved embedding profile/count, validation and supersede timestamps, monotonic publication fencing and paired GC-claim evidence. New ready/active/superseded writes require validation evidence; superseded and GC-claim states have paired constraints. Existing legacy rows are intentionally covered by `NOT VALID` transition constraints so an upgrade does not invent evidence; production rollout must remediate legacy rows and explicitly validate those constraints.
- An immutable `generation_publication_events` audit table records staged, validated, validation-failed, published, rolled-back, GC-claimed and GC-deleted transitions. It retains the target generation UUID without a deleting foreign key so GC cannot erase its audit identity. Actor, request hash, publication version and previous active generation are written in the same state-changing transaction.
- Staging locks the project row, accepts only an active project, validates a bounded exact revision/branch set against enabled repositories in that project and rejects more than one tracked branch per repository. Generation and revision mapping creation is atomic, replay-safe and rejects a changed mapping for the same revision-set hash.
- Validation locks both project and generation. It requires completed symbol, relation and chunk import markers; exact stored-versus-actual symbol/location/edge/dependency/chunk counts; one selected embedding for every chunk; no content-hash mismatch; at least one revision; one repository per pinned revision; no unresolved index failure; and no cross-generation repository, module, symbol, location, edge, dependency, chunk or evidence binding.
- The validation fingerprint binds the project/generation/revision-set identity, canonical credential-free manifest URI/hash, embedding profile, all import plan/payload hashes and the explicit count/integrity snapshot. Deterministic validation failure leaves the previous active generation untouched, changes only the building target to `failed` and writes a redacted `validation_failed` event in a separate recovery transaction.
- Publication and rollback serialize on the project row and fence every target by `publication_version`. Publication changes the previous active row to superseded and the ready row to active inside one database transaction; any second-step or audit failure rolls the first step back. Rollback requires the exact expected current active generation and a validated, non-GC-claimed superseded target, then performs the inverse atomic swap.
- Every lifecycle statement is fixed, named and parameterized. Runtime requests are closed/bounded, manifest URIs reject credentials/query strings/fragments, adapter rows are validated and database/object-store details are reduced to stable content-safe error codes. Exact staging, validation and publication replays do not duplicate audit events.
- GC is dry-run by default, bounded to 100 rows and can select only old superseded or failed generations. The SQL retains at least the two most recently published valid generations, retains all generations for at least seven days, excludes active/ready/building generations and excludes generations used by a running backup.
- Executing GC requires an explicit UUID operation ID and a typed manifest-store adapter. A first short transaction claims each candidate with a deterministic hash/version and writes `gc_claimed`, preventing rollback. Manifest deletion then runs outside database locks with stable idempotency keys. Only after bounded deletion receipts validate does a second fenced transaction write `gc_deleted` and remove database rows. Object-store failure leaves the claim and all database content for same-operation retry; final database failure leaves an already deleted manifest safely retryable rather than deleting database evidence first.

Verification commands and results:

```powershell
node --test --test-reporter=spec tests/integration/database-migrations.test.mjs tests/unit/generation-publication.test.mjs
npm run ci
npm run release:check
where.exe psql
```

- Focused migration/lifecycle coverage passed 20/20. It covers exact staging/replay, project/repository isolation, completeness and embedding coverage, validation quarantine, stale fencing, publish/replay, publish rollback on injected failure, exact rollback, retention preview, two-phase GC, manifest failure recovery, fixed SQL and error redaction.
- Full repository CI passed 172/172. Formatting, lint, build, permissive-license audit and CycloneDX generation with one declared native dependency passed.
- `where.exe psql` found no executable. Migration execution, `NOT VALID` remediation/validation, row-lock blocking, unique-active enforcement, concurrent publish/rollback/GC schedules and destructive cascade behavior therefore still have static and synthetic evidence only.

Known limitations and next work:

- The workspace revision-set hash is computed from configured logical repository IDs/roles/URLs/revisions, while the database repositories table has UUIDs but no matching logical repository ID. Staging validates the exact database revision mappings but cannot independently reconstruct the workspace hash. Add a durable logical repository identity or persist and verify the canonical workspace manifest before claiming end-to-end revision binding.
- The coordinator validates a supplied manifest hash and uses a typed deletion adapter, but this repository has no production object-store implementation that reads, hashes, deletes and returns provider-backed receipts. Synthetic adapters prove ordering/idempotency only; retention deletion is not operationally accepted.
- Legacy ready/active/superseded rows predating migration 0006 cannot be assigned fabricated validation evidence. Deployment needs an inventory and quarantine/rebuild procedure followed by `VALIDATE CONSTRAINT` for both publication transition constraints.
- Module rows and cross-generation module links are checked, but P1-11 currently has no atomic module import marker/count comparable to symbols, relations and chunks. A generation can therefore prove module isolation but not module-corpus completeness.
- A GC claim deliberately has no unsafe timeout takeover: after an operator loses the operation ID, recovery requires an audited reconciliation against object storage before claim release. The admin recovery workflow remains future operations work.
- No live PostgreSQL, real object-store, high-volume cascade, backup/GC race, P95/P99 or process-crash-between-GC-phases exercise has run. All earlier G1 and P1-09 through P1-13 acceptance blockers remain explicit. Phase 2 remains frozen.

Next work: keep the single `codex/phase-1-foundation` line and proceed to P1-15 MCP protocol/read-only tools only as a technical increment. P1-15 may consume active-only retrieval and lifecycle contracts, but Phase 1 acceptance must remain blocked until the recorded database, ACL, provider, corpus, revision-binding and object-store evidence is complete. Do not enter Phase 2.

## P1-15 increment — stable MCP protocol and read-only tool boundary

Status: the stable MCP protocol core, closed read-only tool contracts, authenticated Streamable HTTP boundary and protocol compatibility tests are technically implemented on 2026-09-01. Production backend adapters, live OAuth/TLS/reverse-proxy integration and an external MCP Inspector run remain pending, so P1-15 is not formally accepted.

Deliverables:

- The protocol implementation negotiates stable MCP revisions `2025-11-25`, `2025-06-18` and `2025-03-26`, returns initialization instructions and advertises only the tools capability. It handles initialization, initialized/cancelled notifications, ping, paginated `tools/list` and `tools/call` through strict JSON-RPC envelopes; batches and ambiguous request/response envelopes fail closed.
- Exactly nine tools are published: `list_projects`, `index_status`, `search_code`, `read_file_excerpt`, `get_symbol`, `find_references`, `trace_calls`, `find_derived_types` and `get_module_dependencies`. Their JSON Schemas are closed and bounded, their annotations are read-only/non-destructive/idempotent/closed-world, and no source write, patch, VCS mutation, reindex, build, executable, shell, command, argument-list or environment surface is present.
- Runtime argument validation independently enforces the published contracts, including UUID/revision/path normalization, repository and edge allowlists, pagination limits, excerpt length, traversal rejection and bounded graph depth/width. Invalid tool arguments are execution errors; unknown tools and malformed requests are protocol errors.
- HMAC-SHA-256 opaque cursors expire within a bounded lifetime and bind the authenticated principal and credential, tool name and canonical request hash. A changed identity, tool, filter, limit, query, signature or expiry is rejected; backend positions remain opaque to clients.
- Tool results provide both structured content and backward-compatible serialized JSON. Success and stable redacted error results conform to the published output schema. Backend items must be bounded JSON objects, response size is capped at 2 MiB and arbitrary adapter/database details never enter results.
- Every recognized tool execution writes a content-safe audit event containing principal, tool, project, request hash and outcome without raw arguments or source. Audit persistence failure fails the response closed.
- The single Streamable HTTP endpoint requires HTTPS resource configuration, exact Host and optional Origin allowlists, bearer authentication and `mcp:read` on every MCP request, plus an injected caller-bound rate limiter and one total deadline. RFC 9728 protected-resource metadata is exposed at the well-known endpoint; authentication challenges reference it.
- POST requires `application/json` and an Accept header containing both `application/json` and `text/event-stream`. Requests receive JSON and notifications receive `202`; this Phase 1 implementation deliberately provides neither SSE nor `Mcp-Session-Id`, and unsupported GET/DELETE requests return `405` rather than fabricating a session transport.
- The HTTP adapter caps request bodies at 1 MiB, rejects malformed UTF-8/JSON, query-bearing endpoint URLs, unsupported protocol versions and invalid Host/Origin/media types. Rate-limit denial returns `429`; limiter outages return a redacted `503`.

Verification commands and results:

```powershell
node --test tests/unit/read-only-tools.test.mjs tests/unit/mcp-cursor.test.mjs tests/compatibility/mcp-protocol.test.mjs tests/compatibility/streamable-http.test.mjs
npm run ci
npm run release:check
```

- Focused contract/cursor/protocol/transport coverage passed 17/17. It covers exact enumeration, negative mutation surfaces, closed inputs, traversal and bounds, caller/query cursor binding, initialization, list pagination, structured/text results, redacted failures, audit failure, Host/Origin/media/version handling, protected-resource discovery, authentication/scope checks and fail-closed rate limiting.
- Full repository CI passed 189/189. Formatting, security-boundary lint, build, permissive-license audit and CycloneDX generation with the existing declared native dependency passed. Release policy passed for `0.1.0`.

Known limitations and next work:

- `ReadOnlyToolBackend` is a deliberately narrow injected port, not a fabricated production adapter. The nine tools are not yet wired to the P1-13 retrieval store, P1-14 lifecycle queries, evidence packaging or fresh ACL-scope provider. Production execution therefore cannot be claimed from protocol tests alone.
- The existing database authorization model still lacks a durable path-level SVN scope, and file rows still lack an unambiguous direct revision binding when one repository contributes multiple branches. The HTTP boundary authenticates and scopes the caller, but the backend must also derive and apply fresh project/repository/path visibility for every request before any live deployment.
- The bearer adapter covers repository-local bearer identities. Live OIDC authorization-server discovery, token audience/resource validation, reverse-proxy header trust, TLS termination, credential rotation and rate-limiter storage/partition behavior require deployment integration and negative tests.
- The implementation is a legal stateless Streamable HTTP subset: it does not provide server-initiated SSE, resumability or MCP session IDs. These are not required for the Phase 1 read-only tools, but any future addition requires explicit lifecycle, replay, disconnect and denial-of-service controls.
- The committed client protocol tests exercise the wire contract directly, but the external MCP Inspector is not installed in this repository and no Inspector session was run. Inspector interoperability must be captured against the deployed authenticated endpoint before formal P1-15 acceptance.
- No live high-concurrency/rate-limit, reverse-proxy smuggling, slow-body, timeout cancellation, audit outage, P95/P99 or production response-size exercise has run. All earlier database, ACL, provider, corpus, revision-binding, object-store and G1 governance blockers remain explicit. Phase 2 remains frozen.

Next work: keep the single `codex/phase-1-foundation` line. Continue with P1-16 Windows Agent/internal lease integration while scheduling the missing P1-15 backend/OAuth/Inspector acceptance work; do not create another development branch or enter Phase 2.

## P1-16 increment — durable Windows Agent leases and service lifecycle boundary

Status: the version-2 internal Agent protocol, PostgreSQL durable lease coordinator, authenticated internal HTTP routes, independent heartbeat watchdog and hash-bound Windows Service management baseline are technically implemented on 2026-09-01. Live PostgreSQL concurrency, a signed packaged Agent, real handler/resource enforcement and fixed-device service rehearsal remain pending, so P1-16 is not formally accepted.

Deliverables:

- Internal Agent registration and claim messages are upgraded to protocol version 2 while reindex job/result schemas remain version 1. Every lease now contains job, Agent, attempt, random UUID fencing token and expiry; old attempts or tokens cannot heartbeat, append events, fail or complete.
- Migration `0007_p1_16_durable_job_leases` adds bounded typed Agent payloads, availability time, durable next-event sequence, lease token, bounded completion manifest, completion/failure attribution and stable last-failure evidence. Existing event sequences are backfilled from `job_events`; migrated running rows receive new tokens and old workers therefore fail closed.
- A partial unique index permits at most one running lease per Agent. Repeated claim after an ambiguous response returns that Agent's existing unexpired lease rather than consuming another queued job.
- Claims run in short fixed parameterized transactions. Expired leases are recovered in batches of at most 1,000 with `FOR UPDATE SKIP LOCKED`; retryable jobs return to the queue after a bounded delay, exhausted jobs become terminal, and the next claim increments the attempt.
- Candidate selection requires an online registered Agent with all Phase 1 indexing capabilities, a validated versioned reindex payload, an available non-cancelled job and no caller-supplied SQL, executable, command, arguments, environment or workspace path.
- Heartbeat, ordered event, completion and failure transitions are conditional on the exact live attempt/token. Event sequence replay is idempotent only for identical redacted fields. Completion is bound to the assigned revision-set hash and records the exact Agent/attempt/manifest; exact completion and failure replay return `already_applied`.
- The internal HTTP endpoint exposes only the six planned POST routes for register, claim, heartbeat, events, complete and fail. It requires an allowlisted Host, rejects browser Origin requests, authenticates every request with a service bearer carrying `agent:work`, binds path and body job IDs, enforces JSON/media/body/deadline bounds and returns content-safe status classes.
- The Windows Agent validates header-safe short-lived tokens and runs an automatic heartbeat watchdog independently of handler progress. Lease loss aborts a cooperative signal; reporting failure during a coordinator outage safely falls back to lease expiry/recovery, and the service loop re-registers after transient transport failure.
- Completion generation IDs are UUIDs and artifact URIs reject empty, `.` and `..` path segments. Manifest/revision hashes remain mandatory before a lease can complete.
- Windows Service install/update accepts only the fixed `UECodebaseMcpAgent` name, verifies approved executable and configuration SHA-256 values, confines both below the install root, rejects reparse points, accepts only the virtual account or a strictly named gMSA and configures two bounded delayed restarts instead of an unlimited crash loop.
- The destructive migration rehearsal was corrected to upgrade, test, independently roll back versions 7 and 6, continue the older rollback chain and re-upgrade to version 7. Static live constraints now reject a queued lease token and succeeded job without a completion manifest.

Verification commands and results:

```powershell
node --test tests/unit/job-lease.test.mjs tests/unit/windows-agent.test.mjs tests/compatibility/internal-job-http.test.mjs tests/security/windows-service.test.mjs tests/integration/database-migrations.test.mjs
powershell -NoProfile -Command "[void][scriptblock]::Create((Get-Content -LiteralPath 'deploy/windows-service/manage-agent-service.ps1' -Raw))"
npm run ci
npm run release:check
```

- Focused migration/lease/Agent/HTTP/service coverage passed 29/29. It covers ambiguous claim replay, bounded crash recovery, attempt/token fencing, independent heartbeat loss, capability checks, event monotonicity, completion/failure idempotency, revision mismatch, malformed durable payload rollback, stable database errors, authentication/media/Host/Origin/path negatives and service hash/account/path/recovery controls.
- The Windows Service script parsed successfully in Windows PowerShell without changing service state.
- Full repository CI passed 205/205. Formatting, security-boundary lint, build, permissive-license audit and CycloneDX generation with the existing declared native dependency passed. Release policy passed for `0.1.0`.

Known limitations and next work:

- The database layer is a fixed transactional port, not an approved PostgreSQL driver/pool. No live row-lock, `SKIP LOCKED`, partial unique-index, ambiguous commit, deadlock, failover or multi-Agent concurrency test has run because `psql` remains unavailable.
- Existing jobs are intentionally not assigned fabricated Agent payloads. A reviewed control-plane enqueue adapter must validate and persist `agent_payload` together with the immutable revision set; legacy succeeded jobs require inventory/rebuild before the `NOT VALID` success-evidence constraint can be validated.
- The pure internal HTTP endpoint is not yet bound to a production listener, reverse proxy, mTLS/network policy or service-role token issuer. The bearer adapter proves the `agent:work` boundary but not deployment identity isolation or rotation.
- Reindex handlers remain injected. The real SVN workspace, compile-database, Clang/module indexing, persistence and generation-publication sequence is not assembled into one production handler, and queue completion deliberately does not activate a generation.
- Timeout, memory and CPU policy values are validated and delivered but are not yet enforced by Windows Job Objects/process-tree termination. Handler cancellation is cooperative; every native subprocess adapter must bind the abort signal and prove that lease loss stops all descendants before production use.
- No signed `ue-codebase-mcp-agent.exe` was produced or installed. The service script verifies staged hashes and configuration but does not provide atomic package replacement/rollback, ACL provisioning, start/ready checks or a non-developer fixed-device rehearsal; these remain P1-18 deployment work.
- No long-poll saturation, retry jitter, per-project fairness/quota, disk-pressure, host reboot, SCM restart, token rotation or P95/P99 exercise has run. P1-17 observability is still required for lease age, retry rate, starvation and Agent health.
- All earlier database, ACL, provider, corpus, revision-binding, object-store, MCP Inspector and G1 governance blockers remain explicit. Phase 2 remains frozen.

Next work: keep the single `codex/phase-1-foundation` line and continue with P1-17 correlation IDs, redacted logging, metrics, traces and audit coverage over MCP and Agent/job paths. In parallel acceptance work, schedule live PostgreSQL multi-Agent fault injection and signed fixed-device service rehearsal; do not enter Phase 2.

## P1-17 increment — redacted observability and correlated audit evidence

Status: a shared content-safe log/trace/metrics boundary, durable correlated audit schema, MCP and Agent/job propagation and a Phase 1 Grafana dashboard are technically implemented on 2026-09-01. Live PostgreSQL migration, collector/Prometheus/Grafana deployment, protected metrics exposure and production load/fault exercises remain pending, so P1-17 is not formally accepted.

Deliverables:

- The shared observability package validates or generates UUID correlation IDs, accepts only exact W3C version-00 `traceparent` values with non-zero identifiers and creates a fresh span at every receiving service boundary. Invalid, duplicated or control-character-bearing carrier headers fail closed.
- Structured logs and spans use one versioned closed record. They contain component, operation, outcome, severity, duration and correlation/trace/span identifiers plus a small allowlist of bounded operational attributes. Authorization, tokens, secret references, actor/job/project IDs, paths, queries, source excerpts, bodies and arbitrary messages are not accepted fields.
- Sink exceptions never trigger a raw console or exception fallback. They are reduced to `ue_codebase_telemetry_dropped_total`; log and trace emission remain best effort while security audit persistence remains fail closed.
- The Prometheus registry exports request counts, operation-duration histograms and dropped-record counts. Metric labels are limited to component, operation and outcome, so identities, correlation data, tools, errors and content cannot create cardinality or disclosure hazards.
- MCP HTTP requests return their correlation and current trace headers. Recognized tool calls pass the observation context to the backend, emit redacted operation telemetry and persist actor, action, project/tool, outcome, request hash, stable error and correlation/trace/span evidence without raw arguments.
- A Windows Agent iteration creates one observation context and propagates it through registration, claim, heartbeat, event, completion and failure HTTP calls. The coordinator creates a receiving span, emits aggregate endpoint outcomes and persists content-safe Agent/job audit records keyed by the request hash and protected resource identity.
- Migration `0008_p1_17_observability_audit` backfills and makes correlation, trace and span identifiers mandatory on audit events, adds optional resource/error evidence and indexes correlation, trace and resource timelines. Its rollback removes only the P1-17 additions, and the destructive rehearsal now rolls version 8 down independently before the existing version chain.
- The fixed parameterized PostgreSQL audit adapter validates all 13 event fields before issuing its single insert statement. Invalid identifiers, content-bearing tool/error fields, malformed hashes and short writes are returned only as `audit persistence failed`.
- The committed Grafana dashboard covers operation rate, failure ratio, P95 duration, telemetry sink drops, aggregate Windows Agent iteration health and Agent/job API outcomes. Its PromQL references only the committed low-cardinality metric labels.
- The operations runbook defines propagation, field exclusions, metrics, 90-day metrics retention, 30-day redacted trace retention and the P1-18 requirement for an authenticated or network-restricted metrics listener plus collector-side allowlists.

Verification commands and results:

```powershell
node --test tests/unit/observability.test.mjs tests/unit/observability-assets.test.mjs tests/unit/windows-agent.test.mjs tests/compatibility/mcp-protocol.test.mjs tests/compatibility/streamable-http.test.mjs tests/compatibility/internal-job-http.test.mjs tests/integration/database-migrations.test.mjs
npm run ci
npm run release:check
where.exe psql
```

- Focused observability, dashboard, migration, MCP, Agent and internal HTTP coverage passed 43/43. It covers carrier continuation/injection, fresh spans, closed telemetry attributes, secret/source canaries, low-cardinality Prometheus output, sink failure, fixed audit SQL, audit outage, job failure and lease-denial audit, Agent iteration behavior and reversible migration evidence.
- Full repository CI passed 216/216. Formatting, security-boundary lint, build, permissive-license audit and CycloneDX generation with the existing declared native dependency passed.
- Release policy passed for `0.1.0`. `where.exe psql` found no executable, so the migration and audit-query limitations below remain explicit.

Known limitations and next work:

- The package provides strict record and export ports, not production OpenTelemetry SDK, Prometheus scrape server or Grafana provisioning. P1-18 must bind them to authenticated/network-restricted listeners and approved collectors without introducing a raw-payload logging fallback.
- The dashboard is statically validated but has not been imported into a live Grafana instance or exercised with production Prometheus data. Alert thresholds, capacity baselines, clock skew and retention enforcement need an operations review.
- The audit migration and fixed insert adapter have static/synthetic evidence only while `psql` is unavailable. Backfill cost, index build duration, write amplification, live rollback and audit-query performance require a representative PostgreSQL rehearsal before acceptance.
- MCP audit and Agent/job audit failure are fail closed at the service boundary, but their injected database port is not yet wired to a production pool. Agent/job mutations remain idempotent so a client can safely retry an ambiguous `503`, but deployment must verify audit failure ordering and transactional expectations under real database faults.
- Metrics currently describe bounded operation rates, outcomes, duration and aggregate Agent health. Queue age, lease age, retry/fairness/starvation, disk pressure and process-resource metrics require approved bounded measurements from the production job database and Windows runtime; identities must never be promoted to metric labels.
- Trace export is best effort and intentionally carries no source-derived payload. End-to-end sampling, collector authentication/TLS, backpressure, exporter shutdown and cross-service clock behavior remain deployment work.
- All earlier database, ACL, provider, corpus, revision-binding, object-store, MCP Inspector, signed Agent and G1 governance blockers remain explicit. Phase 2 remains frozen.

Next work: keep the single `codex/phase-1-foundation` line and continue with P1-18 container/Windows Service deployment baseline, while carrying the recorded P1-17 live PostgreSQL, collector/dashboard and fault-injection acceptance work. Do not enter Phase 2.

## P1-18 handoff checkpoint — internal operations HTTP boundary

Status: P1-18 is in progress, not complete or accepted. Before the task handoff on 2026-09-01, the internal liveness, readiness and protected metrics HTTP boundary was completed as one coherent checkpoint. Compose, TLS reverse proxy, approved control-plane image assembly, Windows Service deployment/rollback verification and a clean fixed-device rehearsal remain for the successor task.

Completed checkpoint:

- `GET /health/live` reports process liveness only and cannot claim dependency readiness.
- `GET /health/ready` calls an injected bounded readiness probe and reduces false, timeout and exceptions to the same content-safe `503 not_ready` response without component or database detail.
- `GET /metrics` requires a distinct injected bearer authorizer intended for `metrics:read`; missing, rejected and unavailable authorization paths fail closed. It exposes only the P1-17 Prometheus registry.
- The operations boundary has an exact three-path GET-only surface, rejects bodies, hostile Hosts, browser Origins and malformed correlation/trace carriers, and returns correlation/trace response headers plus security/cache headers.
- Operations telemetry uses the existing fixed component/operation/outcome metric labels. Health or metrics payloads, credentials and dependency details never become telemetry attributes.

Verification:

```powershell
node --test tests/compatibility/operations-http.test.mjs tests/unit/observability.test.mjs tests/compatibility/mcp-protocol.test.mjs tests/compatibility/streamable-http.test.mjs
npm run ci
npm run release:check
```

- Focused compatibility and observability coverage passed 21/21.
- Full repository CI passed 219/219, including formatting, lint, build, license audit and SBOM generation.
- Docker/Compose and NGINX are not installed on this workstation. No image build, Compose validation, TLS handshake, proxy behavior or fixed-device installation was executed.

Successor task scope, in order:

1. Keep the existing `codex/phase-1-foundation` branch and do not create a worktree or another development branch.
2. Add a digest-required Compose topology without `latest`, with separate edge/data/observability networks and file-mounted secrets. Require an externally approved control-plane image rather than fabricating the still-missing production database/retrieval assembly.
3. Add an exact-version TLS reverse-proxy configuration with request/connection limits, one MiB MCP body cap, bounded timeouts, safe headers, no payload-bearing access log and no public `/metrics` route.
4. Add a non-mutating deployment preflight that checks Docker/Compose availability, image digest pins, certificate/key and secret-file inputs, reparse points and `docker compose config` before any `up` action.
5. Extend the fixed-name Windows Service workflow with signed package verification, start/readiness verification, protected rollback evidence and an explicit approved-previous-release rollback path; preserve the existing hash/path/account/recovery constraints.
6. Add static negative tests and, only on a suitably provisioned fixed device, run the clean installation, TLS, health, restart, update and rollback rehearsal. Record missing production control-plane assembly and device/TLS/account inputs as acceptance blockers, not successes.

Do not mark P1-18 complete until the Compose, reverse-proxy and Windows Service deliverables are committed and the clean fixed-device rehearsal has actual evidence. Do not enter Phase 2.

## P1-18 deployment baseline checkpoint — static deliverables, acceptance still blocked

Status: the digest-required Compose topology, exact-version TLS edge baseline, non-mutating deployment preflight and signed/readiness-verified Windows Service update/rollback workflow were technically implemented on 2026-09-01. Static negative coverage and repository CI pass, but Docker/Compose/NGINX and the required production/device inputs remain unavailable on this workstation. No container, proxy or Windows Service deployment was attempted, so P1-18 remains in progress and is not accepted.

Deliverables:

- `deploy/compose/compose.yaml` has no build path and requires every externally approved image as an exact tag plus `sha256` digest. The checked-in environment example uses `registry.invalid` and all-zero digests deliberately, so it cannot be treated as image approval or started accidentally. In particular, the repository still does not fabricate the missing production control-plane database/retrieval/ACL/audit/object-store assembly.
- The topology publishes only the configurable TLS edge socket, bound to loopback by default. Edge, data and observability are separate internal networks; PostgreSQL, Prometheus, Grafana, the control-plane operations listener and `/metrics` have no host port. TLS material, database inputs, metrics authorization and administrative credentials are file-mounted secrets.
- The Prometheus baseline uses its distinct bearer-token file to scrape the protected internal operations listener. The NGINX edge exposes only MCP POST, protected-resource metadata GET and liveness/readiness GET. It explicitly returns `404` for `/metrics`, disables access logging, limits error output to critical events, rejects content-length and transfer-encoded bodies on all proxied GET routes, preserves application Host validation, erases forwarding chains, and bounds connections, requests, headers, timeouts and the MCP body to one MiB.
- `deploy/compose/preflight.ps1` is non-mutating. It checks Docker/Compose client availability, fully qualified regular-file inputs and their parent paths for reparse points, PEM markers, exact equality between separately approved TLS/secret inputs and environment bindings, the absence of build/latest references, rendered Compose validity and exact non-placeholder digest pins. It has no pull, build, create, start, restart, down or up action.
- The fixed-name Windows Service workflow preserves install-root confinement, hashes, the virtual-account/gMSA boundary and the bounded recovery policy. Install and Update additionally require a valid Authenticode signature from an approved thumbprint, start the service and require exact `ready` from an HTTPS `/health/ready` endpoint within a bounded deadline.
- Update must receive and verify a distinct approved previous release before changing service configuration. Failed new-release readiness triggers restoration and readiness verification of that approved previous release; `Rollback` exposes the same explicit path. Mutating attempts write bounded JSON evidence below the install root in a non-reparse directory whose inherited ACL is removed and restricted to LocalSystem and local Administrators. Evidence excludes configuration content, credentials, tokens and exception text.

Verification commands and results:

```powershell
powershell -NoProfile -Command "$ErrorActionPreference = 'Stop'; [void][scriptblock]::Create((Get-Content -LiteralPath 'deploy/windows-service/manage-agent-service.ps1' -Raw)); [void][scriptblock]::Create((Get-Content -LiteralPath 'deploy/compose/preflight.ps1' -Raw))"
node --test tests/security/deployment-baseline.test.mjs tests/security/windows-service.test.mjs
npm run ci
npm run release:check
```

- Both PowerShell scripts parsed successfully without changing machine or service state. Focused deployment/service static negative coverage passed 8/8.
- Full repository CI passed 225/225, including formatting, security-boundary lint, build, permissive-license audit and CycloneDX generation. Release policy passed for `0.1.0`.
- `Get-Command` confirmed that Docker and NGINX are unavailable. Consequently `docker compose config`, image inspection/pull, NGINX configuration validation, TLS handshake, proxy routing/limits, protected Prometheus scraping and container health behavior were not executed. Static tests are not recorded as runtime deployment evidence.

Acceptance blockers and next work:

- An externally reviewed production control-plane image does not exist yet. It must assemble the real database pool/migrations, current ACL scope, retrieval/generation stores, audit sink, object storage, authenticated public/internal listeners and approved observability exporters before any deployment can be claimed.
- Approved non-placeholder image digests, a trusted certificate/key/hostname, file-secret inputs, metrics credential, service account/host ACLs, a signed Agent package and an independently approved previous Agent release have not been supplied.
- No suitably provisioned clean fixed device is available. Clean installation, TLS and Host/Origin negatives, liveness/readiness, protected metrics, restart/recovery, update failure, explicit rollback, reboot and evidence retention all remain to be rehearsed on that device.
- The earlier live PostgreSQL, MCP Inspector, ACL/provider/corpus/revision/object-store, collector/dashboard, fault-injection and G1 governance blockers remain in force. P1-18 must not be marked complete until the fixed-device rehearsal produces actual reviewed evidence. Phase 2 remains frozen.

Next work: keep the single `codex/phase-1-foundation` line. On a suitably provisioned fixed device, supply only approved immutable images, TLS/secrets, service identity and signed current/previous packages; run preflight before any deployment mutation, then capture the clean install, TLS, health, restart, update and rollback rehearsal. Do not manufacture missing control-plane or device evidence, push the branch, or enter Phase 2.

## P1-18 control-plane approval gate — production assembly still missing

Status: the first deployment-input task was started on 2026-09-01 by inventorying the repository and making external control-plane approval a machine-checked preflight requirement. This is an approval boundary, not a control-plane implementation or image acceptance. No production image, SBOM, provenance or approval record was created, and P1-18 remains in progress.

Inventory findings:

- The repository has no control-plane process entrypoint: there is no production `createServer`/`listen` assembly that binds the MCP and operations ports.
- Workspace packages declare no PostgreSQL driver/pool, object-store client or production telemetry exporter runtime dependency. MCP, retrieval, job, audit and operations components expose strict injected ports, not wired production adapters.
- There is no control-plane Dockerfile, entrypoint or image-build pipeline. Creating an image from the current tree would therefore misrepresent unit-tested boundaries as a deployable production service.

Approval-gate deliverables:

- `control-plane-approval.schema.json` defines a closed version-1 record for the exact image reference, source revision, Node.js version, public/operations ports, approval identity and validity window, SBOM/provenance paths and hashes, and ten required production capabilities.
- An approved record must declare the real database pool, migrations, fresh ACL scope, retrieval backend, generation store, audit sink, object store, authenticated MCP listener, protected operations listener and approved observability exporter as true. Approved records cannot use pending identities, `registry.invalid`, zero image/artifact hashes or a zero source revision.
- `control-plane-approval.example.json` is intentionally pending, uses only zero hashes and declares every capability false. It documents the missing inputs and cannot pass preflight or serve as acceptance evidence.
- Preflight now requires the approval record plus its independently supplied SHA-256. It rejects changed, duplicate-field, expired, pending, placeholder, incomplete or incorrectly typed records; verifies the referenced SBOM and provenance files by hash; and requires both `CONTROL_PLANE_IMAGE` and the rendered Compose model to use the exact case-sensitive approved image reference.

Verification:

```powershell
powershell -NoProfile -Command "$ErrorActionPreference = 'Stop'; [void][scriptblock]::Create((Get-Content -LiteralPath 'deploy/compose/preflight.ps1' -Raw))"
node --test tests/security/deployment-baseline.test.mjs tests/security/windows-service.test.mjs
npm run ci
npm run release:check
```

- Approval schema and example JSON parsed successfully. The preflight script parsed successfully in Windows PowerShell. Focused deployment/service static negative coverage passed 9/9.
- Full repository CI passed 226/226, including formatting, security-boundary lint, build, permissive-license audit and CycloneDX generation. Release policy passed for `0.1.0`.
- Docker and NGINX remain unavailable, so the strengthened preflight, Compose rendering, image inspection, TLS edge and fixed-device workflow were not executed. These static checks are not production image or deployment evidence.

Next work: an externally accountable control-plane owner must implement the missing production entrypoint and adapters, build an immutable image from a reviewed source revision, generate and retain its SBOM and provenance, and obtain an independent time-bounded approval record/hash. Only after those real inputs exist may operations populate `CONTROL_PLANE_IMAGE` and run preflight on the fixed device. Do not convert the pending example, injected test ports or static CI into an approval claim; do not enter Phase 2.

## P1-18 ownership governance checkpoint — solo active, team fail-closed

Status: switchable ownership configuration was added on 2026-09-01. The active `solo` mode names `LIBO` as the personal technical owner and self-approver. This is explicitly self-attested and Phase 1 G1-ineligible; it is not independent control-plane acceptance. The inactive `team` mode is structurally complete but deliberately unconfigured, so no team ownership or approval is claimed.

Deliverables:

- `docs/governance/ownership.json` contains both modes behind one `active_mode` selector. Stable roles cover control-plane technical ownership, security/release approval, deployment operations, fixed-device witnessing and G1 approval.
- Solo roles resolve to the user-confirmed principal `github:losemymind`, display name `LIBO`, risk acceptance `PERSONAL-1`, and `self_attested` assurance. Solo mode cannot become G1 eligible through policy edits.
- Team roles are pre-separated across five GitHub Team principals. Their `UNCONFIGURED` subjects fail validation while team mode is active; readiness requires real organization/team subjects and five distinct identities.
- `tools/validate-ownership.mjs` enforces the closed shape, mode invariants, configured identities and team separation. `npm run governance:check` is part of repository CI, so changing only `active_mode` is sufficient after the one-time team identities are configured.
- Control-plane approval records snapshot `governance_mode`, `assurance_level`, technical owner, approver and risk acceptance. Solo records require explicit self-attestation/risk acceptance; team records require a distinct independent approver. Historical solo approvals are never promoted by a later mode switch.
- The confirmed personal GitHub CODEOWNERS identity is `@losemymind`; no CODEOWNERS rule or host-side branch protection was added implicitly. Future GitHub Teams are still unknown, and repository enforcement must be configured explicitly from verified identities.

Verification:

```powershell
npm run governance:check
node --test tests/security/governance-ownership.test.mjs tests/security/deployment-baseline.test.mjs
npm run ci
```

Acceptance boundary and next work:

- Personal operation may use the active solo mapping, but any approval it issues remains self-attested and cannot satisfy an independent G1 signature.
- Before team activation, replace all five `github-team:UNCONFIGURED/...` principals with real `github-team:<organization>/<team>` subjects, mark them configured, validate while still in solo mode, change only `active_mode` to `team`, validate again, then align CODEOWNERS and branch protection externally.
- This checkpoint does not supply the missing production control-plane assembly, immutable image, SBOM/provenance, fixed-device inputs or rehearsal evidence. P1-18 remains in progress and Phase 2 remains frozen.
