import { createHash } from 'node:crypto';
import path from 'node:path';

export interface CursorIndexerRequest {
  executable: string;
  tool_root: string;
  workspace_root: string;
  source_file: string;
  compile_arguments: readonly string[];
}

export interface CursorIndexerInvocation {
  executable: string;
  args: readonly string[];
  cwd: string;
}

export interface CursorLocation {
  kind: 'declaration' | 'definition';
  file: string;
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
}

export interface CursorSymbol {
  stable_usr: string;
  qualified_name: string;
  name: string;
  display_name: string;
  kind: string;
  owner_usr?: string;
  type_spelling: string;
  result_type: string;
  documentation?: string;
  signature_hash: string;
  locations: readonly CursorLocation[];
}

export interface CursorIndexResult {
  schema_version: 1;
  libclang: string;
  diagnostic_count: number;
  error_count: number;
  unidentified_count: number;
  symbols: readonly CursorSymbol[];
}

const SYMBOL_KINDS = new Set(['namespace', 'class', 'struct', 'union', 'enum', 'enumerator', 'function', 'method', 'constructor', 'destructor', 'variable', 'field', 'parameter', 'typedef', 'type_alias', 'macro', 'concept']);
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const MAX_RECORDS = 2_000_001;
const MAX_LINE_BYTES = 4 * 1024 * 1024;

function below(root: string, value: string, name: string): string {
  if (!path.isAbsolute(root) || !path.isAbsolute(value)) throw new TypeError(`${name} must be absolute`);
  const normalizedRoot = path.resolve(root);
  const normalized = path.resolve(value);
  const relative = path.relative(normalizedRoot, normalized);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new TypeError(`${name} escapes its configured root`);
  return normalized;
}

function forbiddenArgument(argument: string, previous: string | undefined): boolean {
  const value = argument.toLowerCase();
  return ['-load', '-plugin', '-add-plugin', '-fplugin', '-o', '-mf', '-mj', '-serialize-diagnostic-file', '--serialize-diagnostics', '-fmodules-cache-path', '-fmodule-output'].includes(value)
    || value.startsWith('-fplugin=') || value.startsWith('-fpass-plugin=') || value.startsWith('/clang:-load')
    || value.startsWith('-fmodules-cache-path=') || value.startsWith('-fmodule-output=') || value.startsWith('-save-temps')
    || /^(?:\/Fo|\/Fe|\/Fa|\/Fi|\/Fm|\/FR|\/ifcOutput|\/sourceDependencies|\/module:output)/.test(argument)
    || (previous?.toLowerCase() === '-xclang' && ['-load', '-plugin', '-add-plugin', '-fmodules-cache-path', '-fmodule-output'].includes(value));
}

export function buildCursorIndexerInvocation(request: CursorIndexerRequest): CursorIndexerInvocation {
  if (!path.isAbsolute(request.tool_root) || !path.isAbsolute(request.workspace_root)) throw new TypeError('cursor indexer roots must be absolute');
  const executable = below(request.tool_root, request.executable, 'cursor indexer executable');
  if (path.basename(executable).toLowerCase() !== 'clang-cursor-indexer.exe') throw new TypeError('cursor indexer executable name is invalid');
  const workspace = path.resolve(request.workspace_root);
  const source = below(workspace, request.source_file, 'cursor source file');
  if (!/\.(?:c|cc|cpp|cxx|m|mm)$/i.test(source) || !Array.isArray(request.compile_arguments) || request.compile_arguments.length > 16_384) throw new TypeError('cursor indexer request is invalid');
  const compileArguments = [...request.compile_arguments];
  for (let index = 0; index < compileArguments.length; index += 1) {
    const argument = compileArguments[index];
    if (typeof argument !== 'string' || argument.length > 65_536 || /[\r\n\0]/.test(argument) || forbiddenArgument(argument, compileArguments[index - 1])) {
      throw new TypeError('cursor compile argument is forbidden');
    }
  }
  return Object.freeze({
    executable,
    cwd: workspace,
    args: Object.freeze(['--source', source, '--workspace-root', workspace, '--', ...compileArguments]),
  });
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) throw new TypeError(`${name} fields are invalid`);
}

function string(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > 65_536 || /[\r\n\0]/.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function count(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2_000_000) throw new TypeError(`${name} is invalid`);
  return value as number;
}

function documentation(value: string): string | undefined {
  const normalized = value.split(/\r?\n/).map((line) => line.replace(/^\s*(?:\/\/\/?|\/\*\*?|\*)\s?/, '').replace(/\*\/$/, '').trimEnd()).join('\n').trim();
  return normalized || undefined;
}

export function parseCursorIndexerJsonLines(output: string, workspaceRoots: readonly string[]): CursorIndexResult {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES || !Array.isArray(workspaceRoots) || workspaceRoots.length === 0 || workspaceRoots.some((root) => !path.isAbsolute(root))) throw new TypeError('cursor index output is invalid');
  const roots = workspaceRoots.map((root) => path.resolve(root));
  const lines = output.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n').filter(Boolean);
  if (lines.length === 0 || lines.length > MAX_RECORDS || lines.some((line) => Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES)) throw new TypeError('cursor index record count is invalid');
  let manifest: Record<string, unknown> | undefined;
  const symbols = new Map<string, CursorSymbol>();
  const locationKeys = new Map<string, Set<string>>();
  let unidentified = 0;
  for (let index = 0; index < lines.length; index += 1) {
    let parsed: unknown;
    try { parsed = JSON.parse(lines[index]); } catch { throw new TypeError('cursor index JSON is invalid'); }
    const value = object(parsed, 'cursor index record');
    if (index === 0) {
      exactKeys(value, ['type', 'schema_version', 'libclang', 'diagnostic_count', 'error_count'], 'cursor manifest');
      if (value.type !== 'manifest' || value.schema_version !== 1) throw new TypeError('cursor manifest version is invalid');
      string(value.libclang, 'libclang version');
      count(value.diagnostic_count, 'diagnostic count');
      count(value.error_count, 'error count');
      manifest = value;
      continue;
    }
    exactKeys(value, ['type', 'kind', 'usr', 'name', 'display_name', 'qualified_name', 'owner_usr', 'is_definition', 'file', 'start_line', 'start_column', 'end_line', 'end_column', 'type_spelling', 'result_type', 'documentation'], 'cursor symbol');
    if (value.type !== 'symbol' || typeof value.is_definition !== 'boolean') throw new TypeError('cursor symbol record is invalid');
    const kind = string(value.kind, 'cursor kind');
    if (!SYMBOL_KINDS.has(kind)) throw new TypeError('cursor kind is unsupported');
    const usr = value.usr === null ? undefined : string(value.usr, 'cursor USR');
    const name = string(value.name, 'cursor name', true);
    const displayName = string(value.display_name, 'cursor display name', true);
    const qualifiedName = string(value.qualified_name, 'cursor qualified name', true);
    if (qualifiedName && (path.isAbsolute(qualifiedName) || /[\\/]/.test(qualifiedName))) throw new TypeError('cursor qualified name is invalid');
    const ownerUsr = value.owner_usr === null ? undefined : string(value.owner_usr, 'cursor owner USR');
    const typeSpelling = string(value.type_spelling, 'cursor type', true);
    const resultType = string(value.result_type, 'cursor result type', true);
    const comment = value.documentation === null ? undefined : documentation(string(value.documentation, 'cursor documentation'));
    const fileValue = string(value.file, 'cursor file');
    const file = roots.map((root) => { try { return below(root, fileValue, 'cursor file'); } catch { return undefined; } }).find((candidate) => candidate !== undefined);
    if (file === undefined) throw new TypeError('cursor file escapes configured workspaces');
    const startLine = count(value.start_line, 'cursor start line');
    const startColumn = count(value.start_column, 'cursor start column');
    const endLine = count(value.end_line, 'cursor end line');
    const endColumn = count(value.end_column, 'cursor end column');
    if (startLine < 1 || startColumn < 1 || endLine < startLine || (endLine === startLine && endColumn < startColumn)) throw new TypeError('cursor source range is invalid');
    if (usr === undefined || !name || !displayName || !qualifiedName) { unidentified += 1; continue; }
    const location: CursorLocation = Object.freeze({ kind: kind === 'macro' || value.is_definition ? 'definition' : 'declaration', file, start_line: startLine, start_column: startColumn, end_line: endLine, end_column: endColumn });
    const signature = JSON.stringify({ kind, qualified_name: qualifiedName, display_name: displayName, type_spelling: typeSpelling, result_type: resultType });
    const existing = symbols.get(usr);
    if (existing !== undefined && (existing.kind !== kind || existing.name !== name || existing.qualified_name !== qualifiedName || existing.display_name !== displayName || existing.owner_usr !== ownerUsr || existing.type_spelling !== typeSpelling || existing.result_type !== resultType)) {
      throw new TypeError('cursor USR has conflicting symbol data');
    }
    const key = JSON.stringify(location);
    const keys = locationKeys.get(usr) ?? new Set<string>();
    if (!keys.has(key)) keys.add(key);
    locationKeys.set(usr, keys);
    const locations = [...(existing?.locations ?? [])];
    if (!locations.some((candidate) => JSON.stringify(candidate) === key)) locations.push(location);
    const bestDocumentation = [existing?.documentation, comment].filter((candidate): candidate is string => candidate !== undefined).sort((left, right) => right.length - left.length)[0];
    symbols.set(usr, Object.freeze({
      stable_usr: usr, qualified_name: qualifiedName, name, display_name: displayName, kind,
      ...(ownerUsr === undefined ? {} : { owner_usr: ownerUsr }), type_spelling: typeSpelling, result_type: resultType,
      ...(bestDocumentation === undefined ? {} : { documentation: bestDocumentation }),
      signature_hash: createHash('sha256').update(signature).digest('hex'), locations: Object.freeze(locations),
    }));
  }
  if (manifest === undefined) throw new TypeError('cursor manifest is missing');
  return Object.freeze({
    schema_version: 1, libclang: manifest.libclang as string,
    diagnostic_count: manifest.diagnostic_count as number, error_count: manifest.error_count as number,
    unidentified_count: unidentified,
    symbols: Object.freeze([...symbols.values()].sort((left, right) => left.stable_usr.localeCompare(right.stable_usr, 'en'))),
  });
}
