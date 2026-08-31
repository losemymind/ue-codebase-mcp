import { createHash } from 'node:crypto';
import path from 'node:path';
import { codeChunkStableKey, estimateCodeTokens, type CodeChunk } from '../../../workers/clang-indexer/src/code-chunking.ts';
import type { FixedSqlResult, FixedSqlStatement, PersistedFileBinding } from './symbol-persistence.ts';

export interface ChunkPersistenceTransaction {
  execute<Row>(statement: FixedSqlStatement, values: readonly (string | number)[]): Promise<FixedSqlResult<Row>>;
}

export interface ChunkPersistenceDatabase {
  transaction<Result>(operation: (transaction: ChunkPersistenceTransaction) => Promise<Result>): Promise<Result>;
}

export interface ChunkPersistenceRequest {
  generation_id: string;
  revision_set_hash: string;
  plan_hash: string;
  chunks: readonly CodeChunk[];
  files: readonly PersistedFileBinding[];
  batch_size?: number;
}

export interface ChunkPersistenceReport {
  generation_id: string;
  plan_hash: string;
  payload_hash: string;
  code_chunk_count: number;
  unique_content_count: number;
  estimated_token_count: number;
  already_persisted: boolean;
}

export type ChunkPersistenceErrorCode =
  | 'invalid-request'
  | 'generation-not-found'
  | 'generation-mismatch'
  | 'generation-not-building'
  | 'symbols-not-imported'
  | 'plan-conflict'
  | 'dirty-generation'
  | 'file-mismatch'
  | 'symbol-mismatch'
  | 'write-mismatch'
  | 'transaction-failed';

export class ChunkPersistenceError extends Error {
  readonly code: ChunkPersistenceErrorCode;

  constructor(code: ChunkPersistenceErrorCode) {
    super(`chunk persistence ${code}`);
    this.name = 'ChunkPersistenceError';
    this.code = code;
  }
}

interface GenerationRow {
  revision_set_hash: string;
  status: string;
  symbols_imported_at: string | null;
  chunk_plan_hash: string | null;
  chunk_payload_hash: string | null;
  code_chunk_count: string | number | null;
  chunks_imported_at: string | null;
}

interface CountRow { code_chunk_count: string | number }
interface IdRow { id: string }
interface SymbolIdRow { stable_usr: string; id: string }

interface PreparedChunk {
  stable_key: string;
  content_hash: string;
  symbol_usr: string;
  file_id: string;
  chunk_kind: string;
  text: string;
  token_count: number;
  start_line: number | null;
  start_column: number | null;
  end_line: number | null;
  end_column: number | null;
  part_index: number;
  part_count: number;
}

interface PreparedRequest {
  chunks: readonly PreparedChunk[];
  fileIds: readonly string[];
  symbolUsrs: readonly string[];
  payloadHash: string;
  uniqueContentCount: number;
  tokenCount: number;
  batchSize: number;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const CHUNK_KINDS = new Set(['declaration', 'definition', 'documentation']);
const MAX_CHUNKS = 10_000_000;
const MAX_FILES = 2_000_000;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_BATCH_SIZE = 1_000;
const MAX_BATCH_BYTES = 8 * 1024 * 1024;

const STATEMENTS = Object.freeze({
  lockGeneration: Object.freeze({
    name: 'chunk-persistence-lock-generation-v1',
    text: `SELECT encode(revision_set_hash, 'hex') AS revision_set_hash, status, symbols_imported_at::text,
      encode(chunk_plan_hash, 'hex') AS chunk_plan_hash, encode(chunk_payload_hash, 'hex') AS chunk_payload_hash,
      code_chunk_count, chunks_imported_at::text
      FROM ue_mcp.index_generations WHERE id = $1::uuid FOR UPDATE`,
  }),
  countExisting: Object.freeze({
    name: 'chunk-persistence-count-existing-v1',
    text: `SELECT count(*) AS code_chunk_count FROM ue_mcp.code_chunks WHERE generation_id = $1::uuid`,
  }),
  validateFiles: Object.freeze({
    name: 'chunk-persistence-validate-files-v1',
    text: `SELECT file.id::text AS id FROM ue_mcp.files file
      JOIN jsonb_to_recordset($2::jsonb) AS requested(id uuid) ON requested.id = file.id
      WHERE file.generation_id = $1::uuid ORDER BY file.id`,
  }),
  resolveSymbols: Object.freeze({
    name: 'chunk-persistence-resolve-symbols-v1',
    text: `SELECT symbol.stable_usr, symbol.id::text AS id FROM ue_mcp.symbols symbol
      JOIN jsonb_to_recordset($2::jsonb) AS requested(stable_usr text) ON requested.stable_usr = symbol.stable_usr
      WHERE symbol.generation_id = $1::uuid ORDER BY symbol.stable_usr`,
  }),
  insertChunks: Object.freeze({
    name: 'chunk-persistence-insert-chunks-v1',
    text: `INSERT INTO ue_mcp.code_chunks
      (generation_id, stable_key, content_hash, symbol_id, file_id, chunk_kind, text, token_count,
        start_line, start_column, end_line, end_column, part_index, part_count)
      SELECT $1::uuid, decode(input.stable_key, 'hex'), decode(input.content_hash, 'hex'), input.symbol_id,
        input.file_id, input.chunk_kind, input.text, input.token_count, input.start_line, input.start_column,
        input.end_line, input.end_column, input.part_index, input.part_count
      FROM jsonb_to_recordset($2::jsonb) AS input(
        stable_key text, content_hash text, symbol_id uuid, file_id uuid, chunk_kind text, text text,
        token_count integer, start_line integer, start_column integer, end_line integer, end_column integer,
        part_index integer, part_count integer)
      JOIN ue_mcp.symbols symbol ON symbol.id = input.symbol_id AND symbol.generation_id = $1::uuid
      JOIN ue_mcp.files file ON file.id = input.file_id AND file.generation_id = $1::uuid`,
  }),
  complete: Object.freeze({
    name: 'chunk-persistence-complete-v1',
    text: `UPDATE ue_mcp.index_generations SET chunk_plan_hash = decode($2, 'hex'),
      chunk_payload_hash = decode($3, 'hex'), code_chunk_count = $4::bigint, chunks_imported_at = clock_timestamp()
      WHERE id = $1::uuid AND status = 'building' AND symbols_imported_at IS NOT NULL AND chunks_imported_at IS NULL`,
  }),
});

function invalid(): never {
  throw new ChunkPersistenceError('invalid-request');
}

function safeInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid();
  return value as number;
}

function count(value: string | number | null): number {
  const result = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(result) || (result as number) < 0) throw new ChunkPersistenceError('transaction-failed');
  return result as number;
}

function sourcePath(value: unknown): { key: string; value: string } {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32_768 || /[\r\n\0]/.test(value)) invalid();
  if (path.win32.isAbsolute(value)) {
    const normalized = path.win32.normalize(value);
    return { key: `windows:${normalized.toLowerCase()}`, value: normalized };
  }
  if (path.posix.isAbsolute(value)) {
    const normalized = path.posix.normalize(value);
    return { key: `posix:${normalized}`, value: normalized };
  }
  return invalid();
}

function encodedBatches<Row>(rows: readonly Row[], batchSize: number): readonly string[] {
  const result: string[] = [];
  let batch: Row[] = [];
  let bytes = 2;
  for (const row of rows) {
    const encoded = JSON.stringify(row);
    const rowBytes = Buffer.byteLength(encoded, 'utf8') + (batch.length === 0 ? 0 : 1);
    if (rowBytes + 2 > MAX_BATCH_BYTES) invalid();
    if (batch.length >= batchSize || bytes + rowBytes > MAX_BATCH_BYTES) {
      result.push(JSON.stringify(batch));
      batch = [];
      bytes = 2;
    }
    batch.push(row);
    bytes += rowBytes;
  }
  if (batch.length > 0) result.push(JSON.stringify(batch));
  return Object.freeze(result);
}

function prepare(request: ChunkPersistenceRequest): PreparedRequest {
  if (typeof request !== 'object' || request === null || !UUID.test(request.generation_id)
      || !HASH.test(request.revision_set_hash) || !HASH.test(request.plan_hash) || !Array.isArray(request.chunks)
      || request.chunks.length > MAX_CHUNKS || !Array.isArray(request.files) || request.files.length > MAX_FILES) invalid();
  const batchSize = safeInteger(request.batch_size ?? 500, 1, MAX_BATCH_SIZE);
  const filesByPath = new Map<string, string>();
  const allFileIds = new Set<string>();
  for (const file of request.files) {
    if (typeof file !== 'object' || file === null || !UUID.test(file.id)) invalid();
    const normalized = sourcePath(file.absolute_path);
    const id = file.id.toLowerCase();
    if (filesByPath.has(normalized.key) || allFileIds.has(id)) invalid();
    filesByPath.set(normalized.key, id);
    allFileIds.add(id);
  }
  const stableKeys = new Set<string>();
  const usedFiles = new Set<string>();
  const symbolUsrs = new Set<string>();
  let tokenCount = 0;
  const chunks = request.chunks.map((chunk): PreparedChunk => {
    if (typeof chunk !== 'object' || chunk === null || !HASH.test(chunk.stable_key) || stableKeys.has(chunk.stable_key)
        || !HASH.test(chunk.content_hash) || createHash('sha256').update(chunk.text).digest('hex') !== chunk.content_hash
        || typeof chunk.symbol_usr !== 'string' || chunk.symbol_usr.length === 0 || chunk.symbol_usr.length > 4_096
        || /[\r\n\0]/.test(chunk.symbol_usr) || !CHUNK_KINDS.has(chunk.chunk_kind)
        || typeof chunk.text !== 'string' || chunk.text.length === 0 || chunk.text.includes('\0')
        || Buffer.byteLength(chunk.text, 'utf8') > MAX_TEXT_BYTES) invalid();
    const fileId = filesByPath.get(sourcePath(chunk.file).key);
    if (fileId === undefined) invalid();
    const coordinates = [chunk.start_line, chunk.start_column, chunk.end_line, chunk.end_column];
    if (coordinates.some((value) => value === null) !== coordinates.every((value) => value === null)) invalid();
    if (coordinates[0] !== null) {
      coordinates.forEach((value) => safeInteger(value, 1, 10_000_000));
      if ((chunk.end_line as number) < (chunk.start_line as number)
          || (chunk.end_line === chunk.start_line && (chunk.end_column as number) <= (chunk.start_column as number))) invalid();
    }
    const itemTokenCount = safeInteger(chunk.token_count, 1, 100_000_000);
    tokenCount = safeInteger(tokenCount + itemTokenCount, 0, Number.MAX_SAFE_INTEGER);
    const partCount = safeInteger(chunk.part_count, 1, 1_000_000);
    const partIndex = safeInteger(chunk.part_index, 0, partCount - 1);
    if (codeChunkStableKey(chunk) !== chunk.stable_key || estimateCodeTokens(chunk.text) !== itemTokenCount) invalid();
    stableKeys.add(chunk.stable_key);
    usedFiles.add(fileId);
    symbolUsrs.add(chunk.symbol_usr);
    return Object.freeze({
      stable_key: chunk.stable_key, content_hash: chunk.content_hash, symbol_usr: chunk.symbol_usr,
      file_id: fileId, chunk_kind: chunk.chunk_kind, text: chunk.text, token_count: itemTokenCount,
      start_line: chunk.start_line, start_column: chunk.start_column, end_line: chunk.end_line, end_column: chunk.end_column,
      part_index: partIndex, part_count: partCount,
    });
  }).sort((left, right) => left.stable_key.localeCompare(right.stable_key, 'en'));
  const payloadHash = createHash('sha256').update(JSON.stringify({ schema_version: 1, chunks })).digest('hex');
  return Object.freeze({
    chunks: Object.freeze(chunks), fileIds: Object.freeze([...usedFiles].sort((left, right) => left.localeCompare(right, 'en'))),
    symbolUsrs: Object.freeze([...symbolUsrs].sort((left, right) => left.localeCompare(right, 'en'))),
    payloadHash, uniqueContentCount: new Set(chunks.map(({ content_hash }) => content_hash)).size, tokenCount, batchSize,
  });
}

function report(request: ChunkPersistenceRequest, prepared: PreparedRequest, alreadyPersisted: boolean): ChunkPersistenceReport {
  return Object.freeze({
    generation_id: request.generation_id, plan_hash: request.plan_hash, payload_hash: prepared.payloadHash,
    code_chunk_count: prepared.chunks.length, unique_content_count: prepared.uniqueContentCount,
    estimated_token_count: prepared.tokenCount, already_persisted: alreadyPersisted,
  });
}

export async function persistCodeChunks(database: ChunkPersistenceDatabase, request: ChunkPersistenceRequest): Promise<ChunkPersistenceReport> {
  if (typeof database !== 'object' || database === null || typeof database.transaction !== 'function') invalid();
  const prepared = prepare(request);
  try {
    return await database.transaction(async (transaction) => {
      if (typeof transaction !== 'object' || transaction === null || typeof transaction.execute !== 'function') {
        throw new ChunkPersistenceError('transaction-failed');
      }
      const generation = await transaction.execute<GenerationRow>(STATEMENTS.lockGeneration, [request.generation_id]);
      if (generation.rows.length !== 1) throw new ChunkPersistenceError('generation-not-found');
      const state = generation.rows[0];
      if (state.revision_set_hash !== request.revision_set_hash) throw new ChunkPersistenceError('generation-mismatch');
      if (state.chunks_imported_at !== null) {
        if (state.chunk_plan_hash !== request.plan_hash || state.chunk_payload_hash !== prepared.payloadHash
            || count(state.code_chunk_count) !== prepared.chunks.length) throw new ChunkPersistenceError('plan-conflict');
        return report(request, prepared, true);
      }
      if (state.chunk_plan_hash !== null || state.chunk_payload_hash !== null || state.code_chunk_count !== null) {
        throw new ChunkPersistenceError('dirty-generation');
      }
      if (state.status !== 'building') throw new ChunkPersistenceError('generation-not-building');
      if (state.symbols_imported_at === null) throw new ChunkPersistenceError('symbols-not-imported');
      const existing = await transaction.execute<CountRow>(STATEMENTS.countExisting, [request.generation_id]);
      if (existing.rows.length !== 1 || count(existing.rows[0].code_chunk_count) !== 0) throw new ChunkPersistenceError('dirty-generation');
      const verifiedFiles = new Set<string>();
      for (const batch of encodedBatches(prepared.fileIds.map((id) => ({ id })), prepared.batchSize)) {
        const result = await transaction.execute<IdRow>(STATEMENTS.validateFiles, [request.generation_id, batch]);
        for (const row of result.rows) {
          if (!UUID.test(row.id) || verifiedFiles.has(row.id.toLowerCase())) throw new ChunkPersistenceError('file-mismatch');
          verifiedFiles.add(row.id.toLowerCase());
        }
      }
      if (verifiedFiles.size !== prepared.fileIds.length || prepared.fileIds.some((id) => !verifiedFiles.has(id))) {
        throw new ChunkPersistenceError('file-mismatch');
      }
      const symbols = new Map<string, string>();
      for (const batch of encodedBatches(prepared.symbolUsrs.map((stable_usr) => ({ stable_usr })), prepared.batchSize)) {
        const result = await transaction.execute<SymbolIdRow>(STATEMENTS.resolveSymbols, [request.generation_id, batch]);
        for (const row of result.rows) {
          if (!UUID.test(row.id) || symbols.has(row.stable_usr)) throw new ChunkPersistenceError('symbol-mismatch');
          symbols.set(row.stable_usr, row.id.toLowerCase());
        }
      }
      if (symbols.size !== prepared.symbolUsrs.length || prepared.symbolUsrs.some((usr) => !symbols.has(usr))) {
        throw new ChunkPersistenceError('symbol-mismatch');
      }
      const rows = prepared.chunks.map(({ symbol_usr, ...chunk }) => ({ ...chunk, symbol_id: symbols.get(symbol_usr)! }));
      let writes = 0;
      for (const batch of encodedBatches(rows, prepared.batchSize)) {
        writes += (await transaction.execute(STATEMENTS.insertChunks, [request.generation_id, batch])).row_count;
      }
      if (writes !== prepared.chunks.length) throw new ChunkPersistenceError('write-mismatch');
      const completed = await transaction.execute(STATEMENTS.complete, [request.generation_id, request.plan_hash, prepared.payloadHash, prepared.chunks.length]);
      if (completed.row_count !== 1) throw new ChunkPersistenceError('write-mismatch');
      return report(request, prepared, false);
    });
  } catch (error) {
    if (error instanceof ChunkPersistenceError) throw error;
    throw new ChunkPersistenceError('transaction-failed');
  }
}
