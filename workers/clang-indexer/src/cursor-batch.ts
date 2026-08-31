import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import type { NormalizedCompileCommand } from './compile-database.ts';
import { CursorIndexerError, runCursorIndexer, type CursorExecutionPolicy, type CursorIndexerErrorCode } from './cursor-runner.ts';
import {
  buildCursorIndexerInvocation,
  type CursorIndexerInvocation,
  type CursorIndexResult,
  type CursorLocation,
  type CursorSymbol,
} from './cursor-stream.ts';
import { mergeRelationShards, type RelationShard } from './relation-index.ts';

export type CursorBatchErrorCode =
  | 'action-failed'
  | 'invalid-checkpoint'
  | 'invalid-plan'
  | 'plan-mismatch'
  | 'symbol-conflict';

export class CursorBatchError extends Error {
  readonly code: CursorBatchErrorCode;
  readonly cause_code?: CursorIndexerErrorCode | 'invalid-action' | 'invalid-invocation' | 'invalid-policy' | 'forbidden-compile-argument' | 'invalid-source';

  constructor(code: CursorBatchErrorCode, causeCode?: CursorIndexerErrorCode | 'invalid-action' | 'invalid-invocation' | 'invalid-policy' | 'forbidden-compile-argument' | 'invalid-source') {
    super(`cursor batch ${code}`);
    this.name = 'CursorBatchError';
    this.code = code;
    this.cause_code = causeCode;
  }
}

export interface CursorBatchRequest {
  batch_id: string;
  revision_set_hash: string;
  tool_artifact_hash: string;
  state_root: string;
  checkpoint_directory: string;
  executable: string;
  tool_root: string;
  workspace_roots: readonly string[];
  commands: readonly NormalizedCompileCommand[];
  argument_profile?: 'normalized' | 'ue-msvc-cxx20';
  batch_size?: number;
  concurrency?: number;
  max_attempts?: number;
  execution_policy?: CursorExecutionPolicy;
}

export interface CursorBatchReport extends CursorIndexResult {
  batch_id: string;
  plan_hash: string;
  total_actions: number;
  completed_actions: number;
  checkpoint_count: number;
  attempt_count: number;
  deduplicated_symbol_records: number;
  deduplicated_locations: number;
  source_symbol_edge_records: number;
  source_file_edge_records: number;
  deduplicated_symbol_edges: number;
  deduplicated_file_edges: number;
}

export type CursorBatchActionExecutor = (
  invocation: CursorIndexerInvocation,
  workspaceRoots: readonly string[],
  policy: CursorExecutionPolicy,
) => Promise<CursorIndexResult>;

interface CheckpointPayload {
  schema_version: 1;
  batch_id: string;
  plan_hash: string;
  batch_index: number;
  start_index: number;
  end_index: number;
  action_hashes: string[];
  attempt_count: number;
  source_symbol_records: number;
  source_location_records: number;
  source_symbol_edge_records?: number;
  source_file_edge_records?: number;
  aggregate: CursorIndexResult;
}

interface CheckpointEnvelope {
  schema_version: 1;
  payload_sha256: string;
  payload: CheckpointPayload;
}

const HASH = /^[a-f0-9]{64}$/;
const BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SOURCE_EXTENSION = /\.(?:c|cc|cpp|cxx|m|mm)$/i;
const CHECKPOINT_FILE = /^checkpoint-(\d{6})\.json$/;
const MAX_CHECKPOINT_FILES = 100_000;
const MAX_CHECKPOINT_BYTES = 512 * 1024 * 1024;
const MAX_BATCH_SIZE = 64;
const MAX_CONCURRENCY = 8;
const MAX_ATTEMPTS = 3;
const MAX_ARGUMENT_FILE_BYTES = 8 * 1024 * 1024;
const argumentFileWrites = new Map<string, Promise<string>>();

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    throw new CursorBatchError('invalid-checkpoint');
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CursorBatchError('invalid-checkpoint');
  return value as Record<string, unknown>;
}

function safeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) throw new CursorBatchError('invalid-checkpoint');
  return value as number;
}

function boundedString(value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > 65_536 || /[\0]/.test(value)) {
    throw new CursorBatchError('invalid-checkpoint');
  }
  return value;
}

function isBelow(root: string, value: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(value));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizedCommandHash(command: NormalizedCompileCommand): string {
  return createHash('sha256').update(JSON.stringify({
    directory: command.directory,
    file: command.file,
    compiler: command.compiler,
    arguments: command.arguments,
  })).digest('hex');
}

function validateCommand(command: NormalizedCompileCommand, roots: readonly string[]): void {
  if (typeof command !== 'object' || command === null || !path.isAbsolute(command.directory)
      || !path.isAbsolute(command.file) || !SOURCE_EXTENSION.test(command.file)
      || !roots.some((root) => isBelow(root, command.file))
      || !path.isAbsolute(command.compiler) || !/^(?:clang|clang-cl)(?:\.exe)?$/i.test(path.basename(command.compiler))
      || !Array.isArray(command.arguments) || command.arguments.length > 16_384
      || command.arguments.some((argument) => typeof argument !== 'string' || argument.length > 65_536 || /[\r\n\0]/.test(argument))
      || !HASH.test(command.content_hash) || normalizedCommandHash(command) !== command.content_hash) {
    throw new CursorBatchError('invalid-plan');
  }
}

function planHash(request: CursorBatchRequest, batchSize: number, concurrency: number, maxAttempts: number): string {
  return createHash('sha256').update(JSON.stringify({
    schema_version: 1,
    revision_set_hash: request.revision_set_hash,
    tool_artifact_hash: request.tool_artifact_hash,
    executable: path.resolve(request.executable),
    argument_profile: request.argument_profile ?? 'normalized',
    batch_size: batchSize,
    concurrency,
    max_attempts: maxAttempts,
    execution_policy: {
      timeout_ms: request.execution_policy?.timeout_ms ?? null,
      max_output_bytes: request.execution_policy?.max_output_bytes ?? null,
      max_error_diagnostics: request.execution_policy?.max_error_diagnostics ?? null,
    },
    workspace_roots: request.workspace_roots.map((root) => path.resolve(root)),
    actions: request.commands.map(({ content_hash }) => content_hash),
  })).digest('hex');
}

function locationKey(location: CursorLocation): string {
  return JSON.stringify(location);
}

function compareLocations(left: CursorLocation, right: CursorLocation): number {
  return left.file.localeCompare(right.file, 'en') || left.start_line - right.start_line
    || left.start_column - right.start_column || left.end_line - right.end_line
    || left.end_column - right.end_column || left.kind.localeCompare(right.kind, 'en');
}

function mergeSymbol(existing: CursorSymbol | undefined, incoming: CursorSymbol): CursorSymbol {
  if (existing !== undefined && (existing.qualified_name !== incoming.qualified_name || existing.name !== incoming.name
      || existing.display_name !== incoming.display_name || existing.kind !== incoming.kind
      || existing.owner_usr !== incoming.owner_usr
      || (existing.type_spelling && incoming.type_spelling && existing.type_spelling !== incoming.type_spelling)
      || (existing.result_type && incoming.result_type && existing.result_type !== incoming.result_type))) {
    throw new CursorBatchError('symbol-conflict');
  }
  const typeSpelling = existing?.type_spelling || incoming.type_spelling;
  const resultType = existing?.result_type || incoming.result_type;
  const locations = new Map<string, CursorLocation>();
  for (const location of [...(existing?.locations ?? []), ...incoming.locations]) locations.set(locationKey(location), location);
  const documentation = [existing?.documentation, incoming.documentation]
    .filter((value): value is string => value !== undefined)
    .sort((left, right) => right.length - left.length || left.localeCompare(right, 'en'))[0];
  return Object.freeze({
    stable_usr: incoming.stable_usr,
    qualified_name: incoming.qualified_name,
    name: incoming.name,
    display_name: incoming.display_name,
    kind: incoming.kind,
    ...(incoming.owner_usr === undefined ? {} : { owner_usr: incoming.owner_usr }),
    type_spelling: typeSpelling,
    result_type: resultType,
    ...(documentation === undefined ? {} : { documentation }),
    signature_hash: createHash('sha256').update(JSON.stringify({
      kind: incoming.kind,
      qualified_name: incoming.qualified_name,
      display_name: incoming.display_name,
      type_spelling: typeSpelling,
      result_type: resultType,
    })).digest('hex'),
    locations: Object.freeze([...locations.values()].sort(compareLocations)),
  });
}

export function mergeCursorIndexResults(
  results: readonly CursorIndexResult[],
  workspaceRoots: readonly string[] = [],
): CursorIndexResult {
  if (!Array.isArray(results) || results.length === 0) throw new CursorBatchError('invalid-plan');
  const libclang = results[0].libclang;
  const relationMode = results[0].relation_shard !== undefined;
  const relationShards: RelationShard[] = [];
  const symbols = new Map<string, CursorSymbol>();
  const ambiguousUsrs = new Set<string>();
  let diagnosticCount = 0;
  let errorCount = 0;
  let unidentifiedCount = 0;
  for (const result of results) {
    if (result.schema_version !== 1 || result.libclang !== libclang || (result.relation_shard !== undefined) !== relationMode) {
      throw new CursorBatchError('symbol-conflict');
    }
    if (result.relation_shard !== undefined) relationShards.push(result.relation_shard);
    diagnosticCount += result.diagnostic_count;
    errorCount += result.error_count;
    unidentifiedCount += result.unidentified_count;
    if (![diagnosticCount, errorCount, unidentifiedCount].every(Number.isSafeInteger)) throw new CursorBatchError('symbol-conflict');
    for (const symbol of result.symbols) {
      if (ambiguousUsrs.has(symbol.stable_usr)) {
        unidentifiedCount += symbol.locations.length;
        continue;
      }
      const existing = symbols.get(symbol.stable_usr);
      try {
        symbols.set(symbol.stable_usr, mergeSymbol(existing, symbol));
      } catch (error) {
        if (!(error instanceof CursorBatchError) || error.code !== 'symbol-conflict' || existing === undefined) throw error;
        unidentifiedCount += existing.locations.length + symbol.locations.length;
        symbols.delete(symbol.stable_usr);
        ambiguousUsrs.add(symbol.stable_usr);
      }
    }
  }
  let relationShard: RelationShard | undefined;
  if (relationMode) {
    if (!Array.isArray(workspaceRoots) || workspaceRoots.length === 0) throw new CursorBatchError('invalid-plan');
    try {
      relationShard = mergeRelationShards(relationShards, workspaceRoots).shard;
    } catch {
      throw new CursorBatchError('symbol-conflict');
    }
  }
  return Object.freeze({
    schema_version: 1,
    libclang,
    diagnostic_count: diagnosticCount,
    error_count: errorCount,
    unidentified_count: unidentifiedCount,
    symbols: Object.freeze([...symbols.values()].sort((left, right) => left.stable_usr.localeCompare(right.stable_usr, 'en'))),
    ...(relationShard === undefined ? {} : { relation_shard: relationShard }),
  });
}

function validatePersistedResult(value: unknown, roots: readonly string[]): CursorIndexResult {
  const result = object(value);
  exactKeys(result, ['schema_version', 'libclang', 'diagnostic_count', 'error_count', 'unidentified_count', 'symbols'], ['relation_shard']);
  if (result.schema_version !== 1 || !Array.isArray(result.symbols) || result.symbols.length > 2_000_000) throw new CursorBatchError('invalid-checkpoint');
  const symbols = result.symbols.map((candidate) => {
    const symbol = object(candidate);
    exactKeys(symbol, ['stable_usr', 'qualified_name', 'name', 'display_name', 'kind', 'type_spelling', 'result_type', 'signature_hash', 'locations'], ['owner_usr', 'documentation']);
    if (!Array.isArray(symbol.locations) || symbol.locations.length > 2_000_000) throw new CursorBatchError('invalid-checkpoint');
    const locations = symbol.locations.map((entry) => {
      const location = object(entry);
      exactKeys(location, ['kind', 'file', 'start_line', 'start_column', 'end_line', 'end_column']);
      const file = boundedString(location.file);
      const startLine = safeInteger(location.start_line, 2_000_000);
      const startColumn = safeInteger(location.start_column, 2_000_000);
      const endLine = safeInteger(location.end_line, 2_000_000);
      const endColumn = safeInteger(location.end_column, 2_000_000);
      if (!['declaration', 'definition'].includes(location.kind as string) || !roots.some((root) => isBelow(root, file))
          || startLine < 1 || startColumn < 1 || endLine < startLine || (endLine === startLine && endColumn < startColumn)) {
        throw new CursorBatchError('invalid-checkpoint');
      }
      return Object.freeze({ kind: location.kind, file: path.resolve(file), start_line: startLine, start_column: startColumn, end_line: endLine, end_column: endColumn }) as CursorLocation;
    });
    const signatureHash = boundedString(symbol.signature_hash);
    if (!HASH.test(signatureHash)) throw new CursorBatchError('invalid-checkpoint');
    return Object.freeze({
      stable_usr: boundedString(symbol.stable_usr), qualified_name: boundedString(symbol.qualified_name),
      name: boundedString(symbol.name), display_name: boundedString(symbol.display_name), kind: boundedString(symbol.kind),
      ...(symbol.owner_usr === undefined ? {} : { owner_usr: boundedString(symbol.owner_usr) }),
      type_spelling: boundedString(symbol.type_spelling, true), result_type: boundedString(symbol.result_type, true),
      ...(symbol.documentation === undefined ? {} : { documentation: boundedString(symbol.documentation) }),
      signature_hash: signatureHash, locations: Object.freeze(locations),
    }) as CursorSymbol;
  });
  let relationShard: RelationShard | undefined;
  if (result.relation_shard !== undefined) {
    try {
      const merged = mergeRelationShards([result.relation_shard as RelationShard], roots);
      if (merged.deduplicated_symbol_edges !== 0 || merged.deduplicated_file_edges !== 0
          || JSON.stringify(merged.shard) !== JSON.stringify(result.relation_shard)) {
        throw new CursorBatchError('invalid-checkpoint');
      }
      relationShard = merged.shard;
    } catch {
      throw new CursorBatchError('invalid-checkpoint');
    }
  }
  return Object.freeze({
    schema_version: 1,
    libclang: boundedString(result.libclang),
    diagnostic_count: safeInteger(result.diagnostic_count, 2_000_000_000),
    error_count: safeInteger(result.error_count, 2_000_000_000),
    unidentified_count: safeInteger(result.unidentified_count, 2_000_000_000),
    symbols: Object.freeze(symbols),
    ...(relationShard === undefined ? {} : { relation_shard: relationShard }),
  });
}

function parseCheckpoint(text: string, roots: readonly string[]): CheckpointPayload {
  if (Buffer.byteLength(text, 'utf8') > MAX_CHECKPOINT_BYTES) throw new CursorBatchError('invalid-checkpoint');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new CursorBatchError('invalid-checkpoint'); }
  const envelope = object(parsed);
  exactKeys(envelope, ['schema_version', 'payload_sha256', 'payload']);
  const payloadHash = boundedString(envelope.payload_sha256);
  if (envelope.schema_version !== 1 || !HASH.test(payloadHash)
      || createHash('sha256').update(JSON.stringify(envelope.payload)).digest('hex') !== payloadHash) {
    throw new CursorBatchError('invalid-checkpoint');
  }
  const payload = object(envelope.payload);
  exactKeys(payload, [
    'schema_version', 'batch_id', 'plan_hash', 'batch_index', 'start_index', 'end_index', 'action_hashes',
    'attempt_count', 'source_symbol_records', 'source_location_records', 'aggregate',
  ], ['source_symbol_edge_records', 'source_file_edge_records']);
  if (payload.schema_version !== 1 || !BATCH_ID.test(boundedString(payload.batch_id)) || !HASH.test(boundedString(payload.plan_hash))
      || !Array.isArray(payload.action_hashes) || payload.action_hashes.some((hash) => typeof hash !== 'string' || !HASH.test(hash))) {
    throw new CursorBatchError('invalid-checkpoint');
  }
  const aggregate = validatePersistedResult(payload.aggregate, roots);
  const hasSymbolEdgeCount = payload.source_symbol_edge_records !== undefined;
  const hasFileEdgeCount = payload.source_file_edge_records !== undefined;
  if (hasSymbolEdgeCount !== hasFileEdgeCount || hasSymbolEdgeCount !== (aggregate.relation_shard !== undefined)) {
    throw new CursorBatchError('invalid-checkpoint');
  }
  return {
    schema_version: 1,
    batch_id: payload.batch_id as string,
    plan_hash: payload.plan_hash as string,
    batch_index: safeInteger(payload.batch_index, MAX_CHECKPOINT_FILES - 1),
    start_index: safeInteger(payload.start_index, 1_000_000),
    end_index: safeInteger(payload.end_index, 1_000_000),
    action_hashes: [...payload.action_hashes] as string[],
    attempt_count: safeInteger(payload.attempt_count, 1_000_000),
    source_symbol_records: safeInteger(payload.source_symbol_records, 2_000_000_000),
    source_location_records: safeInteger(payload.source_location_records, 2_000_000_000),
    ...(hasSymbolEdgeCount ? {
      source_symbol_edge_records: safeInteger(payload.source_symbol_edge_records, 2_000_000_000),
      source_file_edge_records: safeInteger(payload.source_file_edge_records, 2_000_000_000),
    } : {}),
    aggregate,
  };
}

class ImmutableCheckpointStore {
  readonly directory: string;
  readonly roots: readonly string[];

  private constructor(directory: string, roots: readonly string[]) {
    this.directory = directory;
    this.roots = roots;
  }

  static async create(stateRoot: string, checkpointDirectory: string, roots: readonly string[]): Promise<ImmutableCheckpointStore> {
    if (!path.isAbsolute(stateRoot) || !path.isAbsolute(checkpointDirectory) || !isBelow(stateRoot, checkpointDirectory)) {
      throw new CursorBatchError('invalid-plan');
    }
    const canonicalRoot = await realpath(stateRoot).catch(() => { throw new CursorBatchError('invalid-plan'); });
    await mkdir(checkpointDirectory, { recursive: true });
    const canonicalDirectory = await realpath(checkpointDirectory).catch(() => { throw new CursorBatchError('invalid-plan'); });
    if (!isBelow(canonicalRoot, canonicalDirectory)) throw new CursorBatchError('invalid-plan');
    return new ImmutableCheckpointStore(canonicalDirectory, roots);
  }

  async load(): Promise<CheckpointPayload[]> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && CHECKPOINT_FILE.test(entry.name)).sort((left, right) => left.name.localeCompare(right.name, 'en'));
    if (entries.length > MAX_CHECKPOINT_FILES * 2 || files.length > MAX_CHECKPOINT_FILES
        || entries.some((entry) => !entry.isFile() || (!CHECKPOINT_FILE.test(entry.name) && !entry.name.endsWith('.tmp')))) {
      throw new CursorBatchError('invalid-checkpoint');
    }
    const checkpoints: CheckpointPayload[] = [];
    for (let index = 0; index < files.length; index += 1) {
      const match = CHECKPOINT_FILE.exec(files[index].name);
      if (match === null || Number(match[1]) !== index) throw new CursorBatchError('invalid-checkpoint');
      checkpoints.push(parseCheckpoint(await readFile(path.join(this.directory, files[index].name), 'utf8'), this.roots));
    }
    return checkpoints;
  }

  async append(payload: CheckpointPayload): Promise<void> {
    const encodedPayload = JSON.stringify(payload);
    const envelope: CheckpointEnvelope = {
      schema_version: 1,
      payload_sha256: createHash('sha256').update(encodedPayload).digest('hex'),
      payload,
    };
    const encoded = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > MAX_CHECKPOINT_BYTES) throw new CursorBatchError('invalid-checkpoint');
    const target = path.join(this.directory, `checkpoint-${payload.batch_index.toString().padStart(6, '0')}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(encoded, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try { await rename(temporary, target); } catch { throw new CursorBatchError('invalid-checkpoint'); }
  }
}

function workspaceFor(file: string, roots: readonly string[]): string {
  const candidates = roots.filter((root) => isBelow(root, file)).sort((left, right) => right.length - left.length);
  if (candidates.length === 0) throw new CursorBatchError('invalid-plan');
  return candidates[0];
}

export function createCursorCompileArguments(
  command: NormalizedCompileCommand,
  profile: 'normalized' | 'ue-msvc-cxx20' = 'normalized',
): string[] {
  const source = path.resolve(command.file).toLowerCase();
  if (profile === 'normalized') {
    return command.arguments.filter((argument) => !(path.isAbsolute(argument) && path.resolve(argument).toLowerCase() === source));
  }
  if (profile !== 'ue-msvc-cxx20') throw new CursorBatchError('invalid-plan');
  return [
    '-x', 'c++', '-std=c++20', '-fms-extensions', '-fms-compatibility',
    ...command.include_paths.flatMap((value) => ['-I', value]),
    ...command.forced_includes.flatMap((value) => ['-include', value]),
    ...command.definitions.flatMap((value) => ['-D', value]),
  ];
}

async function ensureArgumentFile(
  stateRoot: string,
  command: NormalizedCompileCommand,
  profile: 'normalized' | 'ue-msvc-cxx20',
): Promise<string> {
  const argumentsValue = createCursorCompileArguments(command, profile);
  if (argumentsValue.some((argument) => argument.length === 0 || /[\r\n\0]/.test(argument))) throw new CursorBatchError('invalid-plan');
  const encoded = `${argumentsValue.join('\n')}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_ARGUMENT_FILE_BYTES) throw new CursorBatchError('invalid-plan');
  const contentHash = createHash('sha256').update(encoded).digest('hex');
  const writeKey = `${path.resolve(stateRoot)}\0${contentHash}`;
  const pending = argumentFileWrites.get(writeKey);
  if (pending !== undefined) return pending;
  const operation = writeArgumentFile(stateRoot, contentHash, encoded);
  argumentFileWrites.set(writeKey, operation);
  try {
    return await operation;
  } finally {
    if (argumentFileWrites.get(writeKey) === operation) argumentFileWrites.delete(writeKey);
  }
}

async function writeArgumentFile(stateRoot: string, contentHash: string, encoded: string): Promise<string> {
  const directory = path.join(stateRoot, 'arguments');
  await mkdir(directory, { recursive: true });
  const canonicalDirectory = await realpath(directory).catch(() => { throw new CursorBatchError('invalid-checkpoint'); });
  if (!isBelow(stateRoot, canonicalDirectory)) throw new CursorBatchError('invalid-checkpoint');
  const target = path.join(canonicalDirectory, `${contentHash}.args`);
  const metadata = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw new CursorBatchError('invalid-checkpoint');
  });
  if (metadata !== undefined) {
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_ARGUMENT_FILE_BYTES
        || await readFile(target, 'utf8') !== encoded) throw new CursorBatchError('invalid-checkpoint');
    return target;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(encoded, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try { await rename(temporary, target); } catch { throw new CursorBatchError('invalid-checkpoint'); }
  return target;
}

function retryable(error: unknown): boolean {
  return error instanceof CursorIndexerError && ['start-failed', 'timeout', 'nonzero-exit'].includes(error.code);
}

function safeFailureCause(error: unknown): CursorIndexerErrorCode | 'invalid-action' | 'invalid-invocation' | 'invalid-policy' | 'forbidden-compile-argument' | 'invalid-source' {
  if (error instanceof CursorIndexerError) return error.code;
  if (error instanceof TypeError && error.message === 'cursor invocation is invalid') return 'invalid-invocation';
  if (error instanceof TypeError && error.message === 'cursor execution policy is invalid') return 'invalid-policy';
  if (error instanceof TypeError && error.message === 'cursor compile argument is forbidden') return 'forbidden-compile-argument';
  if (error instanceof TypeError && (error.message === 'cursor indexer request is invalid' || error.message.includes('cursor source file'))) return 'invalid-source';
  return 'invalid-action';
}

async function executeBatch(
  request: CursorBatchRequest,
  roots: readonly string[],
  start: number,
  end: number,
  concurrency: number,
  maxAttempts: number,
  stateRoot: string,
  executor: CursorBatchActionExecutor,
): Promise<{ results: CursorIndexResult[]; attempts: number }> {
  const results = new Array<CursorIndexResult>(end - start);
  let attempts = 0;
  let cursor = start;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(concurrency, end - start) }, async () => {
    while (failure === undefined) {
      const actionIndex = cursor;
      cursor += 1;
      if (actionIndex >= end) return;
      const command = request.commands[actionIndex];
      let invocation: CursorIndexerInvocation;
      try {
        const workspace = workspaceFor(command.file, roots);
        const argumentFile = await ensureArgumentFile(stateRoot, command, request.argument_profile ?? 'normalized');
        invocation = buildCursorIndexerInvocation({
          executable: request.executable,
          tool_root: request.tool_root,
          workspace_root: workspace,
          related_workspace_roots: roots.filter((root) => root.toLowerCase() !== workspace.toLowerCase()),
          source_file: command.file,
          compile_arguments: [],
          arguments_file: argumentFile,
          arguments_root: path.dirname(argumentFile),
        });
      } catch (error) {
        failure = error;
        return;
      }
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        attempts += 1;
        try {
          results[actionIndex - start] = await executor(invocation, roots, { ...request.execution_policy });
          break;
        } catch (error) {
          if (attempt === maxAttempts || !retryable(error)) { failure = error; break; }
        }
      }
    }
  });
  await Promise.all(workers);
  if (failure !== undefined) {
    if (failure instanceof CursorIndexerError && failure.code === 'aborted') throw failure;
    throw new CursorBatchError('action-failed', safeFailureCause(failure));
  }
  return { results, attempts };
}

export async function runCursorBatch(
  request: CursorBatchRequest,
  executor: CursorBatchActionExecutor = runCursorIndexer,
): Promise<CursorBatchReport> {
  const batchSize = request.batch_size ?? 16;
  const concurrency = request.concurrency ?? 1;
  const maxAttempts = request.max_attempts ?? 2;
  if (!BATCH_ID.test(request.batch_id) || !HASH.test(request.revision_set_hash) || !HASH.test(request.tool_artifact_hash)
      || !Array.isArray(request.workspace_roots) || request.workspace_roots.length === 0
      || request.workspace_roots.length > 64 || request.workspace_roots.some((root) => !path.isAbsolute(root)) || !Array.isArray(request.commands)
      || request.commands.length === 0 || request.commands.length > 1_000_000
      || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE
      || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY
      || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS
      || !['normalized', 'ue-msvc-cxx20'].includes(request.argument_profile ?? 'normalized')
      || Math.ceil(request.commands.length / batchSize) > MAX_CHECKPOINT_FILES) {
    throw new CursorBatchError('invalid-plan');
  }
  const roots = request.workspace_roots.map((root) => path.resolve(root));
  if (new Set(roots.map((root) => root.toLowerCase())).size !== roots.length) throw new CursorBatchError('invalid-plan');
  for (const command of request.commands) validateCommand(command, roots);
  const hash = planHash(request, batchSize, concurrency, maxAttempts);
  const store = await ImmutableCheckpointStore.create(request.state_root, request.checkpoint_directory, roots);
  const canonicalStateRoot = await realpath(request.state_root).catch(() => { throw new CursorBatchError('invalid-plan'); });
  const checkpoints = await store.load();
  const aggregates: CursorIndexResult[] = [];
  let completed = 0;
  let attempts = 0;
  let sourceSymbols = 0;
  let sourceLocations = 0;
  let sourceSymbolEdges = 0;
  let sourceFileEdges = 0;
  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index];
    const expectedEnd = Math.min(completed + batchSize, request.commands.length);
    const expectedHashes = request.commands.slice(completed, expectedEnd).map(({ content_hash }) => content_hash);
    if (checkpoint.batch_id !== request.batch_id || checkpoint.plan_hash !== hash || checkpoint.batch_index !== index
        || checkpoint.start_index !== completed || checkpoint.end_index !== expectedEnd
        || JSON.stringify(checkpoint.action_hashes) !== JSON.stringify(expectedHashes)) {
      throw new CursorBatchError('plan-mismatch');
    }
    completed = expectedEnd;
    attempts += checkpoint.attempt_count;
    sourceSymbols += checkpoint.source_symbol_records;
    sourceLocations += checkpoint.source_location_records;
    sourceSymbolEdges += checkpoint.source_symbol_edge_records ?? 0;
    sourceFileEdges += checkpoint.source_file_edge_records ?? 0;
    aggregates.push(checkpoint.aggregate);
  }
  while (completed < request.commands.length) {
    const start = completed;
    const end = Math.min(start + batchSize, request.commands.length);
    const execution = await executeBatch(request, roots, start, end, concurrency, maxAttempts, canonicalStateRoot, executor);
    const aggregate = mergeCursorIndexResults(execution.results, roots);
    const batchSymbols = execution.results.reduce((total, result) => total + result.symbols.length, 0);
    const batchLocations = execution.results.reduce((total, result) => total + result.symbols.reduce((count, symbol) => count + symbol.locations.length, 0), 0);
    const batchSymbolEdges = execution.results.reduce((total, result) => total + (result.relation_shard?.symbol_edges.length ?? 0), 0);
    const batchFileEdges = execution.results.reduce((total, result) => total + (result.relation_shard?.file_edges.length ?? 0), 0);
    const payload: CheckpointPayload = {
      schema_version: 1,
      batch_id: request.batch_id,
      plan_hash: hash,
      batch_index: aggregates.length,
      start_index: start,
      end_index: end,
      action_hashes: request.commands.slice(start, end).map(({ content_hash }) => content_hash),
      attempt_count: execution.attempts,
      source_symbol_records: batchSymbols,
      source_location_records: batchLocations,
      ...(aggregate.relation_shard === undefined ? {} : {
        source_symbol_edge_records: batchSymbolEdges,
        source_file_edge_records: batchFileEdges,
      }),
      aggregate,
    };
    await store.append(payload);
    aggregates.push(aggregate);
    completed = end;
    attempts += execution.attempts;
    sourceSymbols += batchSymbols;
    sourceLocations += batchLocations;
    sourceSymbolEdges += batchSymbolEdges;
    sourceFileEdges += batchFileEdges;
  }
  const aggregate = mergeCursorIndexResults(aggregates, roots);
  const uniqueLocations = aggregate.symbols.reduce((total, symbol) => total + symbol.locations.length, 0);
  const uniqueSymbolEdges = aggregate.relation_shard?.symbol_edges.length ?? 0;
  const uniqueFileEdges = aggregate.relation_shard?.file_edges.length ?? 0;
  return Object.freeze({
    ...aggregate,
    batch_id: request.batch_id,
    plan_hash: hash,
    total_actions: request.commands.length,
    completed_actions: completed,
    checkpoint_count: aggregates.length,
    attempt_count: attempts,
    deduplicated_symbol_records: sourceSymbols - aggregate.symbols.length,
    deduplicated_locations: sourceLocations - uniqueLocations,
    source_symbol_edge_records: sourceSymbolEdges,
    source_file_edge_records: sourceFileEdges,
    deduplicated_symbol_edges: sourceSymbolEdges - uniqueSymbolEdges,
    deduplicated_file_edges: sourceFileEdges - uniqueFileEdges,
  });
}
