# Dependency license policy

Production and development dependencies must use an approved permissive license: MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, Apache-2.0 WITH LLVM-exception, PostgreSQL, 0BSD, CC0-1.0, or Unlicense.

GPL, AGPL, LGPL, SSPL, BUSL, unlicensed, and unknown dependencies are blocked unless an explicit legal approval is documented before merge. The default is denial. `npm run license:check` enforces the machine-readable allowlist in `tools/license-audit/allowlist.json` for npm and declared bundled-native components. Native binaries additionally require a fixed version/hash policy, complete upstream notices, CycloneDX representation, and reproducible artifact verification.
