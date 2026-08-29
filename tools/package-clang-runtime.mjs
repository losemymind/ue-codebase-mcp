import { copyFile, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  below,
  canonicalFile,
  cyclonedxComponent,
  loadNativeRuntimePolicy,
  readBoundedFile,
  sha256,
} from './lib/native-runtime.mjs';

const root = process.cwd();
const fixedPolicy = path.join(root, 'workers/clang-indexer/native/runtime-policy.json');
const fixedSummary = path.join(root, 'THIRD_PARTY_NOTICES.md');

function parseArguments(args) {
  const allowed = new Set(['--runtime-root', '--notices-file', '--executable', '--output-directory']);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.has(name) || value === undefined || values[name] !== undefined || /[\r\n\0]/.test(value)) {
      throw new TypeError('native package arguments are invalid');
    }
    values[name] = value;
  }
  if ([...allowed].some((name) => values[name] === undefined)) throw new TypeError('native package arguments are incomplete');
  return values;
}

function sourceDateEpoch() {
  const value = process.env.SOURCE_DATE_EPOCH ?? '0';
  if (!/^(?:0|[1-9][0-9]{0,11})$/.test(value)) throw new TypeError('SOURCE_DATE_EPOCH is invalid');
  return value;
}

async function fileRecord(directory, name) {
  const absolute = path.join(directory, name);
  const content = await readBoundedFile(absolute, 512 * 1024 * 1024, `packaged ${name}`);
  return { path: name, size: content.length, sha256: sha256(content) };
}

export async function packageClangRuntime(request) {
  const repositoryRoot = path.resolve(request.repository_root ?? root);
  const policyFile = below(repositoryRoot, path.resolve(request.policy_file ?? fixedPolicy), 'native runtime policy');
  const summaryFile = below(repositoryRoot, path.resolve(request.summary_file ?? fixedSummary), 'third-party summary');
  const policy = await loadNativeRuntimePolicy(policyFile);
  if (!path.isAbsolute(request.runtime_root) || !path.isAbsolute(request.notices_file)
      || !path.isAbsolute(request.executable) || !path.isAbsolute(request.output_directory)) {
    throw new TypeError('native package paths must be absolute');
  }
  const runtimeRoot = await realpath(request.runtime_root).catch(() => { throw new TypeError('native runtime root is unavailable'); });
  const runtimeFile = await canonicalFile(path.join(runtimeRoot, policy.runtime.relative_path), 'libclang runtime');
  if (!below(runtimeRoot, runtimeFile, 'libclang runtime').toLowerCase().endsWith(`${path.sep}bin${path.sep}libclang.dll`)) {
    throw new TypeError('libclang runtime path is invalid');
  }
  const noticesFile = await canonicalFile(request.notices_file, 'native notices');
  const executable = await canonicalFile(request.executable, 'cursor executable');
  if (path.basename(executable).toLowerCase() !== 'clang-cursor-indexer.exe') throw new TypeError('cursor executable name is invalid');
  below(repositoryRoot, executable, 'cursor executable');
  const outputDirectory = below(repositoryRoot, request.output_directory, 'native package output');
  await stat(outputDirectory).then(() => { throw new TypeError('native package output already exists'); }, () => undefined);

  const runtime = await readBoundedFile(runtimeFile, policy.runtime.max_bytes, 'libclang runtime');
  const notices = await readBoundedFile(noticesFile, policy.notices.max_bytes, 'native notices');
  const executableContent = await readBoundedFile(executable, 64 * 1024 * 1024, 'cursor executable');
  const summary = await readBoundedFile(summaryFile, 256 * 1024, 'third-party summary');
  if (sha256(runtime) !== policy.runtime.sha256 || sha256(notices) !== policy.notices.sha256
      || policy.notices.required_markers.some((marker) => !notices.includes(Buffer.from(marker, 'utf8')))) {
    throw new TypeError('native package input verification failed');
  }

  await mkdir(outputDirectory, { recursive: false });
  await copyFile(executable, path.join(outputDirectory, 'clang-cursor-indexer.exe'));
  await copyFile(runtimeFile, path.join(outputDirectory, 'libclang.dll'));
  await copyFile(noticesFile, path.join(outputDirectory, 'THIRD_PARTY_NOTICES.txt'));
  await copyFile(summaryFile, path.join(outputDirectory, 'THIRD_PARTY_NOTICES.md'));
  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: { component: { type: 'application', name: 'clang-cursor-indexer', version: policy.component.version } },
    components: [cyclonedxComponent(policy)],
  };
  await writeFile(path.join(outputDirectory, 'sbom.cdx.json'), `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
  const names = ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.txt', 'clang-cursor-indexer.exe', 'libclang.dll', 'sbom.cdx.json'];
  const files = [];
  for (const name of names) files.push(await fileRecord(outputDirectory, name));
  const artifactHash = sha256(JSON.stringify({ schema_version: 1, files }));
  const manifest = {
    schema_version: 1,
    component: policy.component,
    source_date_epoch: sourceDateEpoch(),
    artifact_hash: artifactHash,
    files,
  };
  await writeFile(path.join(outputDirectory, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return Object.freeze(manifest);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArguments(process.argv.slice(2));
  const manifest = await packageClangRuntime({
    runtime_root: path.resolve(args['--runtime-root']),
    notices_file: path.resolve(args['--notices-file']),
    executable: path.resolve(args['--executable']),
    output_directory: path.resolve(args['--output-directory']),
  });
  console.log(`packaged clang cursor runtime ${manifest.artifact_hash}`);
}
