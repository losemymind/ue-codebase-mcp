import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ExtractedFileEdge, ExtractedSymbolEdge, RelationShard } from './relation-index.ts';

export interface CursorIndexerRequest {
  executable: string;
  tool_root: string;
  workspace_root: string;
  related_workspace_roots?: readonly string[];
  source_file: string;
  compile_arguments: readonly string[];
  arguments_file?: string;
  arguments_root?: string;
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
  relation_shard?: RelationShard;
}

const SYMBOL_KINDS = new Set(['namespace', 'class', 'struct', 'union', 'enum', 'enumerator', 'function', 'method', 'constructor', 'destructor', 'variable', 'field', 'parameter', 'typedef', 'type_alias', 'macro', 'concept']);
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const MAX_RECORDS = 2_000_001;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const RELATION_EDGE_TYPES = new Set(['calls', 'references', 'inherits', 'overrides']);
const MAX_RELATION_TEXT = 4096;
const MAX_RELATION_COORDINATE = 10_000_000;

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
    || ['-include-pch', '-pch-through-header'].includes(value)
    || value.startsWith('-fplugin=') || value.startsWith('-fpass-plugin=') || value.startsWith('/clang:-load')
    || value.startsWith('-fmodules-cache-path=') || value.startsWith('-fmodule-output=') || value.startsWith('-save-temps')
    || /^(?:\/Fo|\/Fe|\/Fa|\/Fm|\/FR|\/Fd|\/Fp|\/Yc|\/Yu|\/ifcOutput|\/sourceDependencies|\/module:output)/i.test(argument)
    || argument.startsWith('/Fi')
    || value.startsWith('/clang:-include-pch')
    || (previous?.toLowerCase() === '-xclang' && ['-load', '-plugin', '-add-plugin', '-fmodules-cache-path', '-fmodule-output'].includes(value));
}

export function buildCursorIndexerInvocation(request: CursorIndexerRequest): CursorIndexerInvocation {
  if (!path.isAbsolute(request.tool_root) || !path.isAbsolute(request.workspace_root)) throw new TypeError('cursor indexer roots must be absolute');
  const executable = below(request.tool_root, request.executable, 'cursor indexer executable');
  if (path.basename(executable).toLowerCase() !== 'clang-cursor-indexer.exe') throw new TypeError('cursor indexer executable name is invalid');
  const workspace = path.resolve(request.workspace_root);
  if (request.related_workspace_roots !== undefined && (!Array.isArray(request.related_workspace_roots)
      || request.related_workspace_roots.length > 63 || request.related_workspace_roots.some((root) => !path.isAbsolute(root)))) {
    throw new TypeError('cursor indexer roots must be absolute');
  }
  const relatedRoots = (request.related_workspace_roots ?? []).map((root) => path.resolve(root));
  if (new Set([workspace.toLowerCase(), ...relatedRoots.map((root) => root.toLowerCase())]).size !== relatedRoots.length + 1) {
    throw new TypeError('cursor indexer roots must be unique');
  }
  const source = below(workspace, request.source_file, 'cursor source file');
  const fileMode = request.arguments_file !== undefined || request.arguments_root !== undefined;
  if ((request.arguments_file === undefined) !== (request.arguments_root === undefined)
      || !/\.(?:c|cc|cpp|cxx|m|mm)$/i.test(source) || !Array.isArray(request.compile_arguments)
      || request.compile_arguments.length > 16_384 || (fileMode && request.compile_arguments.length !== 0)) {
    throw new TypeError('cursor indexer request is invalid');
  }
  const compileArguments = [...request.compile_arguments];
  for (let index = 0; index < compileArguments.length; index += 1) {
    const argument = compileArguments[index];
    if (typeof argument !== 'string' || argument.length === 0 || argument.length > 65_536 || /[\r\n\0]/.test(argument) || forbiddenArgument(argument, compileArguments[index - 1])) {
      throw new TypeError('cursor compile argument is forbidden');
    }
  }
  let args: string[];
  const rootArguments = relatedRoots.flatMap((root) => ['--workspace-root', root]);
  if (fileMode) {
    if (!path.isAbsolute(request.arguments_root!) || !path.isAbsolute(request.arguments_file!)) throw new TypeError('cursor argument file roots must be absolute');
    const argumentsRoot = path.resolve(request.arguments_root!);
    const argumentsFile = below(argumentsRoot, request.arguments_file!, 'cursor argument file');
    if (path.extname(argumentsFile).toLowerCase() !== '.args') throw new TypeError('cursor argument file name is invalid');
    args = ['--source', source, '--workspace-root', workspace, ...rootArguments, '--arguments-file', argumentsFile, '--arguments-root', argumentsRoot, '--'];
  } else {
    args = ['--source', source, '--workspace-root', workspace, ...rootArguments, '--', ...compileArguments];
  }
  return Object.freeze({
    executable,
    cwd: workspace,
    args: Object.freeze(args),
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

function relationText(value: unknown, name: string): string {
  const encoded = string(value, name);
  if (encoded.length > MAX_RELATION_TEXT) throw new TypeError(`${name} is invalid`);
  return encoded;
}

function relationCoordinate(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_RELATION_COORDINATE) {
    throw new TypeError(`${name} is invalid`);
  }
  return value as number;
}

function documentation(value: string): string | undefined {
  const normalized = value.split(/\r?\n/).map((line) => line.replace(/\*\/\s*$/, '').replace(/^\s*(?:\/\/\/?|\/\*\*?|\*)\s?/, '').trimEnd()).join('\n').trim();
  return normalized || undefined;
}

function documentationText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024 * 1024 || value.includes('\0')) throw new TypeError('cursor documentation is invalid');
  return value;
}

export function parseCursorIndexerJsonLines(output: string, workspaceRoots: readonly string[]): CursorIndexResult {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES || !Array.isArray(workspaceRoots) || workspaceRoots.length === 0 || workspaceRoots.some((root) => !path.isAbsolute(root))) throw new TypeError('cursor index output is invalid');
  const roots = workspaceRoots.map((root) => path.resolve(root));
  const lines = output.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n').filter(Boolean);
  if (lines.length === 0 || lines.length > MAX_RECORDS || lines.some((line) => Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES)) throw new TypeError('cursor index record count is invalid');
  let manifest: Record<string, unknown> | undefined;
  const symbols = new Map<string, CursorSymbol>();
  const locationKeys = new Map<string, Set<string>>();
  const symbolRecordCounts = new Map<string, number>();
  const ambiguousUsrs = new Set<string>();
  const symbolEdges: ExtractedSymbolEdge[] = [];
  const fileEdges: ExtractedFileEdge[] = [];
  let protocolVersion: 1 | 2 | undefined;
  let unidentified = 0;
  for (let index = 0; index < lines.length; index += 1) {
    let parsed: unknown;
    try { parsed = JSON.parse(lines[index]); } catch { throw new TypeError('cursor index JSON is invalid'); }
    const value = object(parsed, 'cursor index record');
    if (index === 0) {
      exactKeys(value, ['type', 'schema_version', 'libclang', 'diagnostic_count', 'error_count'], 'cursor manifest');
      if (value.type !== 'manifest' || (value.schema_version !== 1 && value.schema_version !== 2)) throw new TypeError('cursor manifest version is invalid');
      string(value.libclang, 'libclang version');
      count(value.diagnostic_count, 'diagnostic count');
      count(value.error_count, 'error count');
      protocolVersion = value.schema_version;
      manifest = value;
      continue;
    }
    if (value.type === 'symbol_edge') {
      if (protocolVersion !== 2) throw new TypeError('cursor relation record requires protocol version 2');
      exactKeys(value, ['type', 'edge_type', 'src_usr', 'dst_usr', 'file', 'line', 'column', 'confidence'], 'cursor symbol edge');
      const edgeType = string(value.edge_type, 'cursor relation edge type');
      if (!RELATION_EDGE_TYPES.has(edgeType)) throw new TypeError('cursor relation edge type is unsupported');
      const srcUsr = relationText(value.src_usr, 'cursor relation source USR');
      const dstUsr = relationText(value.dst_usr, 'cursor relation destination USR');
      if ((edgeType === 'inherits' || edgeType === 'overrides') && srcUsr === dstUsr) throw new TypeError('cursor relation identity is invalid');
      const fileValue = relationText(value.file, 'cursor relation file');
      const file = roots.map((root) => { try { return below(root, fileValue, 'cursor relation file'); } catch { return undefined; } }).find((candidate) => candidate !== undefined);
      const line = relationCoordinate(value.line, 'cursor relation line');
      const column = relationCoordinate(value.column, 'cursor relation column');
      if (file === undefined || typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
        throw new TypeError('cursor relation evidence is invalid');
      }
      symbolEdges.push(Object.freeze({ edge_type: edgeType as ExtractedSymbolEdge['edge_type'], src_usr: srcUsr, dst_usr: dstUsr, file, line, column, confidence: value.confidence }));
      continue;
    }
    if (value.type === 'file_edge') {
      if (protocolVersion !== 2) throw new TypeError('cursor relation record requires protocol version 2');
      exactKeys(value, ['type', 'edge_type', 'src_file', 'dst_file', 'line', 'column'], 'cursor file edge');
      if (value.edge_type !== 'include') throw new TypeError('cursor file edge type is unsupported');
      const resolveFile = (candidate: unknown, name: string): string | undefined => {
        const encoded = relationText(candidate, name);
        return roots.map((root) => { try { return below(root, encoded, name); } catch { return undefined; } }).find((item) => item !== undefined);
      };
      const srcFile = resolveFile(value.src_file, 'cursor include source file');
      const dstFile = resolveFile(value.dst_file, 'cursor include destination file');
      const line = relationCoordinate(value.line, 'cursor include line');
      const column = relationCoordinate(value.column, 'cursor include column');
      if (srcFile === undefined || dstFile === undefined || srcFile === dstFile) throw new TypeError('cursor include evidence is invalid');
      fileEdges.push(Object.freeze({ edge_type: 'include', src_file: srcFile, dst_file: dstFile, line, column }));
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
    const qualifiedNameWithoutDivisionOperators = qualifiedName.replace(/operator\/(?:=)?/g, 'operator');
    const qualifiedNameIsPathLike = qualifiedName !== ''
      && (path.isAbsolute(qualifiedName) || qualifiedName.includes('\\') || qualifiedNameWithoutDivisionOperators.includes('/'));
    const ownerUsr = value.owner_usr === null ? undefined : string(value.owner_usr, 'cursor owner USR');
    const typeSpelling = string(value.type_spelling, 'cursor type', true);
    const resultType = string(value.result_type, 'cursor result type', true);
    const comment = value.documentation === null ? undefined : documentation(documentationText(value.documentation));
    const fileValue = string(value.file, 'cursor file');
    const file = roots.map((root) => { try { return below(root, fileValue, 'cursor file'); } catch { return undefined; } }).find((candidate) => candidate !== undefined);
    if (file === undefined) throw new TypeError('cursor file escapes configured workspaces');
    const startLine = count(value.start_line, 'cursor start line');
    const startColumn = count(value.start_column, 'cursor start column');
    const endLine = count(value.end_line, 'cursor end line');
    const endColumn = count(value.end_column, 'cursor end column');
    const rangeIsUsable = startLine >= 1 && startColumn >= 1 && endLine >= startLine
      && (endLine !== startLine || endColumn >= startColumn);
    if (usr === undefined || !name || !displayName || !qualifiedName || qualifiedNameIsPathLike || !rangeIsUsable) { unidentified += 1; continue; }
    if (ambiguousUsrs.has(usr)) { unidentified += 1; continue; }
    const location: CursorLocation = Object.freeze({ kind: kind === 'macro' || value.is_definition ? 'definition' : 'declaration', file, start_line: startLine, start_column: startColumn, end_line: endLine, end_column: endColumn });
    const existing = symbols.get(usr);
    if (existing !== undefined && (existing.kind !== kind || existing.name !== name || existing.qualified_name !== qualifiedName
        || existing.display_name !== displayName || existing.owner_usr !== ownerUsr
        || (existing.type_spelling && typeSpelling && existing.type_spelling !== typeSpelling)
        || (existing.result_type && resultType && existing.result_type !== resultType))) {
      unidentified += (symbolRecordCounts.get(usr) ?? 0) + 1;
      symbols.delete(usr);
      locationKeys.delete(usr);
      symbolRecordCounts.delete(usr);
      ambiguousUsrs.add(usr);
      continue;
    }
    const selectedTypeSpelling = existing?.type_spelling || typeSpelling;
    const selectedResultType = existing?.result_type || resultType;
    const signature = JSON.stringify({ kind, qualified_name: qualifiedName, display_name: displayName, type_spelling: selectedTypeSpelling, result_type: selectedResultType });
    const key = JSON.stringify(location);
    const keys = locationKeys.get(usr) ?? new Set<string>();
    if (!keys.has(key)) keys.add(key);
    locationKeys.set(usr, keys);
    const locations = [...(existing?.locations ?? [])];
    if (!locations.some((candidate) => JSON.stringify(candidate) === key)) locations.push(location);
    const bestDocumentation = [existing?.documentation, comment].filter((candidate): candidate is string => candidate !== undefined).sort((left, right) => right.length - left.length)[0];
    symbols.set(usr, Object.freeze({
      stable_usr: usr, qualified_name: qualifiedName, name, display_name: displayName, kind,
      ...(ownerUsr === undefined ? {} : { owner_usr: ownerUsr }), type_spelling: selectedTypeSpelling, result_type: selectedResultType,
      ...(bestDocumentation === undefined ? {} : { documentation: bestDocumentation }),
      signature_hash: createHash('sha256').update(signature).digest('hex'), locations: Object.freeze(locations),
    }));
    symbolRecordCounts.set(usr, (symbolRecordCounts.get(usr) ?? 0) + 1);
  }
  if (manifest === undefined) throw new TypeError('cursor manifest is missing');
  return Object.freeze({
    schema_version: 1, libclang: manifest.libclang as string,
    diagnostic_count: manifest.diagnostic_count as number, error_count: manifest.error_count as number,
    unidentified_count: unidentified,
    symbols: Object.freeze([...symbols.values()].sort((left, right) => left.stable_usr.localeCompare(right.stable_usr, 'en'))),
    ...(protocolVersion === 2 ? { relation_shard: Object.freeze({ schema_version: 1, symbol_edges: Object.freeze(symbolEdges), file_edges: Object.freeze(fileEdges) }) } : {}),
  });
}
