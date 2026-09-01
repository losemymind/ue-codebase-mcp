# Container deployment baseline

This topology is a deployment boundary, not a production control-plane assembly. It deliberately has no `build` entry. Operators must provide an externally reviewed control-plane image that binds the existing authenticated MCP endpoint on port 8080 and the three-path operations endpoint on port 8081, implements the documented `*_FILE` inputs, contains Node.js for the readiness command, and wires real database, retrieval, ACL, audit, object-storage and collector adapters. The repository does not currently provide or approve that image.

Every image value must include an exact version tag and an approved `sha256` digest. `deployment.env.example` contains intentionally unusable `registry.invalid` references and zero digests so it cannot be mistaken for release approval. Copy it to an access-controlled location outside the checkout and replace every placeholder. Secrets and TLS material are mounted from files; they must not be placed in the environment file or committed.

The control-plane image also requires a separate version-1 approval record conforming to `control-plane-approval.schema.json`. Approval binds the exact image, source revision, Node.js version, listeners, SBOM and provenance hashes, and an explicit closed list of production capabilities. The independently reviewed approval-record SHA-256 must come from the change/approval system; do not calculate and approve it inline during the same preflight. `control-plane-approval.example.json` is intentionally `pending`, binds only zero hashes and declares every production capability false. It is documentation, cannot pass preflight and is not production evidence.

The only published socket is the TLS edge listener, bound to loopback unless an approved internal bind address is supplied. The edge, data and observability networks are separate and internal. PostgreSQL, Prometheus, Grafana, the operations listener and `/metrics` have no host port. Prometheus alone receives the metrics token file and scrapes the protected operations listener. Grafana requires authenticated access through a separately approved administrative path such as a management tunnel; the TLS edge has no Grafana or metrics route.

Run the non-mutating preflight before any independently reviewed deployment action:

```powershell
$secretFiles = @(
  'C:\ProgramData\UECodebaseMcp\secrets\control-plane-database-dsn'
  'C:\ProgramData\UECodebaseMcp\secrets\metrics-bearer-token'
  'C:\ProgramData\UECodebaseMcp\secrets\postgres-password'
  'C:\ProgramData\UECodebaseMcp\secrets\grafana-admin-password'
)
& deploy/compose/preflight.ps1 `
  -ComposeFile C:\approved\compose.yaml `
  -EnvironmentFile C:\approved\deployment.env `
  -ControlPlaneApprovalFile C:\approved\control-plane-approval.json `
  -ExpectedControlPlaneApprovalSha256 '<independently approved 64-hex SHA-256>' `
  -CertificateFile C:\ProgramData\UECodebaseMcp\secrets\tls.crt `
  -PrivateKeyFile C:\ProgramData\UECodebaseMcp\secrets\tls.key `
  -SecretFile $secretFiles
```

Preflight checks the Docker and Compose clients, fully qualified regular-file inputs, reparse points, PEM markers, placeholder/latest images, digest pins and the rendered Compose model. It additionally rejects an expired, pending, changed or incomplete control-plane approval, requires the environment and rendered topology to use the exact approved image, and verifies the separately supplied SBOM and provenance files by hash. It performs no image pull, container creation, service start or other deployment mutation. A successful preflight is not installation evidence.
