import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadCompileDatabaseResponseFiles,
  normalizeCompileDatabase,
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

export async function auditCompileDatabase(databasePath, workspaceRoots) {
  const json = await readFile(databasePath, 'utf8');
  const responseFiles = await loadCompileDatabaseResponseFiles(json, workspaceRoots, (responsePath) => readFile(responsePath, 'utf8'));
  const commands = normalizeCompileDatabase(json, workspaceRoots, { response_files: responseFiles });
  const rawEntries = JSON.parse(json).length;
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
    raw_entries: rawEntries,
    normalized_commands: commands.length,
    normalization_coverage_percent: (commands.length / rawEntries) * 100,
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
