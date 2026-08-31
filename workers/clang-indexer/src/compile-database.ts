import { createHash } from 'node:crypto';
import path from 'node:path';

export interface RawCompileCommand {
  directory: string;
  file: string;
  arguments?: string[];
  command?: string;
  output?: string;
}

export interface NormalizedCompileCommand {
  directory: string;
  file: string;
  compiler: string;
  arguments: readonly string[];
  include_paths: readonly string[];
  forced_includes: readonly string[];
  definitions: readonly string[];
  content_hash: string;
}

export interface TranslationUnitExemption {
  path: string;
  reason: string;
  risk: string;
  approved_by: string;
}

export interface CoverageReport {
  discovered_tus: number;
  covered_tus: number;
  exempted_tus: number;
  uncovered: string[];
  exemptions: TranslationUnitExemption[];
  raw_coverage_percent: number;
  acceptance_coverage_percent: number;
  meets_99_percent: boolean;
}

export interface UbtCompileDatabaseRequest {
  ubt_executable: string;
  workspace_root: string;
  project_file: string;
  target: string;
  platform: 'Win64';
  configuration: 'Debug' | 'DebugGame' | 'Development' | 'Shipping' | 'Test';
  output_file: string;
}

export interface UbtInvocation {
  executable: string;
  args: readonly string[];
  cwd: string;
}

export interface CompileDatabaseOptions {
  response_files?: ReadonlyMap<string, string>;
}

export type CompileResponseFileReader = (absolutePath: string) => Promise<string>;

const SOURCE_EXTENSION = /\.(?:c|cc|cpp|cxx|m|mm)$/i;
const TARGET = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const MAX_DATABASE_BYTES = 256 * 1024 * 1024;
const MAX_DATABASE_ENTRIES = 1_000_000;
const MAX_RESPONSE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_FILES = 50_000;
const MAX_RESPONSE_FILES_TOTAL_BYTES = 192 * 1024 * 1024;
const SEPARATE_OUTPUT_ARGUMENTS = new Set([
  '/fo', '-o', '/fe', '/fa', '/fi', '/fm', '/fr', '/fd', '/ifcoutput', '/sourcedependencies', '/module:output',
  '-mf', '-mj', '-serialize-diagnostic-file', '--serialize-diagnostics', '-fmodules-cache-path', '-fmodule-output',
  '/fp', '/yc', '/yu', '-include-pch', '-pch-through-header',
]);

function joinedOutputArgument(argument: string): boolean {
  return /^(?:\/Fo|\/Fe|\/Fa|\/Fi|\/Fm|\/FR|\/Fd|\/Fp|\/Yc|\/Yu|\/ifcOutput|\/sourceDependencies|\/module:output)(?::|=)?.+/i.test(argument)
    || /^(?:-MF|-MJ).+/i.test(argument)
    || /^(?:-serialize-diagnostic-file|--serialize-diagnostics|-fmodules-cache-path|-fmodule-output|-include-pch|-pch-through-header)=.+/i.test(argument)
    || /^-save-temps(?:=.+)?$/i.test(argument);
}

function confined(root: string, value: string, name: string): string {
  if (!path.isAbsolute(root) || !path.isAbsolute(value)) throw new TypeError(`${name} must be absolute`);
  const normalizedRoot = path.resolve(root);
  const normalized = path.resolve(value);
  const relative = path.relative(normalizedRoot, normalized);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new TypeError(`${name} must remain below the workspace root`);
  return normalized;
}

export function parseWindowsCommandLine(command: string): string[] {
  if (typeof command !== 'string' || command.length === 0 || command.length > 1_048_576 || /[\r\n\0]/.test(command)) throw new TypeError('compile command string is invalid');
  const result: string[] = [];
  let index = 0;
  while (index < command.length) {
    while (/\s/.test(command[index] ?? '')) index += 1;
    if (index >= command.length) break;
    let argument = '';
    let quoted = false;
    while (index < command.length) {
      if (!quoted && /\s/.test(command[index])) break;
      let slashes = 0;
      while (command[index] === '\\') { slashes += 1; index += 1; }
      if (command[index] === '"') {
        argument += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 0) quoted = !quoted;
        else argument += '"';
        index += 1;
        continue;
      }
      argument += '\\'.repeat(slashes);
      if (index < command.length) { argument += command[index]; index += 1; }
    }
    if (quoted) throw new TypeError('compile command has an unterminated quote');
    result.push(argument);
  }
  if (result.length === 0 || result.length > 16_384) throw new TypeError('compile command argument count is invalid');
  return result;
}

function absoluteFrom(base: string, value: string): string {
  return path.normalize(path.isAbsolute(value) ? value : path.resolve(base, value));
}

function normalizedPathArgument(base: string, value: string): string {
  if (!value || /[\r\n\0]/.test(value)) throw new TypeError('compile path argument is invalid');
  return absoluteFrom(base, value.replace(/^"|"$/g, ''));
}

function parseCompileDatabaseJson(json: string): unknown[] {
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_DATABASE_BYTES) throw new TypeError('compile database exceeds 256 MiB');
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new TypeError('compile database JSON is invalid'); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_DATABASE_ENTRIES) throw new TypeError('compile database entries are invalid');
  return parsed;
}

function responseFilePath(argument: string, directory: string, roots: readonly string[]): string {
  const encodedPath = argument.slice(1).replace(/^"|"$/g, '');
  if (!encodedPath || /[\r\n\0]/.test(encodedPath)) throw new TypeError('compile response file path is invalid');
  const responsePath = absoluteFrom(directory, encodedPath);
  if (!roots.some((root) => { const relative = path.relative(root, responsePath); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); })) {
    throw new TypeError('compile response file escapes configured workspaces');
  }
  return responsePath;
}

function parseResponseFile(content: string): string[] {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_RESPONSE_FILE_BYTES || content.includes('\0')) {
    throw new TypeError('compile response file is unavailable or invalid');
  }
  return parseWindowsCommandLine(content.replaceAll('\r\n', ' ').replaceAll('\n', ' ').replaceAll('\r', ' '));
}

function expandResponseFiles(args: string[], directory: string, roots: readonly string[], files: ReadonlyMap<string, string> | undefined, depth = 0): string[] {
  if (depth > 4) throw new TypeError('compile response file nesting is too deep');
  const output: string[] = [];
  for (const argument of args) {
    if (!argument.startsWith('@')) { output.push(argument); continue; }
    const responsePath = responseFilePath(argument, directory, roots);
    const content = files?.get(responsePath);
    if (content === undefined) throw new TypeError('compile response file is unavailable or invalid');
    const parsed = parseResponseFile(content);
    output.push(...expandResponseFiles(parsed, directory, roots, files, depth + 1));
  }
  if (output.length > 16_384) throw new TypeError('expanded compile arguments exceed the limit');
  return output;
}

/**
 * Loads only workspace-confined response files referenced by a compile database.
 * The injected reader keeps filesystem access explicit and testable; no command is
 * executed and response-file contents are never included in diagnostics.
 */
export async function loadCompileDatabaseResponseFiles(
  json: string,
  workspaceRoots: readonly string[],
  reader: CompileResponseFileReader,
): Promise<ReadonlyMap<string, string>> {
  if (!Array.isArray(workspaceRoots) || workspaceRoots.length === 0) throw new TypeError('workspace roots are required');
  if (typeof reader !== 'function') throw new TypeError('compile response file reader is required');
  const roots = workspaceRoots.map((root) => path.resolve(root));
  const parsed = parseCompileDatabaseJson(json);
  const initial: Array<{ argument: string; directory: string; depth: number }> = [];
  for (let entryIndex = 0; entryIndex < parsed.length; entryIndex += 1) {
    const value = parsed[entryIndex];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`compile entry ${entryIndex} is invalid`);
    const raw = value as RawCompileCommand;
    if (typeof raw.directory !== 'string' || !path.isAbsolute(raw.directory)) throw new TypeError(`compile entry ${entryIndex} path is invalid`);
    if ((raw.arguments === undefined) === (raw.command === undefined)) throw new TypeError(`compile entry ${entryIndex} must contain exactly one argument representation`);
    if (raw.arguments !== undefined && (!Array.isArray(raw.arguments) || raw.arguments.length === 0 || raw.arguments.length > 16_384 || raw.arguments.some((argument) => typeof argument !== 'string' || /[\r\n\0]/.test(argument)))) {
      throw new TypeError(`compile entry ${entryIndex} arguments are invalid`);
    }
    const args = raw.arguments === undefined ? parseWindowsCommandLine(raw.command!) : raw.arguments;
    for (const argument of args.slice(1)) if (argument.startsWith('@')) initial.push({ argument, directory: path.resolve(raw.directory), depth: 0 });
  }

  const files = new Map<string, string>();
  const canonicalFiles = new Map<string, string>();
  const pending = [...initial];
  let totalBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > 4) throw new TypeError('compile response file nesting is too deep');
    const responsePath = responseFilePath(current.argument, current.directory, roots);
    const canonicalPath = responsePath.toLowerCase();
    const cached = canonicalFiles.get(canonicalPath);
    if (cached !== undefined) { files.set(responsePath, cached); continue; }
    if (canonicalFiles.size >= MAX_RESPONSE_FILES) throw new TypeError('compile response file count exceeds the limit');
    let content: string;
    try { content = await reader(responsePath); } catch { throw new TypeError('compile response file is unavailable or invalid'); }
    const bytes = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : MAX_RESPONSE_FILE_BYTES + 1;
    if (bytes > MAX_RESPONSE_FILE_BYTES || totalBytes + bytes > MAX_RESPONSE_FILES_TOTAL_BYTES) throw new TypeError('compile response file bytes exceed the limit');
    const responseArgs = parseResponseFile(content);
    totalBytes += bytes;
    canonicalFiles.set(canonicalPath, content);
    files.set(responsePath, content);
    for (const argument of responseArgs) if (argument.startsWith('@')) pending.push({ argument, directory: current.directory, depth: current.depth + 1 });
  }
  return files;
}

export function normalizeCompileDatabase(json: string, workspaceRoots: readonly string[], options: CompileDatabaseOptions = {}): NormalizedCompileCommand[] {
  if (!Array.isArray(workspaceRoots) || workspaceRoots.length === 0) throw new TypeError('workspace roots are required');
  const roots = workspaceRoots.map((root) => path.resolve(root));
  const parsed = parseCompileDatabaseJson(json);
  const commands = parsed.map((value, entryIndex) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`compile entry ${entryIndex} is invalid`);
    const raw = value as RawCompileCommand;
    if (Object.keys(raw).some((key) => !['directory', 'file', 'arguments', 'command', 'output'].includes(key))) throw new TypeError(`compile entry ${entryIndex} contains an unknown field`);
    if (typeof raw.directory !== 'string' || !path.isAbsolute(raw.directory) || typeof raw.file !== 'string' || !SOURCE_EXTENSION.test(raw.file)) throw new TypeError(`compile entry ${entryIndex} path is invalid`);
    if ((raw.arguments === undefined) === (raw.command === undefined)) throw new TypeError(`compile entry ${entryIndex} must contain exactly one argument representation`);
    const directory = path.resolve(raw.directory);
    const file = absoluteFrom(directory, raw.file);
    if (!roots.some((root) => { const relative = path.relative(root, file); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); })) throw new TypeError(`compile entry ${entryIndex} file escapes configured workspaces`);
    if (raw.arguments !== undefined && (!Array.isArray(raw.arguments) || raw.arguments.length === 0 || raw.arguments.length > 16_384 || raw.arguments.some((argument) => typeof argument !== 'string'))) throw new TypeError(`compile entry ${entryIndex} arguments are invalid`);
    const encodedArgs = raw.arguments === undefined ? parseWindowsCommandLine(raw.command!) : [...raw.arguments];
    const args = [encodedArgs[0], ...expandResponseFiles(encodedArgs.slice(1), directory, roots, options.response_files)];
    if (args.length === 0 || args.length > 16_384 || args.some((argument) => typeof argument !== 'string' || /[\r\n\0]/.test(argument))) throw new TypeError(`compile entry ${entryIndex} arguments are invalid`);
    const compiler = absoluteFrom(directory, args[0]);
    if (!/^(?:clang|clang-cl)(?:\.exe)?$/i.test(path.basename(compiler))) throw new TypeError(`compile entry ${entryIndex} does not use the approved Clang driver`);
    const normalized: string[] = [];
    const includePaths: string[] = [];
    const forcedIncludes: string[] = [];
    const definitions: string[] = [];
    for (let index = 1; index < args.length; index += 1) {
      const argument = args[index];
      const separatePath = ['/I', '-I', '-isystem', '/FI', '-include'].includes(argument);
      if (separatePath) {
        const next = args[++index];
        if (next === undefined) throw new TypeError(`compile entry ${entryIndex} has a missing path argument`);
        const resolved = normalizedPathArgument(directory, next);
        normalized.push(argument, resolved);
        if (argument === '/FI' || argument === '-include') forcedIncludes.push(resolved); else includePaths.push(resolved);
        continue;
      }
      const joined = /^(\/I|-I|\/FI)(.+)$/.exec(argument);
      if (joined) {
        const resolved = normalizedPathArgument(directory, joined[2]);
        normalized.push(joined[1], resolved);
        if (joined[1] === '/FI') forcedIncludes.push(resolved); else includePaths.push(resolved);
        continue;
      }
      const definition = /^(?:\/D|-D)(.+)$/.exec(argument);
      if (definition) {
        if (definition[1].length === 0 || definition[1].length > 4096) throw new TypeError(`compile entry ${entryIndex} definition is invalid`);
        definitions.push(definition[1]);
        normalized.push('/D', definition[1]);
        continue;
      }
      if (SEPARATE_OUTPUT_ARGUMENTS.has(argument.toLowerCase())) {
        index += 1;
        if (index >= args.length) throw new TypeError(`compile entry ${entryIndex} output argument is missing`);
        continue;
      }
      if (joinedOutputArgument(argument)) continue;
      normalized.push(argument === raw.file || absoluteFrom(directory, argument) === file ? file : argument);
    }
    const stable = { directory, file, compiler, arguments: normalized };
    return Object.freeze({
      ...stable,
      arguments: Object.freeze(normalized),
      include_paths: Object.freeze([...new Set(includePaths)]),
      forced_includes: Object.freeze([...new Set(forcedIncludes)]),
      definitions: Object.freeze([...new Set(definitions)]),
      content_hash: createHash('sha256').update(JSON.stringify(stable)).digest('hex'),
    });
  });
  const variants = new Map<string, Set<string>>();
  for (const command of commands) {
    const key = command.file.toLowerCase();
    const hashes = variants.get(key) ?? new Set<string>();
    if (hashes.has(command.content_hash)) throw new TypeError(`compile database contains duplicate TU variant ${command.file}`);
    hashes.add(command.content_hash);
    variants.set(key, hashes);
  }
  return commands;
}

export function createCoverageReport(discovered: readonly string[], commands: readonly NormalizedCompileCommand[], exemptions: readonly TranslationUnitExemption[] = []): CoverageReport {
  const units = [...new Set(discovered.map((value) => path.normalize(value).toLowerCase()))].sort();
  if (units.length === 0 || units.some((value) => !path.isAbsolute(value) || !SOURCE_EXTENSION.test(value))) throw new TypeError('discovered translation units are invalid');
  const covered = new Set(commands.map(({ file }) => path.normalize(file).toLowerCase()));
  const exemptionMap = new Map<string, TranslationUnitExemption>();
  for (const exemption of exemptions) {
    const key = path.normalize(exemption.path).toLowerCase();
    if (!units.includes(key) || exemptionMap.has(key) || !exemption.reason || !exemption.risk || !exemption.approved_by) throw new TypeError('translation unit exemption is invalid');
    exemptionMap.set(key, Object.freeze({ ...exemption }));
  }
  const uncovered = units.filter((unit) => !covered.has(unit));
  const exempted = uncovered.filter((unit) => exemptionMap.has(unit));
  const accepted = units.length - uncovered.length + exempted.length;
  const raw = ((units.length - uncovered.length) / units.length) * 100;
  const acceptance = (accepted / units.length) * 100;
  return Object.freeze({
    discovered_tus: units.length, covered_tus: units.length - uncovered.length, exempted_tus: exempted.length,
    uncovered: Object.freeze(uncovered), exemptions: Object.freeze(exempted.map((unit) => exemptionMap.get(unit)!)),
    raw_coverage_percent: raw, acceptance_coverage_percent: acceptance, meets_99_percent: acceptance >= 99,
  });
}

export function buildUbtCompileDatabaseInvocation(request: UbtCompileDatabaseRequest): UbtInvocation {
  const workspace = path.resolve(request.workspace_root);
  const executable = confined(workspace, request.ubt_executable, 'UBT executable');
  if (!/^UnrealBuildTool(?:\.exe)?$/i.test(path.basename(executable))) throw new TypeError('UBT executable name is invalid');
  const project = confined(workspace, request.project_file, 'project file');
  const output = confined(workspace, request.output_file, 'compile database output');
  if (!project.toLowerCase().endsWith('.uproject') || path.basename(output).toLowerCase() !== 'compile_commands.json' || !TARGET.test(request.target)) throw new TypeError('UBT compile database request is invalid');
  return Object.freeze({
    executable,
    cwd: workspace,
    args: Object.freeze([
      '-Mode=GenerateClangDatabase', `-Project=${project}`, request.target, request.platform, request.configuration,
      `-OutputDir=${path.dirname(output)}`, `-OutputFilename=${path.basename(output)}`,
      '-NoExecCodeGenActions', '-NoMutex', '-Unattended',
    ]),
  });
}
