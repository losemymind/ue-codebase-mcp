import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('runtime versions and lockfile are exact', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.match(pkg.engines.node, /^\d+\.\d+\.\d+$/);
  assert.match(pkg.engines.npm, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.packageManager, `npm@${pkg.engines.npm}`);
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.version, pkg.version);
});

test('product boundary excludes source mutation and generic execution tools', async () => {
  const plan = await readFile('DEVELOPMENT_TASK_PLAN.md', 'utf8');
  assert.match(plan, /MCP 永久不提供代码写入、补丁应用、commit、push 或 submit 能力/);
  const security = await readFile('SECURITY.md', 'utf8');
  for (const term of ['code writes', 'patch application', 'commits', 'pushes', 'submits', 'arbitrary commands']) {
    assert.ok(security.includes(term), `missing boundary term: ${term}`);
  }
});

test('release artifacts use deterministic epoch by default', async () => {
  const buildScript = await readFile('tools/build.mjs', 'utf8');
  assert.match(buildScript, /SOURCE_DATE_EPOCH \?\? '0'/);
  assert.doesNotMatch(buildScript, /new Date/);
});

