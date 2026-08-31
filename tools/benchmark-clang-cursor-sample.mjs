import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadCompileDatabaseResponseFiles,
  normalizeCompileDatabase,
  parseWindowsCommandLine,
} from '../workers/clang-indexer/src/compile-database.ts';
import { CursorBatchError, runCursorBatch } from '../workers/clang-indexer/src/cursor-batch.ts';
import { below, readBoundedFile, sha256 } from './lib/native-runtime.mjs';

const HASH = /^[a-f0-9]{64}$/;
const SOURCE_EXTENSION = /\.(?:c|cc|cpp|cxx|m|mm)$/i;
const SELECTION_SEED = 'p1-09-engine-ht-sample-v1';
const MAX_DATABASE_BYTES = 256 * 1024 * 1024;
const PACKAGE_FILES = Object.freeze({
  'THIRD_PARTY_NOTICES.md': 256 * 1024,
  'THIRD_PARTY_NOTICES.txt': 16 * 1024 * 1024,
  'clang-cursor-indexer.exe': 64 * 1024 * 1024,
  'libclang.dll': 256 * 1024 * 1024,
  'sbom.cdx.json': 1024 * 1024,
});

function parseArguments(argv) {
  const allowed = new Set([
    '--database', '--database-sha256', '--engine-root', '--project-root', '--package-root', '--state-root', '--report',
    '--sample-per-root', '--batch-size', '--concurrency', '--timeout-ms', '--max-error-diagnostics',
  ]);
  const required = new Set([...allowed].filter((name) => name !== '--max-error-diagnostics'));
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || value === undefined || values[name] !== undefined || /[\r\n\0]/.test(value)) {
      throw new TypeError('cursor benchmark arguments are invalid');
    }
    values[name] = value;
  }
  if ([...required].some((name) => values[name] === undefined)) throw new TypeError('cursor benchmark arguments are incomplete');
  const integer = (name, minimum, maximum) => {
    if (!/^[0-9]+$/.test(values[name])) throw new TypeError('cursor benchmark numeric argument is invalid');
    const result = Number(values[name]);
    if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new TypeError('cursor benchmark numeric argument is out of range');
    return result;
  };
  if (!HASH.test(values['--database-sha256'])) throw new TypeError('cursor benchmark database hash is invalid');
  for (const name of ['--database', '--engine-root', '--project-root', '--package-root', '--state-root', '--report']) {
    if (!path.isAbsolute(values[name])) throw new TypeError('cursor benchmark paths must be absolute');
  }
  return {
    database_path: path.resolve(values['--database']),
    database_sha256: values['--database-sha256'],
    workspace_roots: [path.resolve(values['--engine-root']), path.resolve(values['--project-root'])],
    package_root: path.resolve(values['--package-root']),
    state_root: path.resolve(values['--state-root']),
    report_file: path.resolve(values['--report']),
    sample_per_root: integer('--sample-per-root', 1, 16),
    batch_size: integer('--batch-size', 1, 16),
    concurrency: integer('--concurrency', 1, 4),
    timeout_ms: integer('--timeout-ms', 10_000, 30 * 60 * 1000),
    max_error_diagnostics: values['--max-error-diagnostics'] === undefined ? 0 : integer('--max-error-diagnostics', 0, 64),
  };
}

function rootIndex(file, roots) {
  return roots.findIndex((root) => {
    const relative = path.relative(root, file);
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

function sourcePath(entry) {
  if (typeof entry.directory !== 'string' || !path.isAbsolute(entry.directory) || typeof entry.file !== 'string') {
    throw new TypeError('cursor benchmark compile entry path is invalid');
  }
  const source = path.normalize(path.isAbsolute(entry.file) ? entry.file : path.resolve(entry.directory, entry.file));
  if (!SOURCE_EXTENSION.test(source)) throw new TypeError('cursor benchmark compile entry source is invalid');
  return source;
}

function driver(entry) {
  if ((entry.arguments === undefined) === (entry.command === undefined)) throw new TypeError('cursor benchmark compile entry arguments are invalid');
  const argumentsValue = entry.arguments ?? parseWindowsCommandLine(entry.command);
  if (!Array.isArray(argumentsValue) || argumentsValue.length === 0 || argumentsValue.some((argument) => typeof argument !== 'string')) {
    throw new TypeError('cursor benchmark compile entry arguments are invalid');
  }
  return path.basename(argumentsValue[0]).toLowerCase();
}

export function selectCompileDatabaseSample(json, workspaceRoots, samplePerRoot) {
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_DATABASE_BYTES
      || !Array.isArray(workspaceRoots) || workspaceRoots.length !== 2 || workspaceRoots.some((root) => !path.isAbsolute(root))
      || !Number.isSafeInteger(samplePerRoot) || samplePerRoot < 1 || samplePerRoot > 16) {
    throw new TypeError('cursor benchmark selection input is invalid');
  }
  let parsed;
  try { parsed = JSON.parse(json); } catch { throw new TypeError('cursor benchmark compile database JSON is invalid'); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 1_000_000) throw new TypeError('cursor benchmark compile database is invalid');
  const roots = workspaceRoots.map((root) => path.resolve(root));
  const candidates = roots.map(() => new Map());
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new TypeError('cursor benchmark compile entry is invalid');
    const source = sourcePath(entry);
    const index = rootIndex(source, roots);
    const compiler = driver(entry);
    if (index < 0 || !/^(?:clang|clang-cl)(?:\.exe)?$/i.test(compiler)) continue;
    const key = source.toLowerCase();
    if (!candidates[index].has(key)) {
      const relative = path.relative(roots[index], source).replaceAll('\\', '/').toLowerCase();
      candidates[index].set(key, {
        entry,
        rank: createHash('sha256').update(`${SELECTION_SEED}\0${index}\0${relative}`).digest('hex'),
      });
    }
  }
  return candidates.flatMap((bySource) => {
    const selected = [...bySource.values()].sort((left, right) => left.rank.localeCompare(right.rank, 'en')).slice(0, samplePerRoot);
    if (selected.length !== samplePerRoot) throw new TypeError('cursor benchmark root has insufficient Clang actions');
    return selected.map(({ entry }) => entry);
  });
}

export function validateRuntimeManifest(manifest) {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)
      || Object.keys(manifest).some((key) => !['schema_version', 'component', 'source_date_epoch', 'artifact_hash', 'files'].includes(key))
      || manifest.schema_version !== 1 || typeof manifest.component !== 'object' || manifest.component === null
      || typeof manifest.source_date_epoch !== 'string' || !/^(?:0|[1-9][0-9]{0,11})$/.test(manifest.source_date_epoch)
      || !HASH.test(manifest.artifact_hash) || !Array.isArray(manifest.files) || manifest.files.length !== 5) {
    throw new TypeError('cursor package manifest is invalid');
  }
  const expectedNames = Object.keys(PACKAGE_FILES);
  for (let index = 0; index < manifest.files.length; index += 1) {
    const record = manifest.files[index];
    const name = expectedNames[index];
    if (typeof record !== 'object' || record === null || Array.isArray(record)
        || Object.keys(record).length !== 3 || !Object.hasOwn(record, 'path') || !Object.hasOwn(record, 'size') || !Object.hasOwn(record, 'sha256')
        || record.path !== name || !Number.isSafeInteger(record.size) || record.size < 1 || record.size > PACKAGE_FILES[name]
        || !HASH.test(record.sha256)) throw new TypeError('cursor package manifest files are invalid');
  }
  const computed = sha256(JSON.stringify({ schema_version: 1, files: manifest.files }));
  if (computed !== manifest.artifact_hash) throw new TypeError('cursor package artifact hash is invalid');
  return manifest.files;
}

async function verifiedPackage(packageRoot, repositoryRoot) {
  const root = below(repositoryRoot, packageRoot, 'cursor benchmark package');
  const manifestBuffer = await readBoundedFile(path.join(root, 'runtime-manifest.json'), 1024 * 1024, 'cursor package manifest');
  let manifest;
  try { manifest = JSON.parse(manifestBuffer.toString('utf8')); } catch { throw new TypeError('cursor package manifest is invalid'); }
  const files = validateRuntimeManifest(manifest);
  const executableRecord = files.find(({ path: name }) => name === 'clang-cursor-indexer.exe');
  const executable = path.join(root, 'clang-cursor-indexer.exe');
  for (const record of files) {
    const content = await readBoundedFile(path.join(root, record.path), PACKAGE_FILES[record.path], `cursor package ${record.path}`);
    if (content.length !== record.size || sha256(content) !== record.sha256) throw new TypeError('cursor package verification failed');
  }
  return { root, executable, artifact_hash: manifest.artifact_hash };
}

async function atomicReport(file, value, repositoryRoot) {
  const target = below(repositoryRoot, file, 'cursor benchmark report');
  await stat(target).then(() => { throw new TypeError('cursor benchmark report already exists'); }, () => undefined);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, target);
}

export async function benchmarkCursorSample(request, executor) {
  const repositoryRoot = path.resolve(request.repository_root ?? process.cwd());
  const database = await readBoundedFile(request.database_path, MAX_DATABASE_BYTES, 'cursor benchmark database');
  if (sha256(database) !== request.database_sha256) throw new TypeError('cursor benchmark database hash mismatch');
  const roots = request.workspace_roots.map((root) => path.resolve(root));
  const selected = selectCompileDatabaseSample(database.toString('utf8'), roots, request.sample_per_root);
  const selectedJson = JSON.stringify(selected);
  const responseFiles = await loadCompileDatabaseResponseFiles(selectedJson, roots, (file) => readFile(file, 'utf8'));
  const commands = normalizeCompileDatabase(selectedJson, roots, { response_files: responseFiles });
  const packageValue = await verifiedPackage(request.package_root, repositoryRoot);
  const stateRoot = below(repositoryRoot, request.state_root, 'cursor benchmark state');
  await mkdir(stateRoot, { recursive: true });
  const diagnosticInputHash = createHash('sha256').update(JSON.stringify({
    evidence_class: 'diagnostic-modified-partial-not-g1',
    database_sha256: request.database_sha256,
    argument_profile: 'ue-msvc-cxx20',
    max_error_diagnostics: request.max_error_diagnostics ?? 0,
    actions: commands.map(({ content_hash }) => content_hash),
  })).digest('hex');
  const started = performance.now();
  let peakCoordinatorRss = process.memoryUsage().rss;
  const sampler = setInterval(() => { peakCoordinatorRss = Math.max(peakCoordinatorRss, process.memoryUsage().rss); }, 25);
  sampler.unref();
  let batch;
  try {
    batch = await runCursorBatch({
      batch_id: `diagnostic-engine-ht-${request.sample_per_root}-each`,
      revision_set_hash: diagnosticInputHash,
      tool_artifact_hash: packageValue.artifact_hash,
      state_root: stateRoot,
      checkpoint_directory: path.join(stateRoot, 'checkpoints'),
      executable: packageValue.executable,
      tool_root: packageValue.root,
      workspace_roots: roots,
      commands,
      argument_profile: 'ue-msvc-cxx20',
      batch_size: request.batch_size,
      concurrency: request.concurrency,
      max_attempts: 2,
      execution_policy: {
        timeout_ms: request.timeout_ms,
        max_output_bytes: 256 * 1024 * 1024,
        max_error_diagnostics: request.max_error_diagnostics ?? 0,
      },
    }, executor);
  } finally {
    clearInterval(sampler);
  }
  peakCoordinatorRss = Math.max(peakCoordinatorRss, process.memoryUsage().rss);
  const elapsedMs = performance.now() - started;
  const report = Object.freeze({
    schema_version: 1,
    evidence_class: 'diagnostic-modified-partial-not-g1',
    selection_seed: SELECTION_SEED,
    database_sha256: request.database_sha256,
    diagnostic_input_hash: diagnosticInputHash,
    tool_artifact_hash: packageValue.artifact_hash,
    argument_profile: 'ue-msvc-cxx20',
    sample_per_root: request.sample_per_root,
    total_actions: commands.length,
    action_hashes: commands.map(({ content_hash }) => content_hash),
    batch_size: request.batch_size,
    concurrency: request.concurrency,
    timeout_ms: request.timeout_ms,
    max_error_diagnostics: request.max_error_diagnostics ?? 0,
    elapsed_ms: Math.round(elapsedMs),
    actions_per_second: commands.length / (elapsedMs / 1000),
    peak_coordinator_rss_bytes: peakCoordinatorRss,
    response_files: responseFiles.size,
    response_file_bytes: [...responseFiles.values()].reduce((total, content) => total + Buffer.byteLength(content, 'utf8'), 0),
    libclang: batch.libclang,
    diagnostic_count: batch.diagnostic_count,
    error_count: batch.error_count,
    unidentified_count: batch.unidentified_count,
    unique_symbols: batch.symbols.length,
    deduplicated_symbol_records: batch.deduplicated_symbol_records,
    deduplicated_locations: batch.deduplicated_locations,
    attempt_count: batch.attempt_count,
    checkpoint_count: batch.checkpoint_count,
    completed_actions: batch.completed_actions,
  });
  await atomicReport(request.report_file, report, repositoryRoot);
  return report;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await benchmarkCursorSample(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof CursorBatchError && error.cause_code !== undefined
      ? `cursor benchmark action ${error.cause_code}`
      : error instanceof Error ? error.message : 'cursor benchmark failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  }
}
