import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  buildUbtCompileDatabaseInvocation,
  createCoverageReport,
  normalizeCompileDatabase,
  parseWindowsCommandLine,
} from '../../workers/clang-indexer/src/compile-database.ts';

const workspace = path.resolve('database/.test-data/compile-fixture');
const engineSource = path.join(workspace, 'Engine/Source/Runtime/Core/Private/Core.cpp');
const gameSource = path.join(workspace, 'Project/Source/Game/Game.cpp');

test('Windows compile command parser preserves quoted paths without invoking a shell', () => {
  assert.deepEqual(parseWindowsCommandLine('"C:\\UE 5.6\\clang-cl.exe" /I"C:\\UE 5.6\\Include" /DUE_BUILD=1 "C:\\Game\\Foo.cpp"'), [
    'C:\\UE 5.6\\clang-cl.exe', '/IC:\\UE 5.6\\Include', '/DUE_BUILD=1', 'C:\\Game\\Foo.cpp',
  ]);
  assert.throws(() => parseWindowsCommandLine('"unterminated'));
});

test('compile database normalization fixes paths and extracts includes/macros/forced includes', () => {
  const database = JSON.stringify([
    {
      directory: path.dirname(engineSource), file: engineSource,
      arguments: [path.join(workspace, 'Toolchain/bin/clang-cl.exe'), '/I', '../../Public', '/DUE_BUILD_DEVELOPMENT=1', '/FISharedPCH.h', '/Fo', 'ignored.obj', engineSource],
    },
    {
      directory: path.dirname(gameSource), file: gameSource,
      command: `"${path.join(workspace, 'Toolchain/bin/clang-cl.exe')}" -I ../Public -DGAME=1 "${gameSource}"`,
    },
  ]);
  const normalized = normalizeCompileDatabase(database, [workspace]);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].include_paths[0], path.resolve(path.dirname(engineSource), '../../Public'));
  assert.equal(normalized[0].forced_includes[0], path.resolve(path.dirname(engineSource), 'SharedPCH.h'));
  assert.deepEqual(normalized[0].definitions, ['UE_BUILD_DEVELOPMENT=1']);
  assert.ok(normalized.every(({ content_hash }) => /^[a-f0-9]{64}$/.test(content_hash)));
});

test('compile database rejects workspace escape, non-Clang compiler, response files, and duplicate TUs', () => {
  const base = { directory: workspace, file: engineSource, arguments: [path.join(workspace, 'clang-cl.exe'), engineSource] };
  assert.throws(() => normalizeCompileDatabase(JSON.stringify([{ ...base, file: path.resolve('outside.cpp') }]), [workspace]));
  assert.throws(() => normalizeCompileDatabase(JSON.stringify([{ ...base, arguments: [path.join(workspace, 'cl.exe'), engineSource] }]), [workspace]));
  assert.throws(() => normalizeCompileDatabase(JSON.stringify([{ ...base, arguments: [path.join(workspace, 'clang-cl.exe'), '@flags.rsp', engineSource] }]), [workspace]));
  assert.throws(() => normalizeCompileDatabase(JSON.stringify([base, base]), [workspace]));
});

test('workspace-confined response files expand without shell evaluation', () => {
  const responsePath = path.join(workspace, 'Project/Intermediate/compile.rsp');
  const entry = { directory: workspace, file: gameSource, arguments: [path.join(workspace, 'clang-cl.exe'), `@${responsePath}`] };
  const responseFiles = new Map([[responsePath, `-I Project/Source -DGAME_FROM_RSP=1 "${gameSource}"`]]);
  const [normalized] = normalizeCompileDatabase(JSON.stringify([entry]), [workspace], { response_files: responseFiles });
  assert.deepEqual(normalized.definitions, ['GAME_FROM_RSP=1']);
  assert.equal(normalized.include_paths[0], path.join(workspace, 'Project/Source'));
});

test('coverage report distinguishes raw coverage from explicit reviewed exemptions', () => {
  const commands = normalizeCompileDatabase(JSON.stringify([{ directory: workspace, file: engineSource, arguments: [path.join(workspace, 'clang-cl.exe'), engineSource] }]), [workspace]);
  const without = createCoverageReport([engineSource, gameSource], commands);
  assert.equal(without.raw_coverage_percent, 50);
  assert.equal(without.meets_99_percent, false);
  const withExemption = createCoverageReport([engineSource, gameSource], commands, [{ path: gameSource, reason: 'generated test-only TU', risk: 'game symbols unavailable', approved_by: 'synthetic-fixture-reviewer' }]);
  assert.equal(withExemption.acceptance_coverage_percent, 100);
  assert.equal(withExemption.exempted_tus, 1);
});

test('UBT generation invocation is fixed, typed, workspace-confined, and contains no command escape hatch', () => {
  const invocation = buildUbtCompileDatabaseInvocation({
    workspace_root: workspace,
    ubt_executable: path.join(workspace, 'Engine/Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.exe'),
    project_file: path.join(workspace, 'Project/Yihuan.uproject'),
    target: 'YihuanEditor', platform: 'Win64', configuration: 'Development',
    output_file: path.join(workspace, 'Artifacts/compile_commands.json'),
  });
  assert.equal(path.basename(invocation.executable), 'UnrealBuildTool.exe');
  assert.ok(invocation.args.includes('-Mode=GenerateClangDatabase'));
  assert.ok(invocation.args.every((argument) => !/[\r\n\0]/.test(argument)));
  assert.throws(() => buildUbtCompileDatabaseInvocation({ ...invocation, workspace_root: workspace, ubt_executable: 'cmd.exe' }));
});
