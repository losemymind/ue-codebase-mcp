# Automated PostgreSQL + pgvector test environment

This Windows-only tool manages one isolated local database used for the Phase 1
live migration and control-plane PostgreSQL checks. It is not a production
installer and does not make the control-plane image deployable.

The manager detects the repository-pinned Node.js/npm versions, WSL 2, firmware
virtualization, Docker Desktop/CLI/engine, its fixed container and its fixed data
volume. `Status` is read-only and does not create its state directory.

## Install

Run the friendly installer and answer `YES` for each missing dependency or
mutating step:

```powershell
npm run env:db:install
```

The tool prefers exact WinGet package IDs. When WinGet is unavailable it uses
the official Node.js 24.18.0 MSI with its fixed SHA-256 and the official Docker
Desktop download with Authenticode verification. Docker Desktop license
acceptance is part of the explicit confirmation. WSL installation can require a
Windows restart; rerun the command after restarting.

The database image is exactly `pgvector/pgvector:0.8.6-pg17`, never `latest`.
The pulled repository digest is recorded in protected state. For pre-approved
test infrastructure, additionally pass the expected lowercase digest:

```powershell
& tools/live-database/install.ps1 `
  -ExpectedImageDigest '<approved-64-hex-sha256>'
```

The container is fixed as `ue-codebase-mcp-postgres-test`, the volume as
`ue-codebase-mcp-postgres-test-data`, the database as
`ue_codebase_mcp_test`, and the host socket as `127.0.0.1:55432`. Password and
DSN files are generated below
`%LOCALAPPDATA%\UECodebaseMcp\live-database`, excluded from Git, and ACL-limited
to the current user and LocalSystem. Secret values are never printed or stored
in `state.json`.

Installation verifies the complete destructive migration/rollback sequence,
reapplies all nine migrations, and runs the non-mutating control-plane database
harness. The bundled `docker-psql.ps1` adapter uses the image's `psql`, accepts
only bounded SELECT commands or repository-owned migration SQL, and avoids a
second host PostgreSQL installation.

Useful commands:

```powershell
npm run env:db:status
npm run env:db:verify
npm run env:db:backup
```

For automation, `-NonInteractive -AcceptInstall` records explicit installation
consent. `-WhatIf` remains available for PowerShell planning. Omitting
`-ExpectedImageDigest` records the digest actually pulled but is not independent
production approval.

## Backup and uninstall

The normal uninstaller treats the Docker volume as user data. If it exists, the
tool asks for a fully qualified backup directory, streams `pg_dump` custom
format directly to a `.partial` file, validates the `PGDMP` header, atomically
renames it, calculates SHA-256 and writes a credential-free JSON manifest before
removing the container or volume:

```powershell
npm run env:db:uninstall
```

Or provide the backup directory directly:

```powershell
& tools/live-database/uninstall.ps1 `
  -BackupDirectory 'D:\Backups\UECodebaseMcp'
```

Skipping backup requires both `-DiscardData` and a second exact interactive
confirmation. Non-interactive deletion additionally requires
`-AcceptDataLoss`. Backup directories must be outside the managed state root and
must not contain reparse points.

Dependencies are retained by default. `-RemoveManagedDependencies` considers
only Node.js or Docker Desktop that this tool installed. Docker Desktop removal
is blocked if any unmanaged container, volume or tagged image exists, because
Docker's uninstaller can destroy all Docker application data. WSL is shared
Windows infrastructure and is never automatically uninstalled.

A protected dependency receipt is written as soon as the tool installs Node.js
or Docker Desktop. It survives an interrupted setup and, when dependencies are
retained, survives database removal. This means the same uninstaller can later
remove only those recorded dependencies even when no managed database remains.
Before use or deletion, fixed-name Docker resources must also carry both of the
manager's ownership labels; an unlabelled or replaced same-name object is
rejected.

```powershell
& tools/live-database/uninstall.ps1 `
  -BackupDirectory 'D:\Backups\UECodebaseMcp' `
  -RemoveManagedDependencies
```

Official references:

- [Docker Desktop installation on Windows](https://docs.docker.com/desktop/setup/install/windows-install/)
- [Docker Desktop uninstall and data warning](https://docs.docker.com/desktop/uninstall/)
- [pgvector installation and Docker images](https://github.com/pgvector/pgvector)
- [WinGet exact package/version installation](https://learn.microsoft.com/windows/package-manager/winget/install)
