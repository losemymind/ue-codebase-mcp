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
