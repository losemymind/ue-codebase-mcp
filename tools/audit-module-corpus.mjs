import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseBuildCs,
  parseDescriptor,
  parseTargetCs,
} from '../workers/clang-indexer/src/module-model.ts';

const MAX_FILES = 20_000;
const MAX_REPORTED_FAILURES = 100;
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.svn',
  'Binaries',
  'Content',
  'DerivedDataCache',
  'Intermediate',
  'Saved',
]);

function fileKind(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.build.cs')) return 'build_cs';
  if (lower.endsWith('.target.cs')) return 'target_cs';
  if (lower.endsWith('.uproject')) return 'uproject';
  if (lower.endsWith('.uplugin')) return 'uplugin';
  return undefined;
}

async function collectFiles(root, rootIndex) {
  const resolved = path.resolve(root);
  if (!(await stat(resolved)).isDirectory()) throw new TypeError('corpus root must be a directory');
  const canonicalRoot = await realpath(resolved);
  const files = [];
  let skippedSymlinks = 0;
  const pending = [canonicalRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        skippedSymlinks += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(fullPath);
        continue;
      }
      const kind = entry.isFile() ? fileKind(fullPath) : undefined;
      if (kind !== undefined) {
        files.push({
          fullPath,
          kind,
          evidencePath: `root-${rootIndex + 1}/${path.relative(canonicalRoot, fullPath).replaceAll('\\', '/')}`,
        });
        if (files.length > MAX_FILES) throw new TypeError(`corpus exceeds ${MAX_FILES} relevant files`);
      }
    }
  }
  return { files, skippedSymlinks };
}

export async function auditModuleCorpus(roots) {
  if (!Array.isArray(roots) || roots.length === 0 || roots.length > 16 || roots.some((root) => typeof root !== 'string' || !path.isAbsolute(root))) {
    throw new TypeError('one to sixteen absolute corpus roots are required');
  }
  const collected = await Promise.all(roots.map(collectFiles));
  const files = collected.flatMap(({ files: rootFiles }) => rootFiles)
    .sort((left, right) => left.evidencePath.localeCompare(right.evidencePath, 'en'));
  if (files.length > MAX_FILES) throw new TypeError(`corpus exceeds ${MAX_FILES} relevant files`);

  const counts = { build_cs: 0, target_cs: 0, uproject: 0, uplugin: 0 };
  const diagnosticCodes = new Map();
  const failureReasons = new Map();
  const failureSamples = new Map();
  const failures = [];
  let parsed = 0;
  for (const file of files) {
    counts[file.kind] += 1;
    try {
      const source = await readFile(file.fullPath, 'utf8');
      const model = file.kind === 'build_cs'
        ? parseBuildCs(source, file.evidencePath)
        : file.kind === 'target_cs'
          ? parseTargetCs(source, file.evidencePath)
          : parseDescriptor(source, file.evidencePath);
      parsed += 1;
      for (const diagnostic of model.diagnostics ?? []) {
        diagnosticCodes.set(diagnostic.code, (diagnosticCodes.get(diagnostic.code) ?? 0) + 1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown parse failure';
      failureReasons.set(message, (failureReasons.get(message) ?? 0) + 1);
      if (!failureSamples.has(message)) failureSamples.set(message, file.evidencePath);
      failures.push({
        path: file.evidencePath,
        kind: file.kind,
        error: message,
      });
    }
  }

  return {
    schema_version: 1,
    discovered_files: files.length,
    parsed_files: parsed,
    parse_coverage_percent: files.length === 0 ? 0 : (parsed / files.length) * 100,
    counts,
    diagnostics: Object.fromEntries([...diagnosticCodes.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'))),
    parse_failure_count: failures.length,
    parse_failure_reasons: Object.fromEntries([...failureReasons.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'))),
    parse_failure_samples: Object.fromEntries([...failureSamples.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'))),
    parse_failures: failures.slice(0, MAX_REPORTED_FAILURES),
    parse_failures_truncated: failures.length > MAX_REPORTED_FAILURES,
    skipped_symlinks: collected.reduce((total, value) => total + value.skippedSymlinks, 0),
  };
}

function parseCliRoots(argv) {
  const roots = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--root' || argv[index + 1] === undefined) throw new TypeError('usage: node tools/audit-module-corpus.mjs --root <absolute-path> [--root <absolute-path>]');
    roots.push(argv[index + 1]);
    index += 1;
  }
  return roots;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await auditModuleCorpus(parseCliRoots(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.parse_failure_count > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'module corpus audit failed'}\n`);
    process.exitCode = 2;
  }
}
