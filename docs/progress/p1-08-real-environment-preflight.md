# P1-08 real UE environment evidence

- Date: 2026-08-28
- Scope: read-only environment inspection, controlled UnrealBuildTool generation, strict response-file loading, normalization, and coverage audit
- Result: HT target action set normalized at 8,179/8,179 (100%); full Engine+project acceptance remains blocked because this Installed Build emits no Engine source compile actions

Repository URLs are intentionally omitted. The supplied Engine and project URLs were compared with local working-copy metadata and matched; neither URL contained embedded credentials.

## Validated inputs

| Input | Observed value | Result |
|---|---|---|
| Shared workspace | `F:\ToStar` | Engine, project and generated artifacts are confined below the approved diagnostic root |
| Engine | `F:\ToStar\Engine` | UE `5.6.1` SVN working copy; UBT present |
| Project | `F:\ToStar\Projects\HT` | SVN working copy; `HT.uproject` and `HTEditor.Target.cs` present |
| Target | `HTEditor Win64 Development` | UBT action graph generated successfully |
| Compiler | VS2022 LLVM `clang-cl.exe` `19.1.5` | Within the Fork-preferred `19.1.x` range |
| Output | `Saved\UECodebaseMCP\compile_commands.json` | 4,457,407 bytes; SHA-256 `92bb2d47e9461157d2e5c6a579af7cba38cef37625fb6142f133c55370dd82c6` |

The older CentOS toolchain at `C:\UnrealToolchains\v22_clang-16.0.6-centos7` is a Linux cross-toolchain and has no Windows `clang-cl.exe`; it is not used for Win64 generation.

## SVN and revision evidence

Read-only commands:

```powershell
svn info F:\ToStar\Engine
svn info F:\ToStar\Projects\HT
svnversion F:\ToStar\Engine
svnversion F:\ToStar\Projects\HT
```

Results:

- Engine working-copy revision: `24636`; `svnversion` returned `24636M`.
- Project working-copy revision: `85567`; `svnversion` returned `85567MP`.
- `M` records local modifications; `P` records a partial/sparse working copy.
- These working copies are valid for compatibility diagnostics, but not as clean immutable G1 evidence.
- Both supplied repository roots use plaintext HTTP. Production configuration remains restricted to administrator-allowlisted HTTPS or `svn+ssh`; no exception was introduced.

## Controlled generation

The output directory was created under the project's existing `Saved` tree because this Fork's generator does not create it. The source trees were not changed.

```powershell
F:\ToStar\Engine\Binaries\DotNET\UnrealBuildTool\UnrealBuildTool.exe `
  -Mode=GenerateClangDatabase `
  -Project=F:\ToStar\Projects\HT\HT.uproject `
  HTEditor Win64 Development `
  -OutputDir=F:\ToStar\Projects\HT\Saved\UECodebaseMCP `
  -OutputFilename=compile_commands.json `
  -NoExecCodeGenActions `
  -NoMutex `
  -Unattended
```

Result: `ClangDatabase written` and `Result: Succeeded`.

Non-blocking Fork/project diagnostics remained visible:

- Wwise has no `x64_vc160` platform and selected its Null SoundEngine path.
- UBT reported several plugin dependency-declaration warnings.
- `HT.uproject` does not declare the `WorldConditions` plugin although `HTGame` depends on it.

These warnings were not changed because the task is read-only compile-database acquisition, not modification of the private project.

## Strict normalization and samples

Reproducible command:

```powershell
npm run compile-db:audit -- `
  --database F:\ToStar\Projects\HT\Saved\UECodebaseMCP\compile_commands.json `
  --workspace-root F:\ToStar\Engine `
  --workspace-root F:\ToStar\Projects\HT
```

Results:

- Raw/normalized target actions: `8,179/8,179` (`100%` normalization coverage), with 8,179 distinct normalized hashes.
- Response files: 8,366 direct or nested files, 30,550,038 bytes; every path stayed under a configured workspace.
- Compiler: all 8,179 commands use `clang-cl.exe`.
- Every command produced include paths, forced includes and definitions.
- Source roots: Engine `0`; project `8,179`; outside configured roots `0`.

Three deterministic first-party samples covered `CommonDefine` and `Framework`. For each sample, the TU, the first five include paths and up to two forced includes were checked: `22/22` sampled paths existed. The `CommonDefineModule.cpp` sample contained six definitions, including `PLATFORM_EXCEPTIONS_DISABLED=0`, and two existing generated forced includes (`SharedPCH...h` and `Definitions.CommonDefine.h`).

The loader is caller-injected and never invokes a shell. It rejects workspace escapes, unavailable/NUL/oversized files, more than 20,000 unique files, more than 128 MiB total response data, excessive nesting and expanded argument overflow. Diagnostics do not echo response contents.

## Remaining full-scope blocker

`F:\ToStar\Engine\Build\InstalledBuild.txt` is present. The Fork's UBT checks this marker through `Unreal.IsEngineInstalled()` and resolves installed Engine modules as precompiled, so the generated action graph contains no Engine source compilation actions. The Fork's `GenerateClangDatabase` mode writes existing compile actions; `-Include=Engine` only filters those actions and cannot create missing Engine actions.

The marker was not renamed or removed: doing so would mutate the user's Engine working copy and could invalidate installed-build assumptions. No fabricated Engine flags or synthetic compile commands are accepted.

Exact continuation inputs for full G1 evidence:

1. Prefer a clean source-build Engine checkout at an approved pinned revision, without installed-build semantics, plus a clean pinned project checkout. A separate indexing-only source checkout at the same revision is acceptable if reviewed.
2. Provide an approved encrypted SVN endpoint (`https://` or `svn+ssh://`) and read-only credential/trust references so the P1-07 workspace manager can create those clean revision sets. A reviewed HTTP exception would require an explicit security/architecture decision.
3. Confirm the production target matrix and named reviewer for any explicit TU exemptions.

P1-08 is complete for the currently emitted HT action set but not for the full Engine+project scope. P1-09 remains dependency-blocked, and Phase 2 remains frozen.
