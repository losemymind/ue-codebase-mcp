import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  buildUbtCompileDatabaseInvocation,
  createCoverageReport,
  loadCompileDatabaseResponseFiles,
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

test('compile database preserves distinct flag variants for the same translation unit', () => {
  const base = { directory: workspace, file: engineSource };
  const normalized = normalizeCompileDatabase(JSON.stringify([
    { ...base, arguments: [path.join(workspace, 'clang-cl.exe'), '/DVARIANT=runtime', engineSource] },
    { ...base, arguments: [path.join(workspace, 'clang-cl.exe'), '/DVARIANT=test', engineSource] },
  ]), [workspace]);
  assert.equal(normalized.length, 2);
  assert.notEqual(normalized[0].content_hash, normalized[1].content_hash);
});

test('workspace-confined response files expand without shell evaluation', () => {
  const responsePath = path.join(workspace, 'Project/Intermediate/compile.rsp');
  const entry = { directory: workspace, file: gameSource, arguments: [path.join(workspace, 'clang-cl.exe'), `@${responsePath}`] };
  const responseFiles = new Map([[responsePath, `-I Project/Source -DGAME_FROM_RSP=1 "${gameSource}"`]]);
  const [normalized] = normalizeCompileDatabase(JSON.stringify([entry]), [workspace], { response_files: responseFiles });
  assert.deepEqual(normalized.definitions, ['GAME_FROM_RSP=1']);
  assert.equal(normalized.include_paths[0], path.join(workspace, 'Project/Source'));
});

test('response file loader follows nested references with an injected reader', async () => {
  const first = path.join(workspace, 'Project/Intermediate/first.rsp');
  const nested = path.join(workspace, 'Project/Intermediate/nested.rsp');
  const contents = new Map([
    [first, `@Project/Intermediate/nested.rsp -I Project/Source "${gameSource}"`],
    [nested, '-DGAME_FROM_NESTED_RSP=1'],
  ]);
  const database = JSON.stringify([{ directory: workspace, file: gameSource, arguments: [path.join(workspace, 'clang-cl.exe'), `@${first}`] }]);
  const loaded = await loadCompileDatabaseResponseFiles(database, [workspace], async (absolutePath) => {
    const content = contents.get(absolutePath);
    if (content === undefined) throw new Error('missing fixture');
    return content;
  });
  assert.equal(loaded.size, 2);
  const [normalized] = normalizeCompileDatabase(database, [workspace], { response_files: loaded });
  assert.deepEqual(normalized.definitions, ['GAME_FROM_NESTED_RSP=1']);
});

test('response file loader rejects escapes, missing data, invalid data, and excessive nesting', async () => {
  const entry = (reference) => JSON.stringify([{ directory: workspace, file: gameSource, arguments: [path.join(workspace, 'clang-cl.exe'), reference] }]);
  await assert.rejects(() => loadCompileDatabaseResponseFiles(entry('@../outside.rsp'), [workspace], async () => 'unused'), /escapes configured workspaces/);
  await assert.rejects(() => loadCompileDatabaseResponseFiles(entry('@missing.rsp'), [workspace], async () => { throw new Error('missing'); }), /unavailable or invalid/);
  await assert.rejects(() => loadCompileDatabaseResponseFiles(entry('@invalid.rsp'), [workspace], async () => 'bad\0data'), /bytes exceed|unavailable or invalid/);
  await assert.rejects(() => loadCompileDatabaseResponseFiles(entry('@0.rsp'), [workspace], async (absolutePath) => {
    const index = Number.parseInt(path.basename(absolutePath), 10);
    return `@${index + 1}.rsp`;
  }), /nesting is too deep/);
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
  assert.ok(invocation.args.includes('-NoExecCodeGenActions'));
  assert.ok(invocation.args.includes('-OutputFilename=compile_commands.json'));
  assert.ok(invocation.args.every((argument) => !/[\r\n\0]/.test(argument)));
  assert.throws(() => buildUbtCompileDatabaseInvocation({ ...invocation, workspace_root: workspace, ubt_executable: 'cmd.exe' }));
});
