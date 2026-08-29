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
