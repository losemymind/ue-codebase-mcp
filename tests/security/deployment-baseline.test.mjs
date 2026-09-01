import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [compose, environmentExample, preflight, nginx, prometheus, approvalSchemaText, approvalExampleText] = await Promise.all([
  readFile('deploy/compose/compose.yaml', 'utf8'),
  readFile('deploy/compose/deployment.env.example', 'utf8'),
  readFile('deploy/compose/preflight.ps1', 'utf8'),
  readFile('deploy/reverse-proxy/nginx.conf', 'utf8'),
  readFile('deploy/monitoring/prometheus.yml', 'utf8'),
  readFile('deploy/compose/control-plane-approval.schema.json', 'utf8'),
  readFile('deploy/compose/control-plane-approval.example.json', 'utf8'),
]);
const approvalSchema = JSON.parse(approvalSchemaText);
const approvalExample = JSON.parse(approvalExampleText);

test('Compose consumes only externally approved digest-required images', () => {
  const imageLines = [...compose.matchAll(/^\s+image:\s+(.+)$/gm)].map((match) => match[1]);
  assert.equal(imageLines.length, 5);
  for (const image of imageLines) {
    assert.match(image, /^\$\{[A-Z_]+:\?[^}]+sha256 digest\}$/);
  }
  assert.doesNotMatch(compose, /^\s*build\s*:/m);
  assert.doesNotMatch(compose, /:latest(?:@|\s|$)/i);
  assert.match(environmentExample, /CONTROL_PLANE_IMAGE=registry\.invalid\/approved\/ue-codebase-mcp-control-plane:0\.1\.0@sha256:0{64}/);
  assert.match(environmentExample, /EDGE_PROXY_IMAGE=registry\.invalid\/approved\/nginx:1\.28\.0-alpine3\.21@sha256:0{64}/);
});

test('control-plane approval contract cannot present the repository template as approved', () => {
  assert.equal(approvalSchema.additionalProperties, false);
  assert.deepEqual(approvalSchema.properties.status.enum, ['pending', 'approved']);
  assert.equal(approvalSchema.properties.capabilities.additionalProperties, false);
  assert.equal(approvalSchema.properties.capabilities.required.length, 10);
  assert.equal(approvalSchema.allOf[0].if.properties.status.const, 'approved');
  assert.ok(Object.values(approvalSchema.allOf[0].then.properties.capabilities.properties)
    .every((definition) => definition.const === true));
  assert.equal(approvalExample.status, 'pending');
  assert.match(approvalExample.image_reference, /^registry\.invalid\//);
  assert.match(approvalExample.image_reference, /@sha256:0{64}$/);
  assert.equal(approvalExample.source_revision, '0'.repeat(40));
  assert.equal(approvalExample.sbom_sha256, '0'.repeat(64));
  assert.equal(approvalExample.provenance_sha256, '0'.repeat(64));
  assert.ok(Object.values(approvalExample.capabilities).every((value) => value === false));
});

test('Compose isolates edge, data, and observability and mounts file secrets', () => {
  assert.equal((compose.match(/^\s{2}(?:edge|data|observability):\s*$/gm) ?? []).length, 3);
  assert.equal((compose.match(/^\s{4}internal: true$/gm) ?? []).length, 3);
  assert.equal((compose.match(/^\s{4}ports:\s*$/gm) ?? []).length, 1);
  assert.match(compose, /EDGE_BIND_ADDRESS:-127\.0\.0\.1/);
  assert.match(compose, /control-plane:[\s\S]+?- edge[\s\S]+?- data[\s\S]+?- observability/);
  assert.match(compose, /prometheus:[\s\S]+?metrics_bearer_token[\s\S]+?- observability/);
  assert.match(compose, /control_plane_database_dsn:\s*\n\s+file: \$\{CONTROL_PLANE_DATABASE_DSN_FILE:\?/);
  assert.match(compose, /source: edge_tls_private_key[\s\S]+?mode: 0400/);
  assert.doesNotMatch(compose, /^\s{4}network_mode:\s*host/m);
});

test('TLS edge is bounded, content-safe, and has no public metrics route', () => {
  assert.match(nginx, /access_log off;/);
  assert.match(nginx, /error_log \/dev\/stderr crit;/);
  assert.match(nginx, /ssl_protocols TLSv1\.2 TLSv1\.3;/);
  assert.match(nginx, /limit_conn_zone/);
  assert.match(nginx, /limit_req_zone/);
  assert.match(nginx, /location = \/mcp \{[\s\S]+?client_max_body_size 1m;[\s\S]+?proxy_read_timeout 30s;/);
  assert.match(nginx, /location = \/health\/live/);
  assert.match(nginx, /location = \/health\/ready/);
  assert.match(nginx, /map "\$content_length:\$http_transfer_encoding" \$request_has_body/);
  assert.equal((nginx.match(/if \(\$request_has_body\) \{ return 413; \}/g) ?? []).length, 3);
  assert.doesNotMatch(nginx, /client_max_body_size 0;/);
  assert.match(nginx, /client_header_buffer_size 1k;/);
  assert.match(nginx, /large_client_header_buffers 2 8k;/);
  assert.match(nginx, /location = \/metrics \{\s*return 404;\s*\}/);
  assert.doesNotMatch(nginx, /\$request_uri|\$request_body|\$http_authorization/);
  assert.doesNotMatch(compose, /3000:3000|8081:8081|9090:9090/);
  assert.match(prometheus, /credentials_file: \/run\/secrets\/metrics_bearer_token/);
});

test('deployment preflight is non-mutating and rejects unsafe inputs before deployment', () => {
  assert.match(preflight, /Get-Command -Name docker -CommandType Application/);
  assert.match(preflight, /docker compose version/);
  assert.match(preflight, /docker compose --env-file \$resolvedEnvironment -f \$resolvedCompose config --quiet/);
  assert.match(preflight, /config --images/);
  assert.match(preflight, /IsPathFullyQualified/);
  assert.match(preflight, /FileAttributes\]::ReparsePoint/);
  assert.match(preflight, /EnvironmentFile TLS bindings must match/);
  assert.match(preflight, /secret bindings must exactly match/);
  assert.match(preflight, /ExpectedControlPlaneApprovalSha256 must not be a placeholder/);
  assert.match(preflight, /ControlPlaneApprovalFile hash did not match the independently approved value/);
  assert.match(preflight, /status -ne 'approved'/);
  assert.match(preflight, /Every required control-plane capability must be explicitly approved/);
  assert.match(preflight, /CONTROL_PLANE_IMAGE must exactly match the independently approved image reference/);
  assert.match(preflight, /Assert-ArtifactHash -Path \$resolvedSbom/);
  assert.match(preflight, /Assert-ArtifactHash -Path \$resolvedProvenance/);
  assert.match(preflight, /BEGIN CERTIFICATE/);
  assert.match(preflight, /PRIVATE KEY/);
  assert.match(preflight, /registry\\\.invalid/);
  assert.match(preflight, /EndsWith\(\('0' \* 64\)\)/);
  assert.doesNotMatch(preflight, /docker\s+compose[^\r\n]*\s(?:up|pull|push|build|create|start|restart|down)\b/i);
  assert.doesNotMatch(preflight, /Start-Process|Remove-Item|Copy-Item/);
});
