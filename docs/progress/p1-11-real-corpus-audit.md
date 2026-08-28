# P1-11 real Engine and HT corpus audit

- Date: 2026-08-28
- Scope: static, non-executing parsing of UE descriptors and C# rules
- Source state: diagnostic working copies only (`24636M` Engine and `85567MP` project); not clean G1 evidence

The audit emits only aggregate counts and root-relative sample paths. It never executes `Build.cs` or `Target.cs`, traverses symlinks, scans `Content`, or includes absolute roots in the report.

## Reproducible commands

```powershell
node tools/audit-module-corpus.mjs `
  --root F:\ToStar\Engine\Source `
  --root F:\ToStar\Engine\Plugins `
  --root F:\ToStar\Projects\HT

node tools/audit-module-corpus.mjs --root F:\ToStar\Projects\HT
node tools/audit-module-corpus.mjs --root F:\ToStar\Projects\HT\Source
```

## Evidence-driven compatibility changes

The first full run parsed 3,399 of 3,705 relevant files (91.74%). Inspection of representative failures led to narrow parser changes grounded in actual UE syntax:

- UE descriptor comments, trailing commas and UTF-8 BOMs are normalized lexically before strict JSON parsing; no evaluation is used.
- An empty `EngineAssociation` is accepted as the source-built project form and omitted from the normalized model.
- Repeated descriptor module names are allowed when their complete entries differ, such as the same module declared once as `Runtime` and once as `UncookedOnly`; exact duplicate entries remain invalid.
- Conditions containing unsupported string/environment expressions produce `UNSUPPORTED_CONDITION_EXPRESSION` and the explicit `(unsupported)` provenance marker instead of discarding the whole rules file.
- C# verbatim strings with doubled quotes no longer confuse brace/parenthesis matching.

## Final aggregate results

| Scope | Discovered | Parsed | Parse coverage | Hard failures |
|---|---:|---:|---:|---:|
| Engine Source + Engine Plugins + HT | 3,705 | 3,552 | 95.87% | 153 |
| Entire HT project | 357 | 312 | 87.39% | 45 |
| HT first-party `Source` | 16 | 16 | 100% | 0 |

Full-scope diagnostics:

- `DYNAMIC_DEPENDENCY_EXPRESSION`: 386
- `UNSUPPORTED_CONDITION_EXPRESSION`: 102
- 103 `.Build.cs` files do not directly declare a `ModuleRules` class.
- 50 `.Target.cs` files do not directly declare a `TargetRules` class ending in `Target`.

HT results:

- `HT.uproject`, all 12 first-party `Build.cs` files and all four first-party targets now parse.
- The 45 remaining HT failures are under third-party plugin trees and are helper/platform rule fragments that do not directly declare `ModuleRules` (primarily Wwise, plus CRI/Wwise helpers).
- HT first-party diagnostics remain explicit: four computed dependency expressions and five unsupported condition expressions. These require gold-review decisions before production acceptance; they are not silently treated as unconditional dependencies.

## Remaining acceptance work

P1-11 is materially advanced but not declared production-complete. The remaining indirect/helper rule files need descriptor/UBT module correlation and reviewed gold expectations so helper-provided dependencies are attributed to the correct module without executing arbitrary C#. The full Engine `Programs` target aliases also need either supported base-class resolution or an explicit scope/exemption decision by the UE reviewer.

This report is not the P1-08 TU coverage gate. P1-08 remains blocked on the compatible Clang installation, and Phase 2 remains frozen.
