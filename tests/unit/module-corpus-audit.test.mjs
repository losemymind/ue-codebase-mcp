import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditModuleCorpus } from '../../tools/audit-module-corpus.mjs';

test('module corpus audit is bounded, non-executing, path-sanitized, and reports parser gaps', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ue-module-corpus-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'Source', 'Fixture'), { recursive: true });
  await mkdir(path.join(root, 'Plugins', 'Fixture'), { recursive: true });
  await mkdir(path.join(root, 'Content'), { recursive: true });
  await writeFile(path.join(root, 'Fixture.uproject'), JSON.stringify({ Modules: [{ Name: 'Fixture', Type: 'Runtime' }] }));
  await writeFile(path.join(root, 'Plugins', 'Fixture', 'Fixture.uplugin'), JSON.stringify({ Modules: [{ Name: 'FixturePlugin', Type: 'Runtime' }] }));
  await writeFile(path.join(root, 'Source', 'Fixture', 'Fixture.Build.cs'), 'public class Fixture : ModuleRules { public Fixture(ReadOnlyTargetRules Target) : base(Target) { PrivateDependencyModuleNames.AddRange(Computed); } }');
  await writeFile(path.join(root, 'Source', 'Fixture.Target.cs'), 'public class FixtureTarget : TargetRules { public FixtureTarget(TargetInfo Target) : base(Target) { Type = TargetType.Game; ExtraModuleNames.Add("Fixture"); } }');
  await writeFile(path.join(root, 'Content', 'Ignored.Build.cs'), 'malformed');
  try { await symlink(path.join(root, 'Source'), path.join(root, 'LinkedSource'), 'junction'); } catch {}

  const report = await auditModuleCorpus([root]);
  assert.equal(report.discovered_files, 4);
  assert.equal(report.parsed_files, 4);
  assert.equal(report.parse_coverage_percent, 100);
  assert.deepEqual(report.counts, { build_cs: 1, target_cs: 1, uproject: 1, uplugin: 1 });
  assert.equal(report.diagnostics.DYNAMIC_DEPENDENCY_EXPRESSION, 1);
  assert.equal(report.parse_failure_count, 0);
  assert.deepEqual(report.parse_failures, []);
  assert.ok(!JSON.stringify(report).includes(root));
});

test('module corpus audit reports malformed inputs without exposing absolute roots', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ue-module-corpus-bad-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'Broken.uplugin'), '{broken');
  const report = await auditModuleCorpus([root]);
  assert.equal(report.parsed_files, 0);
  assert.equal(report.parse_failure_count, 1);
  assert.deepEqual(report.parse_failure_reasons, { 'descriptor JSON is invalid': 1 });
  assert.equal(report.parse_failures.length, 1);
  assert.equal(report.parse_failures[0].path, 'root-1/Broken.uplugin');
  assert.ok(!JSON.stringify(report).includes(root));
});
