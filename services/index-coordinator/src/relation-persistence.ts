import { createHash } from 'node:crypto';
import path from 'node:path';
import type { RelationIndex, SymbolEdgeType } from '../../../workers/clang-indexer/src/relation-index.ts';
import type { FixedSqlResult, FixedSqlStatement, PersistedFileBinding } from './symbol-persistence.ts';

export interface RelationPersistenceTransaction {
  execute<Row>(statement: FixedSqlStatement, values: readonly (string | number)[]): Promise<FixedSqlResult<Row>>;
}

export interface RelationPersistenceDatabase {
  transaction<Result>(operation: (transaction: RelationPersistenceTransaction) => Promise<Result>): Promise<Result>;
}

export interface RelationPersistenceRequest {
  generation_id: string;
  revision_set_hash: string;
  plan_hash: string;
  relations: RelationIndex;
  files: readonly PersistedFileBinding[];
  batch_size?: number;
}

export interface RelationPersistenceReport {
  generation_id: string;
  plan_hash: string;
  payload_hash: string;
  extracted_symbol_edge_record_count: number;
  accepted_symbol_edge_count: number;
  symbol_edge_count: number;
  coalesced_symbol_edge_count: number;
  extracted_file_edge_record_count: number;
  accepted_file_edge_count: number;
  file_dependency_count: number;
  coalesced_file_edge_count: number;
  unresolved_symbol_edge_count: number;
  unresolved_owner_edge_count: number;
  already_persisted: boolean;
}

export type RelationPersistenceErrorCode =
  | 'invalid-request'
  | 'generation-not-found'
  | 'generation-mismatch'
  | 'generation-not-building'
  | 'symbols-not-imported'
  | 'plan-conflict'
  | 'dirty-generation'
  | 'symbol-mismatch'
  | 'file-mismatch'
  | 'write-mismatch'
  | 'transaction-failed';

export class RelationPersistenceError extends Error {
  readonly code: RelationPersistenceErrorCode;

  constructor(code: RelationPersistenceErrorCode) {
    super(`relation persistence ${code}`);
    this.name = 'RelationPersistenceError';
    this.code = code;
  }
}

interface GenerationRow {
  revision_set_hash: string;
  status: string;
  symbols_imported_at: string | null;
  relation_plan_hash: string | null;
  relation_payload_hash: string | null;
  symbol_edge_count: string | number | null;
  file_dependency_count: string | number | null;
  relations_imported_at: string | null;
}

interface CountRow { symbol_edge_count: string | number; file_dependency_count: string | number }
interface IdRow { id: string }
interface SymbolIdRow { stable_usr: string; id: string }

interface SourceSymbolEdge {
  edge_type: SymbolEdgeType;
  src_usr: string;
  dst_usr: string;
  file_id: string | null;
  line: number | null;
  column: number | null;
  confidence: number;
}

interface StoredSymbolEdge {
  edge_type: SymbolEdgeType;
  src_usr: string;
  dst_usr: string;
  file_id: string | null;
  line: number | null;
  confidence: number;
}

interface SourceFileEdge {
  edge_type: 'include';
  src_file_id: string;
  dst_file_id: string;
  line: number;
  column: number;
}

interface StoredFileEdge {
  edge_type: 'include';
  src_file_id: string;
  dst_file_id: string;
}

interface PreparedRelations {
  files: readonly PersistedFileBinding[];
  symbolUsrs: readonly string[];
  sourceSymbolEdges: readonly SourceSymbolEdge[];
  symbolEdges: readonly StoredSymbolEdge[];
  sourceFileEdges: readonly SourceFileEdge[];
  fileEdges: readonly StoredFileEdge[];
  payloadHash: string;
  batchSize: number;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const SYMBOL_EDGE_TYPES = new Set<SymbolEdgeType>(['calls', 'references', 'inherits', 'overrides', 'owns']);
const RELATION_INDEX_KEYS = [
  'schema_version', 'symbol_edges', 'file_edges', 'source_symbol_edge_records', 'source_file_edge_records',
  'deduplicated_symbol_edges', 'deduplicated_file_edges', 'unresolved_symbol_edges', 'unresolved_owner_edges',
] as const;
const MAX_EDGES = 8_000_000;
const MAX_FILES = 2_000_000;
const MAX_BATCH_SIZE = 1_000;
const MAX_BATCH_BYTES = 8 * 1024 * 1024;

const STATEMENTS = Object.freeze({
  lockGeneration: Object.freeze({
    name: 'relation-persistence-lock-generation-v1',
    text: `SELECT encode(revision_set_hash, 'hex') AS revision_set_hash, status, symbols_imported_at::text,
      encode(relation_plan_hash, 'hex') AS relation_plan_hash,
      encode(relation_payload_hash, 'hex') AS relation_payload_hash,
      symbol_edge_count, file_dependency_count, relations_imported_at::text
      FROM ue_mcp.index_generations WHERE id = $1::uuid FOR UPDATE`,
  }),
  countExisting: Object.freeze({
    name: 'relation-persistence-count-existing-v1',
    text: `SELECT
      (SELECT count(*) FROM ue_mcp.symbol_edges edge
        JOIN ue_mcp.symbols source ON source.id = edge.src_symbol_id
        JOIN ue_mcp.symbols destination ON destination.id = edge.dst_symbol_id
        WHERE edge.edge_type IN ('calls', 'references', 'inherits', 'overrides', 'owns')
          AND (source.generation_id = $1::uuid OR destination.generation_id = $1::uuid)) AS symbol_edge_count,
      (SELECT count(*) FROM ue_mcp.file_dependencies dependency
        JOIN ue_mcp.files source ON source.id = dependency.src_file_id
        JOIN ue_mcp.files destination ON destination.id = dependency.dst_file_id
        WHERE dependency.edge_type = 'include'
          AND (source.generation_id = $1::uuid OR destination.generation_id = $1::uuid)) AS file_dependency_count`,
  }),
  validateFiles: Object.freeze({
    name: 'relation-persistence-validate-files-v1',
    text: `SELECT file.id::text AS id FROM ue_mcp.files file
      JOIN jsonb_to_recordset($2::jsonb) AS requested(id uuid) ON requested.id = file.id
      WHERE file.generation_id = $1::uuid ORDER BY file.id`,
  }),
  resolveSymbols: Object.freeze({
    name: 'relation-persistence-resolve-symbols-v1',
    text: `SELECT symbol.stable_usr, symbol.id::text AS id FROM ue_mcp.symbols symbol
      JOIN jsonb_to_recordset($2::jsonb) AS requested(stable_usr text) ON requested.stable_usr = symbol.stable_usr
      WHERE symbol.generation_id = $1::uuid ORDER BY symbol.stable_usr`,
  }),
  insertSymbolEdges: Object.freeze({
    name: 'relation-persistence-insert-symbol-edges-v1',
    text: `INSERT INTO ue_mcp.symbol_edges
      (src_symbol_id, edge_type, dst_symbol_id, file_id, line, confidence)
      SELECT input.src_symbol_id, input.edge_type, input.dst_symbol_id, input.file_id, input.line, input.confidence
      FROM jsonb_to_recordset($2::jsonb) AS input(
        src_symbol_id uuid, edge_type text, dst_symbol_id uuid, file_id uuid, line integer, confidence double precision)
      JOIN ue_mcp.symbols source ON source.id = input.src_symbol_id AND source.generation_id = $1::uuid
      JOIN ue_mcp.symbols destination ON destination.id = input.dst_symbol_id AND destination.generation_id = $1::uuid
      LEFT JOIN ue_mcp.files evidence ON evidence.id = input.file_id AND evidence.generation_id = $1::uuid
      WHERE input.file_id IS NULL OR evidence.id IS NOT NULL`,
  }),
  insertFileDependencies: Object.freeze({
    name: 'relation-persistence-insert-file-dependencies-v1',
    text: `INSERT INTO ue_mcp.file_dependencies (src_file_id, edge_type, dst_file_id)
      SELECT input.src_file_id, input.edge_type, input.dst_file_id
      FROM jsonb_to_recordset($2::jsonb) AS input(src_file_id uuid, edge_type text, dst_file_id uuid)
      JOIN ue_mcp.files source ON source.id = input.src_file_id AND source.generation_id = $1::uuid
      JOIN ue_mcp.files destination ON destination.id = input.dst_file_id AND destination.generation_id = $1::uuid`,
  }),
  complete: Object.freeze({
    name: 'relation-persistence-complete-v1',
    text: `UPDATE ue_mcp.index_generations SET
      relation_plan_hash = decode($2, 'hex'), relation_payload_hash = decode($3, 'hex'),
      symbol_edge_count = $4::bigint, file_dependency_count = $5::bigint, relations_imported_at = clock_timestamp()
      WHERE id = $1::uuid AND status = 'building' AND symbols_imported_at IS NOT NULL AND relations_imported_at IS NULL`,
  }),
});

function invalid(): never {
  throw new RelationPersistenceError('invalid-request');
}

function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\r\n\0]/.test(value)) invalid();
  return value;
}

function safeInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid();
  return value as number;
}

function storedCount(value: string | number | null): number {
  const count = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(count) || (count as number) < 0) throw new RelationPersistenceError('transaction-failed');
  return count as number;
}

function exactKeys(value: object, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) invalid();
}

function normalizedSourcePath(value: string): { key: string; value: string } {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) invalid();
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
  const batches: string[] = [];
  let current: Row[] = [];
  let bytes = 2;
  for (const row of rows) {
    const encoded = JSON.stringify(row);
    const rowBytes = Buffer.byteLength(encoded, 'utf8') + (current.length === 0 ? 0 : 1);
    if (rowBytes + 2 > MAX_BATCH_BYTES) invalid();
    if (current.length >= batchSize || bytes + rowBytes > MAX_BATCH_BYTES) {
      batches.push(JSON.stringify(current));
      current = [];
      bytes = 2;
    }
    current.push(row);
    bytes += rowBytes;
  }
  if (current.length > 0) batches.push(JSON.stringify(current));
  return Object.freeze(batches);
}

function prepare(request: RelationPersistenceRequest): PreparedRelations {
  if (!UUID.test(request.generation_id) || !HASH.test(request.revision_set_hash) || !HASH.test(request.plan_hash)
      || typeof request.relations !== 'object' || request.relations === null || !Array.isArray(request.files)
      || request.files.length > MAX_FILES) invalid();
  exactKeys(request.relations, RELATION_INDEX_KEYS);
  if (request.relations.schema_version !== 1 || !Array.isArray(request.relations.symbol_edges)
      || !Array.isArray(request.relations.file_edges)
      || request.relations.symbol_edges.length + request.relations.file_edges.length > MAX_EDGES) invalid();
  for (const value of [request.relations.source_symbol_edge_records, request.relations.source_file_edge_records,
    request.relations.deduplicated_symbol_edges, request.relations.deduplicated_file_edges,
    request.relations.unresolved_symbol_edges, request.relations.unresolved_owner_edges]) safeInteger(value);
  const batchSize = request.batch_size ?? 500;
  safeInteger(batchSize, 1, MAX_BATCH_SIZE);

  const filesByPath = new Map<string, PersistedFileBinding>();
  const fileIds = new Set<string>();
  for (const file of request.files) {
    if (typeof file !== 'object' || file === null || !UUID.test(file.id)) invalid();
    const sourcePath = normalizedSourcePath(file.absolute_path);
    const id = file.id.toLowerCase();
    if (filesByPath.has(sourcePath.key) || fileIds.has(id)) invalid();
    filesByPath.set(sourcePath.key, Object.freeze({ id, absolute_path: sourcePath.value }));
    fileIds.add(id);
  }
  const usedFileIds = new Set<string>();
  const fileId = (value: string): string => {
    const binding = filesByPath.get(normalizedSourcePath(value).key);
    if (binding === undefined) invalid();
    usedFileIds.add(binding.id);
    return binding.id;
  };
  const symbolUsrs = new Set<string>();
  const sourceSymbolKeys = new Set<string>();
  const sourceSymbolEdges = request.relations.symbol_edges.map((edge): SourceSymbolEdge => {
    if (typeof edge !== 'object' || edge === null) invalid();
    exactKeys(edge, ['edge_type', 'src_usr', 'dst_usr', 'confidence', ...(edge.file === undefined ? [] : ['file', 'line', 'column'])]);
    if (!SYMBOL_EDGE_TYPES.has(edge.edge_type)) invalid();
    const srcUsr = boundedString(edge.src_usr, 4_096);
    const dstUsr = boundedString(edge.dst_usr, 4_096);
    if ((edge.edge_type === 'inherits' || edge.edge_type === 'overrides' || edge.edge_type === 'owns') && srcUsr === dstUsr) invalid();
    symbolUsrs.add(srcUsr);
    symbolUsrs.add(dstUsr);
    const hasLocation = edge.file !== undefined || edge.line !== undefined || edge.column !== undefined;
    if (hasLocation && (edge.file === undefined || edge.line === undefined || edge.column === undefined)) invalid();
    if (edge.edge_type === 'owns' && hasLocation) invalid();
    if (typeof edge.confidence !== 'number' || !Number.isFinite(edge.confidence) || edge.confidence < 0 || edge.confidence > 1) invalid();
    const normalized = Object.freeze({
      edge_type: edge.edge_type,
      src_usr: srcUsr,
      dst_usr: dstUsr,
      file_id: hasLocation ? fileId(edge.file!) : null,
      line: hasLocation ? safeInteger(edge.line, 1, 10_000_000) : null,
      column: hasLocation ? safeInteger(edge.column, 1, 10_000_000) : null,
      confidence: edge.confidence,
    });
    const key = JSON.stringify([
      normalized.edge_type, normalized.src_usr, normalized.dst_usr,
      normalized.file_id, normalized.line, normalized.column,
    ]);
    if (sourceSymbolKeys.has(key)) invalid();
    sourceSymbolKeys.add(key);
    return normalized;
  }).sort((left, right) => left.edge_type.localeCompare(right.edge_type, 'en')
    || left.src_usr.localeCompare(right.src_usr, 'en') || left.dst_usr.localeCompare(right.dst_usr, 'en')
    || (left.file_id ?? '').localeCompare(right.file_id ?? '', 'en') || (left.line ?? 0) - (right.line ?? 0)
    || (left.column ?? 0) - (right.column ?? 0));

  const storedSymbolEdges = new Map<string, StoredSymbolEdge>();
  for (const edge of sourceSymbolEdges) {
    const stored = Object.freeze({
      edge_type: edge.edge_type, src_usr: edge.src_usr, dst_usr: edge.dst_usr,
      file_id: edge.file_id, line: edge.line, confidence: edge.confidence,
    });
    const key = JSON.stringify([stored.edge_type, stored.src_usr, stored.dst_usr, stored.file_id, stored.line]);
    const existing = storedSymbolEdges.get(key);
    if (existing === undefined || stored.confidence > existing.confidence) storedSymbolEdges.set(key, stored);
  }

  const sourceFileKeys = new Set<string>();
  const sourceFileEdges = request.relations.file_edges.map((edge): SourceFileEdge => {
    if (typeof edge !== 'object' || edge === null) invalid();
    exactKeys(edge, ['edge_type', 'src_file', 'dst_file', 'line', 'column']);
    if (edge.edge_type !== 'include') invalid();
    const srcFileId = fileId(edge.src_file);
    const dstFileId = fileId(edge.dst_file);
    if (srcFileId === dstFileId) invalid();
    const normalized = Object.freeze({
      edge_type: 'include' as const, src_file_id: srcFileId, dst_file_id: dstFileId,
      line: safeInteger(edge.line, 1, 10_000_000), column: safeInteger(edge.column, 1, 10_000_000),
    });
    const key = JSON.stringify(normalized);
    if (sourceFileKeys.has(key)) invalid();
    sourceFileKeys.add(key);
    return normalized;
  }).sort((left, right) => left.src_file_id.localeCompare(right.src_file_id, 'en')
    || left.dst_file_id.localeCompare(right.dst_file_id, 'en') || left.line - right.line || left.column - right.column);

  const storedFileEdges = new Map<string, StoredFileEdge>();
  for (const edge of sourceFileEdges) {
    const stored = Object.freeze({ edge_type: 'include' as const, src_file_id: edge.src_file_id, dst_file_id: edge.dst_file_id });
    storedFileEdges.set(JSON.stringify(stored), stored);
  }
  if (usedFileIds.size !== filesByPath.size || [...filesByPath.values()].some(({ id }) => !usedFileIds.has(id))) invalid();
  const files = [...filesByPath.values()].sort((left, right) => left.id.localeCompare(right.id, 'en'));
  const payloadHash = createHash('sha256').update(JSON.stringify({
    schema_version: 1,
    source_symbol_edge_records: request.relations.source_symbol_edge_records,
    source_file_edge_records: request.relations.source_file_edge_records,
    deduplicated_symbol_edges: request.relations.deduplicated_symbol_edges,
    deduplicated_file_edges: request.relations.deduplicated_file_edges,
    unresolved_symbol_edges: request.relations.unresolved_symbol_edges,
    unresolved_owner_edges: request.relations.unresolved_owner_edges,
    symbol_edges: sourceSymbolEdges,
    file_edges: sourceFileEdges,
  })).digest('hex');
  return Object.freeze({
    files: Object.freeze(files), symbolUsrs: Object.freeze([...symbolUsrs].sort((left, right) => left.localeCompare(right, 'en'))),
    sourceSymbolEdges: Object.freeze(sourceSymbolEdges), symbolEdges: Object.freeze([...storedSymbolEdges.values()]),
    sourceFileEdges: Object.freeze(sourceFileEdges), fileEdges: Object.freeze([...storedFileEdges.values()]),
    payloadHash, batchSize,
  });
}

function report(request: RelationPersistenceRequest, prepared: PreparedRelations, alreadyPersisted: boolean): RelationPersistenceReport {
  return Object.freeze({
    generation_id: request.generation_id, plan_hash: request.plan_hash, payload_hash: prepared.payloadHash,
    extracted_symbol_edge_record_count: request.relations.source_symbol_edge_records,
    accepted_symbol_edge_count: prepared.sourceSymbolEdges.length, symbol_edge_count: prepared.symbolEdges.length,
    coalesced_symbol_edge_count: prepared.sourceSymbolEdges.length - prepared.symbolEdges.length,
    extracted_file_edge_record_count: request.relations.source_file_edge_records,
    accepted_file_edge_count: prepared.sourceFileEdges.length, file_dependency_count: prepared.fileEdges.length,
    coalesced_file_edge_count: prepared.sourceFileEdges.length - prepared.fileEdges.length,
    unresolved_symbol_edge_count: request.relations.unresolved_symbol_edges,
    unresolved_owner_edge_count: request.relations.unresolved_owner_edges,
    already_persisted: alreadyPersisted,
  });
}

export async function persistIndexedRelations(
  database: RelationPersistenceDatabase,
  request: RelationPersistenceRequest,
): Promise<RelationPersistenceReport> {
  if (typeof database !== 'object' || database === null || typeof database.transaction !== 'function') invalid();
  const prepared = prepare(request);
  try {
    return await database.transaction(async (transaction) => {
      if (typeof transaction !== 'object' || transaction === null || typeof transaction.execute !== 'function') {
        throw new RelationPersistenceError('transaction-failed');
      }
      const generation = await transaction.execute<GenerationRow>(STATEMENTS.lockGeneration, [request.generation_id]);
      if (generation.rows.length !== 1) throw new RelationPersistenceError('generation-not-found');
      const state = generation.rows[0];
      if (state.revision_set_hash !== request.revision_set_hash) throw new RelationPersistenceError('generation-mismatch');
      if (state.relations_imported_at !== null) {
        if (state.relation_plan_hash !== request.plan_hash || state.relation_payload_hash !== prepared.payloadHash
            || storedCount(state.symbol_edge_count) !== prepared.symbolEdges.length
            || storedCount(state.file_dependency_count) !== prepared.fileEdges.length) {
          throw new RelationPersistenceError('plan-conflict');
        }
        return report(request, prepared, true);
      }
      if (state.relation_plan_hash !== null || state.relation_payload_hash !== null
          || state.symbol_edge_count !== null || state.file_dependency_count !== null) {
        throw new RelationPersistenceError('dirty-generation');
      }
      if (state.status !== 'building') throw new RelationPersistenceError('generation-not-building');
      if (state.symbols_imported_at === null) throw new RelationPersistenceError('symbols-not-imported');
      const existing = await transaction.execute<CountRow>(STATEMENTS.countExisting, [request.generation_id]);
      if (existing.rows.length !== 1 || storedCount(existing.rows[0].symbol_edge_count) !== 0
          || storedCount(existing.rows[0].file_dependency_count) !== 0) {
        throw new RelationPersistenceError('dirty-generation');
      }
      const verifiedFileIds = new Set<string>();
      for (const batch of encodedBatches(prepared.files.map(({ id }) => ({ id })), prepared.batchSize)) {
        const result = await transaction.execute<IdRow>(STATEMENTS.validateFiles, [request.generation_id, batch]);
        for (const row of result.rows) {
          if (!UUID.test(row.id) || verifiedFileIds.has(row.id.toLowerCase())) throw new RelationPersistenceError('file-mismatch');
          verifiedFileIds.add(row.id.toLowerCase());
        }
      }
      if (verifiedFileIds.size !== prepared.files.length || prepared.files.some(({ id }) => !verifiedFileIds.has(id))) {
        throw new RelationPersistenceError('file-mismatch');
      }
      const idsByUsr = new Map<string, string>();
      for (const batch of encodedBatches(prepared.symbolUsrs.map((stable_usr) => ({ stable_usr })), prepared.batchSize)) {
        const result = await transaction.execute<SymbolIdRow>(STATEMENTS.resolveSymbols, [request.generation_id, batch]);
        for (const row of result.rows) {
          if (!UUID.test(row.id) || idsByUsr.has(row.stable_usr)) throw new RelationPersistenceError('symbol-mismatch');
          idsByUsr.set(row.stable_usr, row.id.toLowerCase());
        }
      }
      if (idsByUsr.size !== prepared.symbolUsrs.length || prepared.symbolUsrs.some((usr) => !idsByUsr.has(usr))) {
        throw new RelationPersistenceError('symbol-mismatch');
      }
      const symbolRows = prepared.symbolEdges.map((edge) => ({
        src_symbol_id: idsByUsr.get(edge.src_usr)!, edge_type: edge.edge_type,
        dst_symbol_id: idsByUsr.get(edge.dst_usr)!, file_id: edge.file_id,
        line: edge.line, confidence: edge.confidence,
      }));
      let symbolWrites = 0;
      for (const batch of encodedBatches(symbolRows, prepared.batchSize)) {
        symbolWrites += (await transaction.execute(STATEMENTS.insertSymbolEdges, [request.generation_id, batch])).row_count;
      }
      if (symbolWrites !== prepared.symbolEdges.length) throw new RelationPersistenceError('write-mismatch');
      let fileWrites = 0;
      for (const batch of encodedBatches(prepared.fileEdges, prepared.batchSize)) {
        fileWrites += (await transaction.execute(STATEMENTS.insertFileDependencies, [request.generation_id, batch])).row_count;
      }
      if (fileWrites !== prepared.fileEdges.length) throw new RelationPersistenceError('write-mismatch');
      const completed = await transaction.execute(STATEMENTS.complete, [
        request.generation_id, request.plan_hash, prepared.payloadHash, prepared.symbolEdges.length, prepared.fileEdges.length,
      ]);
      if (completed.row_count !== 1) throw new RelationPersistenceError('write-mismatch');
      return report(request, prepared, false);
    });
  } catch (error) {
    if (error instanceof RelationPersistenceError) throw error;
    throw new RelationPersistenceError('transaction-failed');
  }
}
