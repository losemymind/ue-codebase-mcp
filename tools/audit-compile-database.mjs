import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadCompileDatabaseResponseFiles,
  normalizeCompileDatabase,
  parseWindowsCommandLine,
} from '../workers/clang-indexer/src/compile-database.ts';

function parseArguments(argv) {
  let database;
  const roots = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (value === undefined) throw new TypeError('compile database audit arguments are incomplete');
    if (argv[index] === '--database' && database === undefined) database = value;
    else if (argv[index] === '--workspace-root') roots.push(value);
    else throw new TypeError('usage: node tools/audit-compile-database.mjs --database <absolute-path> --workspace-root <absolute-path> [--workspace-root <absolute-path>]');
    index += 1;
  }
  if (typeof database !== 'string' || !path.isAbsolute(database) || roots.length === 0 || roots.length > 16 || roots.some((root) => !path.isAbsolute(root))) {
    throw new TypeError('compile database audit requires absolute database and workspace paths');
  }
  return { database: path.resolve(database), roots: roots.map((root) => path.resolve(root)) };
}

function rootIndex(file, roots) {
  return roots.findIndex((root) => {
    const relative = path.relative(root, file);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

function evidencePath(file, directory, roots) {
  const absolute = path.normalize(path.isAbsolute(file) ? file : path.resolve(directory, file));
  const index = rootIndex(absolute, roots);
  return index < 0 ? 'outside-configured-roots' : `root-${index + 1}/${path.relative(roots[index], absolute).replaceAll('\\', '/')}`;
}

function translationUnitKey(entry) {
  return path.normalize(path.isAbsolute(entry.file) ? entry.file : path.resolve(entry.directory, entry.file)).toLowerCase();
}

export async function auditCompileDatabase(databasePath, workspaceRoots) {
  const json = await readFile(databasePath, 'utf8');
  if (Buffer.byteLength(json, 'utf8') > 256 * 1024 * 1024) throw new TypeError('compile database exceeds 256 MiB');
  let rawEntries;
  try { rawEntries = JSON.parse(json); } catch { throw new TypeError('compile database JSON is invalid'); }
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) throw new TypeError('compile database entries are invalid');
  const approvedEntries = [];
  const unsupportedDrivers = new Map();
  const unsupportedSamples = [];
  for (let index = 0; index < rawEntries.length; index += 1) {
    const entry = rawEntries[index];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new TypeError(`compile entry ${index} is invalid`);
    const args = entry.arguments ?? parseWindowsCommandLine(entry.command);
    if (!Array.isArray(args) || typeof args[0] !== 'string') throw new TypeError(`compile entry ${index} arguments are invalid`);
    const driver = path.basename(args[0]).toLowerCase();
    if (/^(?:clang|clang-cl)(?:\.exe)?$/i.test(driver)) approvedEntries.push(entry);
    else {
      unsupportedDrivers.set(driver, (unsupportedDrivers.get(driver) ?? 0) + 1);
      if (unsupportedSamples.length < 20) unsupportedSamples.push({ entry_index: index, driver, source: evidencePath(entry.file, entry.directory, workspaceRoots) });
    }
  }
  if (approvedEntries.length === 0) throw new TypeError('compile database contains no approved Clang entries');
  const approvedJson = JSON.stringify(approvedEntries);
  const responseFiles = await loadCompileDatabaseResponseFiles(approvedJson, workspaceRoots, (responsePath) => readFile(responsePath, 'utf8'));
  const commands = normalizeCompileDatabase(approvedJson, workspaceRoots, { response_files: responseFiles });
  const rawTranslationUnits = new Set(rawEntries.map(translationUnitKey));
  const normalizedTranslationUnits = new Set(commands.map(({ file }) => path.normalize(file).toLowerCase()));
  const coverage = (normalizedTranslationUnits.size / rawTranslationUnits.size) * 100;
  const variantCounts = new Map();
  for (const command of commands) {
    const key = path.normalize(command.file).toLowerCase();
    variantCounts.set(key, (variantCounts.get(key) ?? 0) + 1);
  }
  const commandsByRoot = Object.fromEntries(workspaceRoots.map((_, index) => [`root-${index + 1}`, 0]));
  let outsideRoots = 0;
  for (const command of commands) {
    const index = rootIndex(command.file, workspaceRoots);
    if (index < 0) outsideRoots += 1;
    else commandsByRoot[`root-${index + 1}`] += 1;
  }
  return {
    schema_version: 1,
    database_sha256: createHash('sha256').update(json).digest('hex'),
    database_bytes: Buffer.byteLength(json, 'utf8'),
    raw_entries: rawEntries.length,
    normalized_commands: commands.length,
    raw_unique_tus: rawTranslationUnits.size,
    normalized_unique_tus: normalizedTranslationUnits.size,
    normalization_coverage_percent: coverage,
    meets_99_percent: coverage >= 99,
    multi_variant_tus: [...variantCounts.values()].filter((count) => count > 1).length,
    unsupported_driver_entries: rawEntries.length - approvedEntries.length,
    unsupported_driver_counts: Object.fromEntries([...unsupportedDrivers].sort(([left], [right]) => left.localeCompare(right, 'en'))),
    unsupported_driver_samples: unsupportedSamples,
    response_files: responseFiles.size,
    response_file_bytes: [...responseFiles.values()].reduce((total, content) => total + Buffer.byteLength(content, 'utf8'), 0),
    commands_by_root: commandsByRoot,
    commands_outside_roots: outsideRoots,
    compiler_drivers: [...new Set(commands.map(({ compiler }) => path.basename(compiler).toLowerCase()))].sort(),
    commands_with_include_paths: commands.filter(({ include_paths: values }) => values.length > 0).length,
    commands_with_forced_includes: commands.filter(({ forced_includes: values }) => values.length > 0).length,
    commands_with_definitions: commands.filter(({ definitions: values }) => values.length > 0).length,
    unique_content_hashes: new Set(commands.map(({ content_hash: value }) => value)).size,
  };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { database, roots } = parseArguments(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(await auditCompileDatabase(database, roots), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'compile database audit failed'}\n`);
    process.exitCode = 2;
  }
}
