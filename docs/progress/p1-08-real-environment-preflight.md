# P1-08 real UE environment evidence

- Date: 2026-08-28
- Scope: controlled source-tree UnrealBuildTool generation, strict response-file normalization, and TU coverage audit
- Result: technical 99% TU threshold passed for the full Engine+HT target; clean pinned-revision and named exemption review remain G1 inputs

Repository URLs are intentionally omitted. The supplied Engine and project URLs were compared with local working-copy metadata and matched; neither URL contained embedded credentials.

## Validated inputs

| Input | Observed value | Result |
|---|---|---|
| Engine | `F:\ToStar\Engine` | UE `5.6.1` source-level SVN working copy; UBT present |
| Project | `F:\ToStar\Projects\HT` | SVN working copy; `HT.uproject` and `HTEditor.Target.cs` present |
| Target | `HTEditor Win64 Development` | Full Engine+project action graph generated successfully |
| Compiler | VS2022 LLVM `clang-cl.exe` `19.1.5` | Within the Fork-preferred `19.1.x` range |
| Database | `Saved\UECodebaseMCP\source-tree\compile_commands.json` | 16,172,097 bytes; SHA-256 `a561f7292bd22b2a28871cc85a0760c93c81cdd8a343304efb351964cab07a8d` |

The older CentOS toolchain at `C:\UnrealToolchains\v22_clang-16.0.6-centos7` is a Linux cross-toolchain and has no Windows `clang-cl.exe`; it is not used for Win64 generation.

## Source-tree Installed Build convention

The project-owned `F:\ToStar\BatchFiles\BuildEditor.bat` intentionally deletes `Engine\Build\InstalledBuild.txt` before compiling the source Engine and recreates it afterward so ordinary programmers do not rebuild Engine modules with every project build.

P1-08 now follows that convention through `tools/generate-ue-compile-database.ps1`, but with stronger recovery guarantees:

- explicit `-TemporarilyDisableInstalledBuild` opt-in;
- fixed UBT mode/arguments with no generic command or argument input;
- marker moved to one adjacent, collision-checked backup;
- UBT runs inside `try/finally`;
- original marker is moved back on success or failure and its SHA-256 is compared;
- `-WhatIf` support, output confinement below the project root and exact `compile_commands.json` naming.

The real run restored the marker with SHA-256 `2F1C37754E38B4AC70A9559FBFBDBD28FEDA47F36BE9CD9E3AD5BC844EE3FEB6` and left no backup file.

Reproducible command:

```powershell
powershell -NoProfile -File tools\generate-ue-compile-database.ps1 `
  -EngineRoot F:\ToStar\Engine `
  -ProjectFile F:\ToStar\Projects\HT\HT.uproject `
  -Target HTEditor `
  -Configuration Development `
  -OutputFile F:\ToStar\Projects\HT\Saved\UECodebaseMCP\source-tree\compile_commands.json `
  -TemporarilyDisableInstalledBuild
```

UBT completed with `Result: Succeeded` in 57.02 seconds. During target creation this Fork still ran UHT and wrote 256 generated files below `Intermediate`, despite `-NoExecCodeGenActions`; it did not modify Engine/project source files. This side effect is retained as an explicit operational limitation.

## Strict normalization and coverage

```powershell
npm run compile-db:audit -- `
  --database F:\ToStar\Projects\HT\Saved\UECodebaseMCP\source-tree\compile_commands.json `
  --workspace-root F:\ToStar\Engine `
  --workspace-root F:\ToStar\Projects\HT
```

Results:

- Raw actions: `29,345`; normalized Clang actions: `29,344`.
- Raw unique TUs: `29,255`; normalized unique TUs: `29,254`.
- TU coverage: `99.99658178089216%`; the fixed `>=99%` technical gate passed.
- Action distribution: Engine `21,155`; project `8,189`; outside configured roots `0`.
- Multi-variant TUs: `90`; these are legitimate distinct module contexts such as `RigLogicLib` and `RigLogicLibTest`. Distinct normalized hashes are preserved; identical duplicate variants still fail.
- Response files: `30,546`, totaling `130,100,892` bytes. The calibrated hard bounds are 50,000 files, 192 MiB total, 16 MiB per file and four nested response levels.
- Every normalized action uses `clang-cl.exe` and yields include paths, forced includes, definitions and a unique content hash.

The one uncovered TU is `Engine/Intermediate/.../VisualStudioDTE/dte80a.cpp`. UBT represents it as `cmd.exe /C dte80a.bat`; the generated batch invokes MSVC `cl.exe` with `dte80a.rsp` and touches generated `.tlh/.tli` type-library outputs. The Clang-only indexer neither executes nor silently unwraps this batch. Risk: symbols originating only in this Visual Studio DTE type-library generation TU may be absent from the Clang index. This is the sole candidate exemption and still requires a named UE reviewer.

The loader never invokes a shell and diagnostics never echo response contents. Workspace escape, unavailable/NUL/oversized content, count/total-byte limits, excessive nesting, non-Clang drivers and identical duplicate variants fail closed.

## Revision and remaining G1 inputs

- Engine working-copy revision: `24636`; `svnversion` returned `24636M`.
- Project working-copy revision: `85567`; `svnversion` returned `85567MP`.
- `M` records local modifications; `P` records a partial/sparse working copy. These are valid real-corpus diagnostics, not clean immutable G1 revision evidence.
- Both supplied repository roots use plaintext HTTP. Production configuration remains restricted to administrator-allowlisted HTTPS or `svn+ssh`; no exception was introduced.

P1-08's technical coverage threshold is now passed. Before P1-09 production indexing and final G1 acceptance, obtain:

1. approved clean Engine/project revisions and reproduce the same guarded generation in a P1-07 pinned workspace;
2. a named UE reviewer decision for the one `dte80a.cpp` exception and its documented risk;
3. the production target matrix;
4. approved encrypted SVN endpoints/read-only trust and credential references, or an explicit reviewed HTTP transport exception.

Phase 2 remains frozen until every G1 item passes and the stage review is signed.
