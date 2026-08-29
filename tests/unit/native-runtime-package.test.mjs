import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadNativeRuntimePolicy } from '../../tools/lib/native-runtime.mjs';
import { packageClangRuntime } from '../../tools/package-clang-runtime.mjs';

const repositoryRoot = path.resolve('.');
const fixture = path.resolve('database/.test-data/native-runtime-package');
const runtimeRoot = path.join(fixture, 'llvm');
const executable = path.join(fixture, 'clang-cursor-indexer.exe');
const noticesFile = path.join(fixture, 'ThirdPartyNotices.txt');
const summaryFile = path.join(fixture, 'THIRD_PARTY_NOTICES.md');
const policyFile = path.join(fixture, 'runtime-policy.json');

const digest = (content) => createHash('sha256').update(content).digest('hex');

test.after(async () => {
  await rm(fixture, { recursive: true, force: true });
});

async function prepare() {
  await rm(fixture, { recursive: true, force: true });
  await mkdir(path.join(runtimeRoot, 'bin'), { recursive: true });
  const runtime = Buffer.from('synthetic libclang 19.1.5 fixture');
  const executableContent = Buffer.from('synthetic fixed cursor executable');
  const notices = Buffer.from([
    '%% clang NOTICES AND INFORMATION BEGIN HERE',
    'Apache License, Version 2.0',
    'LLVM Exceptions to the Apache 2.0 License',
  ].join('\n'));
  await writeFile(path.join(runtimeRoot, 'bin/libclang.dll'), runtime);
  await writeFile(executable, executableContent);
  await writeFile(noticesFile, notices);
  await writeFile(summaryFile, '# Synthetic third-party summary\n');
  const policy = {
    schema_version: 1,
    component: { type: 'library', name: 'libclang', version: '19.1.5', supplier: 'LLVM Project', license_expression: 'Apache-2.0 WITH LLVM-exception' },
    runtime: { relative_path: 'bin/libclang.dll', sha256: digest(runtime), max_bytes: 1024 },
    notices: { sha256: digest(notices), max_bytes: 4096, required_markers: ['%% clang NOTICES AND INFORMATION BEGIN HERE', 'Apache License, Version 2.0', 'LLVM Exceptions to the Apache 2.0 License'] },
  };
  await writeFile(policyFile, `${JSON.stringify(policy, null, 2)}\n`);
}

function request(outputDirectory) {
  return {
    repository_root: repositoryRoot,
    policy_file: policyFile,
    summary_file: summaryFile,
    runtime_root: runtimeRoot,
    notices_file: noticesFile,
    executable,
    output_directory: outputDirectory,
  };
}

test('native runtime package is hash-pinned, notice-complete, SBOM-described, and reproducible', async () => {
  await prepare();
  const firstDirectory = path.join(fixture, 'package-a');
  const secondDirectory = path.join(fixture, 'package-b');
  const first = await packageClangRuntime(request(firstDirectory));
  const second = await packageClangRuntime(request(secondDirectory));
  assert.deepEqual(second, first);
  assert.match(first.artifact_hash, /^[a-f0-9]{64}$/);
  assert.equal(first.files.length, 5);
  const sbom = JSON.parse(await readFile(path.join(firstDirectory, 'sbom.cdx.json'), 'utf8'));
  assert.equal(sbom.components[0].licenses[0].expression, 'Apache-2.0 WITH LLVM-exception');
  assert.equal(sbom.components[0].hashes[0].content, (await loadNativeRuntimePolicy(policyFile)).runtime.sha256);
  assert.deepEqual(await readFile(path.join(firstDirectory, 'runtime-manifest.json'), 'utf8'), await readFile(path.join(secondDirectory, 'runtime-manifest.json'), 'utf8'));
});

test('native runtime package fails closed on input drift, missing notices, stale output, and path escape', async () => {
  await prepare();
  await writeFile(path.join(runtimeRoot, 'bin/libclang.dll'), 'tampered runtime');
  await assert.rejects(packageClangRuntime(request(path.join(fixture, 'tampered'))), /input verification failed/);

  await prepare();
  await mkdir(path.join(fixture, 'existing'));
  await assert.rejects(packageClangRuntime(request(path.join(fixture, 'existing'))), /already exists/);
  await assert.rejects(packageClangRuntime(request(path.resolve('..', 'native-package-escape'))), /escapes its configured root/);

  const policy = JSON.parse(await readFile(policyFile, 'utf8'));
  policy.component.license_expression = 'GPL-3.0-only OR MIT';
  await writeFile(policyFile, JSON.stringify(policy));
  await assert.rejects(loadNativeRuntimePolicy(policyFile), /license is invalid/);
});

test('native runtime packaging tool exposes fixed typed inputs and no process or shell execution', async () => {
  const source = await readFile('tools/package-clang-runtime.mjs', 'utf8');
  assert.match(source, /new Set\(\['--runtime-root', '--notices-file', '--executable', '--output-directory'\]\)/);
  assert.doesNotMatch(source, new RegExp(`child_${'process'}|spawn\\s*\\(|exec\\s*\\(|Invoke-Expression|cmd(?:\\.exe)?`, 'i'));
  const policy = await loadNativeRuntimePolicy(path.resolve('workers/clang-indexer/native/runtime-policy.json'));
  assert.equal(policy.component.version, '19.1.5');
  assert.equal(policy.component.license_expression, 'Apache-2.0 WITH LLVM-exception');
});
