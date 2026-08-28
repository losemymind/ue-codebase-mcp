# P1-08 real UE environment preflight

- Date: 2026-08-28
- Scope: read-only inspection and one controlled UnrealBuildTool compile-database generation attempt
- Result: blocked before compile-database generation because a compatible x64 Clang installation is absent

Repository URLs are intentionally omitted from this record. The provided Engine and project URLs were compared with the local working-copy metadata and matched exactly; neither URL contained embedded credentials.

## Validated local inputs

| Input | Observed value | Result |
|---|---|---|
| Shared workspace root | `F:\ToStar` | Engine, project, UBT, project descriptor and requested output can be confined below one root |
| Engine root | `F:\ToStar\Engine` | Exists and is an SVN working copy |
| Project root | `F:\ToStar\Projects\HT` | Exists and is an SVN working copy |
| Project descriptor | `F:\ToStar\Projects\HT\HT.uproject` | Exists |
| Editor target | `HTEditor Win64 Development` | `HTEditor.Target.cs` exists and declares an Editor target |
| UnrealBuildTool | `F:\ToStar\Engine\Binaries\DotNET\UnrealBuildTool\UnrealBuildTool.exe` | Exists and starts successfully |
| Engine version | `5.6.1` | In the approved UE 5.6 family; differs from the repository branch label `5.6.0-release` and must remain visible in evidence |

## SVN evidence

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
- `M` means local modifications are present. `P` means the project working copy is partial/sparse.
- These working copies are useful for toolchain compatibility diagnostics, but they are not acceptable as a clean, immutable G1 revision set.
- Both supplied repository URLs use plaintext HTTP. The current production configuration and SVN adapter admit only administrator-allowlisted HTTPS or `svn+ssh` roots. No security control was relaxed and no HTTP production configuration was created.

## Fork-specific UBT contract

The private Fork source at `GenerateClangDatabase.cs` confirms native support for:

- `-OutputDir=` and `-OutputFilename=`;
- `-NoExecCodeGenActions`, which avoids running UHT/code-generation actions during this acquisition step;
- Clang mode with no PCH and no VFS.

The typed adapter now emits `-OutputFilename=compile_commands.json` and `-NoExecCodeGenActions` explicitly instead of relying on Fork defaults.

The Fork's `Engine\Config\Windows\Windows_SDK.json` declares:

- minimum Clang version `18.1.3`;
- preferred Clang ranges `18.1.3-18.999` and `19.1.0-19.999`;
- Visual Studio component `Microsoft.VisualStudio.Component.VC.Llvm.Clang` in its suggested component list.

UBT searches `C:\Program Files\LLVM`, `LLVM_PATH`, Visual Studio 2022 LLVM directories and the configured AutoSDK. No `clang-cl.exe` was present in those locations, neither `LLVM_PATH` nor `LLVM_CUSTOM_PATH` was defined, and the Visual Studio component query returned no matching installation.

## Controlled generation attempt

Command:

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

Result:

```text
Creating target...
Clang x64 must be installed in order to build this target.

Result: Failed (OtherCompilationError)
```

No output directory or `compile_commands.json` was created. The attempt did not modify source files.

## Exact continuation conditions

1. Install or provide an x64 `clang-cl.exe` accepted by the Fork (minimum `18.1.3`; preferred range above). The Fork itself recommends the Visual Studio component `Microsoft.VisualStudio.Component.VC.Llvm.Clang`. Installing software is a host mutation and was not performed implicitly.
2. Rerun the controlled generator, normalize the real database, sample macros/include paths, scan the Engine/project TU denominator and calculate the fixed 99% coverage gate.
3. For G1 evidence, create fresh read-only checkouts at explicitly approved Engine and project revisions; do not use the modified/partial working copies as acceptance evidence.
4. Provide an approved encrypted SVN transport endpoint (`https://` or `svn+ssh://`). A deliberate HTTP exception would require security/architecture review and corresponding policy changes; it cannot be inferred from the supplied URLs.

P1-09 remains dependency-blocked by P1-08. Phase 2 remains frozen.
