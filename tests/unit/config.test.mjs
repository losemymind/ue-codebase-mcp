import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ConfigError,
  applyEnvironmentOverrides,
  loadConfig,
  loadConfigFile,
  safeConfigForLog,
} from '../../packages/config/src/index.ts';

const examples = {
  project: 'configs/examples/project-v1.yaml',
  repository: 'configs/examples/repository-v1.yaml',
  provider: 'configs/examples/provider-v1.yaml',
  preset: 'configs/examples/preset-v1.yaml',
};

async function example(name) {
  return readFile(examples[name], 'utf8');
}

function expectConfigError(action, code) {
  assert.throws(action, (error) => error instanceof ConfigError && error.code === code);
}

test('all versioned YAML examples load and are deeply immutable', async () => {
  const loaded = await Promise.all(Object.values(examples).map((path) => loadConfigFile(path)));
  assert.deepEqual(loaded.map((config) => config.schema), [
    'ue-codebase-mcp/project',
    'ue-codebase-mcp/repository',
    'ue-codebase-mcp/provider',
    'ue-codebase-mcp/preset',
  ]);
  assert.ok(loaded.every(Object.isFrozen));
  assert.ok(loaded.filter((config) => 'credential' in config).every((config) => Object.isFrozen(config.credential)));
});

test('configuration versions and unknown fields fail fast', async () => {
  const valid = await example('project');
  expectConfigError(() => loadConfig(valid.replace('version: 1', 'version: 2')), 'CONFIG_SCHEMA_INVALID');
  expectConfigError(() => loadConfig(`${valid}unexpected_field: true\n`), 'CONFIG_UNKNOWN_FIELD');
  expectConfigError(() => loadConfig(valid.replace('slug: yihuan', 'slug: yihuan\nslug: duplicate')), 'CONFIG_DUPLICATE_FIELD');
});

test('only UE 5.6 and SVN repositories are accepted', async () => {
  const project = await example('project');
  const repository = await example('repository');
  expectConfigError(() => loadConfig(project.replace("ue_version: '5.6'", "ue_version: '5.5'")), 'CONFIG_SCHEMA_INVALID');
  expectConfigError(() => loadConfig(repository.replace('kind: svn', 'kind: git')), 'CONFIG_SCHEMA_INVALID');
});

test('repository credentials accept secret_ref only and diagnostics do not echo secret material', async () => {
  const repository = await example('repository');
  const plaintext = repository.replace('secret_ref: secret://corp-vault/svn/yihuan-engine-readonly', 'password: SUPER_SECRET_CANARY');
  let caught;
  try {
    loadConfig(plaintext, { source: 'repository-test.yaml' });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ConfigError);
  assert.equal(caught.code, 'CONFIG_UNKNOWN_FIELD');
  assert.doesNotMatch(caught.message, /SUPER_SECRET_CANARY/);
  expectConfigError(
    () => loadConfig(repository.replace('secret://corp-vault/svn/yihuan-engine-readonly', '${SVN_PASSWORD}')),
    'CONFIG_INTERPOLATION_FORBIDDEN',
  );
  expectConfigError(
    () => loadConfig(repository.replace('secret://corp-vault/svn/yihuan-engine-readonly', 'secret://corp-vault/svn/../admin')),
    'CONFIG_SECRET_REF_INVALID',
  );
});

test('provider endpoint is HTTPS, administrator allowlisted, and approval-gated', async () => {
  const provider = await example('provider');
  expectConfigError(
    () => loadConfig(provider.replace('https://provider.example.invalid/v1', 'http://provider.example.invalid/v1')),
    'CONFIG_SCHEMA_INVALID',
  );
  expectConfigError(
    () => loadConfig(provider.replace('https://provider.example.invalid/v1', 'https://attacker.example.invalid/v1')),
    'CONFIG_PROVIDER_ENDPOINT_DENIED',
  );
  expectConfigError(() => loadConfig(provider.replace('enabled: false', 'enabled: true')), 'CONFIG_PROVIDER_APPROVAL_REQUIRED');
  expectConfigError(() => loadConfig(provider.replace('dimensions: 1536', 'dimensions: 16001')), 'CONFIG_SCHEMA_INVALID');
});

test('presets reject arbitrary commands, arguments, environment, and output paths', async () => {
  const preset = await example('preset');
  for (const field of ['command', 'args', 'environment', 'output_path']) {
    expectConfigError(() => loadConfig(`${preset}${field}: injected\n`), 'CONFIG_UNKNOWN_FIELD');
  }
  expectConfigError(() => loadConfig(preset.replace('target: YihuanEditor', 'target: YihuanEditor;whoami')), 'CONFIG_SCHEMA_INVALID');
});

test('environment overrides use a per-kind whitelist and cannot replace secret references', async () => {
  const repository = loadConfig(await example('repository'));
  const enabled = applyEnvironmentOverrides(repository, { UE_MCP_REPOSITORY_ENABLED: 'true' });
  assert.equal(enabled.enabled, true);
  expectConfigError(
    () => applyEnvironmentOverrides(repository, { UE_MCP_REPOSITORY_SECRET_REF: 'secret://corp-vault/other/value' }),
    'CONFIG_ENV_FORBIDDEN',
  );
  expectConfigError(() => applyEnvironmentOverrides(repository, { UE_MCP_PROVIDER_ENABLED: 'true' }), 'CONFIG_ENV_FORBIDDEN');
});

test('safe log projection redacts secret references and excludes configuration payloads', async () => {
  const repositoryText = await example('repository');
  const repository = loadConfig(repositoryText);
  const safe = JSON.stringify(safeConfigForLog(repository));
  assert.match(safe, /secret-ref-redacted/);
  assert.doesNotMatch(safe, /corp-vault|ue56-engine|svn\.example/);
});

test('restricted YAML rejects tags, anchors, aliases, tabs, and multiple documents', async () => {
  const project = await example('project');
  expectConfigError(() => loadConfig(project.replace('name: Yihuan UE 5.6', 'name: &project Yihuan')), 'CONFIG_YAML_UNSUPPORTED');
  expectConfigError(() => loadConfig(project.replace('name: Yihuan UE 5.6', 'name: !env YIHUAN')), 'CONFIG_YAML_UNSUPPORTED');
  expectConfigError(() => loadConfig(project.replace('status: active', '\tstatus: active')), 'CONFIG_YAML_UNSUPPORTED');
  expectConfigError(() => loadConfig(`${project}---\n${project}`), 'CONFIG_YAML_UNSUPPORTED');
});

test('published JSON Schemas are v1, closed, and include secret/preset boundaries', async () => {
  const schemaNames = ['project', 'repository', 'provider', 'preset'];
  const schemas = await Promise.all(schemaNames.map(async (name) => JSON.parse(await readFile(`configs/schemas/${name}-v1.schema.json`, 'utf8'))));
  assert.ok(schemas.every((schema) => schema.$schema === 'https://json-schema.org/draft/2020-12/schema'));
  assert.equal(schemas[0].additionalProperties, false);
  assert.equal(schemas[1].properties.kind.const, 'svn');
  assert.equal(schemas[2].properties.credential.$ref, 'common-v1.schema.json#/$defs/secretCredential');
  assert.equal(schemas[2].properties.embedding.properties.dimensions.maximum, 16000);
  assert.ok(schemas[3].$defs.ubt.additionalProperties === false);
  assert.equal(schemas[3].$defs.ubt.properties.kind.const, 'ubt_build');
  assert.equal(schemas[3].$defs.uat.properties.kind.const, 'uat_test');
  const serializedPreset = JSON.stringify(schemas[3]);
  for (const forbidden of ['command', 'args', 'environment', 'output_path']) assert.doesNotMatch(serializedPreset, new RegExp(`"${forbidden}"`));
});
