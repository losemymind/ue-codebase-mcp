# Third-party notices

Release artifacts that contain `libclang.dll` include the complete vendor-provided notice file as `THIRD_PARTY_NOTICES.txt` and identify the runtime in their CycloneDX SBOM and runtime manifest.

## LLVM libclang 19.1.5

- Component: LLVM Project `libclang.dll`
- License: `Apache-2.0 WITH LLVM-exception`
- Distribution source: the hash-pinned Visual Studio 2022 LLVM x64 runtime used by the native cursor-indexer build
- Required accompanying material: the hash-pinned Visual Studio `ThirdPartyNotices.txt`, including the Clang notice, Apache License terms, LLVM exception, legacy notices, and bundled third-party notices

The runtime package policy intentionally fails closed if either the DLL or source notice hash changes. A Visual Studio or LLVM update therefore requires explicit license review, SBOM/version updates, reproducibility verification, and a policy change; the packager never substitutes a nearby runtime or notice file.

## Node.js PostgreSQL runtime

The control-plane PostgreSQL boundary uses `pg` 8.23.0 and its locked transitive packages. The reviewed versions and SPDX license identifiers are recorded in `tools/license-audit/notices.json`; repository CI requires that list to match every downloadable npm package in `package-lock.json` exactly.

- MIT: `pg`, `pg-cloudflare`, `pg-connection-string`, `pg-pool`, `pg-protocol`, `pg-types`, `pgpass`, `postgres-array`, `postgres-bytea`, `postgres-date`, `postgres-interval`, and `xtend`.
- ISC: `pg-int8` and `split2`.

Redistributed installations and images must retain the copyright and license files shipped in each npm package. A dependency version, package set or license change requires an explicit notice-policy update, license review, SBOM regeneration and CI approval.
