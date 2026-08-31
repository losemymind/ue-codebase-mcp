import type { FixedSqlResult, FixedSqlStatement } from '../../index-coordinator/src/symbol-persistence.ts';

export interface RetrievalStoreDatabase {
  execute<Row>(statement: FixedSqlStatement, values: readonly (string | number)[]): Promise<FixedSqlResult<Row>>;
}

export interface RetrievalScope {
  project_id: string;
  generation_id: string;
  authorized_paths: readonly {
    repository_id: string;
    path_prefix: string;
  }[];
  acl_context_hash: string;
  embedding_profile?: {
    provider_id: string;
    model: string;
    dimensions: number;
  };
}

export type RetrievalSignal = 'exact' | 'fts' | 'vector' | 'graph';
export type RetrievalCandidateType = 'symbol' | 'chunk';
export type GraphDirection = 'incoming' | 'outgoing' | 'both';
export type GraphEdgeType = 'calls' | 'references' | 'inherits' | 'overrides' | 'owns' | 'instantiates' | 'aliases';

export interface RetrievalCandidate {
  readonly signal: RetrievalSignal;
  readonly candidate_type: RetrievalCandidateType;
  readonly symbol_id: string | null;
  readonly stable_usr: string | null;
  readonly qualified_name: string | null;
  readonly symbol_kind: string | null;
  readonly chunk_id: string | null;
  readonly chunk_key: string | null;
  readonly chunk_kind: string | null;
  readonly file_id: string | null;
  readonly file_path: string | null;
  readonly text: string | null;
  readonly raw_score: number;
  readonly edge_type: GraphEdgeType | null;
}

export interface ExactSymbolRequest { readonly query: string; readonly limit?: number }
export interface FtsChunkRequest { readonly query: string; readonly limit?: number }
export interface VectorChunkRequest {
  readonly provider_id: string;
  readonly model: string;
  readonly dimensions: number;
  readonly embedding: readonly number[];
  readonly limit?: number;
}
export interface GraphSignalRequest {
  readonly anchor_usr: string;
  readonly edge_types?: readonly GraphEdgeType[];
  readonly direction?: GraphDirection;
  readonly limit?: number;
}

export interface RetrievalStore {
  exactSymbols(request: ExactSymbolRequest): Promise<readonly RetrievalCandidate[]>;
  ftsChunks(request: FtsChunkRequest): Promise<readonly RetrievalCandidate[]>;
  vectorChunks(request: VectorChunkRequest): Promise<readonly RetrievalCandidate[]>;
  graphSignals(request: GraphSignalRequest): Promise<readonly RetrievalCandidate[]>;
}

export type RetrievalStoreErrorCode = 'invalid-request' | 'scope-not-active' | 'result-invalid' | 'database-failed';

export class RetrievalStoreError extends Error {
  readonly code: RetrievalStoreErrorCode;

  constructor(code: RetrievalStoreErrorCode) {
    super(`retrieval store ${code}`);
    this.name = 'RetrievalStoreError';
    this.code = code;
  }
}

interface CandidateRow {
  scope_generation_id: string;
  candidate_type: string | null;
  symbol_id: string | null;
  stable_usr: string | null;
  qualified_name: string | null;
  symbol_kind: string | null;
  chunk_id: string | null;
  chunk_key: string | null;
  chunk_kind: string | null;
  file_id: string | null;
  file_path: string | null;
  text: string | null;
  raw_score: string | number | null;
  edge_type: string | null;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const EDGE_TYPES = Object.freeze<readonly GraphEdgeType[]>([
  'aliases', 'calls', 'inherits', 'instantiates', 'overrides', 'owns', 'references',
]);
const EDGE_TYPE_SET = new Set<string>(EDGE_TYPES);
const CHUNK_KINDS = new Set(['declaration', 'definition', 'documentation', 'file_context']);
const SYMBOL_KINDS = new Set([
  'namespace', 'module', 'class', 'struct', 'union', 'enum', 'enumerator', 'function', 'method', 'constructor',
  'destructor', 'variable', 'field', 'parameter', 'typedef', 'type_alias', 'macro', 'concept',
]);
const MAX_LIMIT = 100;
const MAX_EXACT_BYTES = 4_096;
const MAX_FTS_BYTES = 1_024;
const MAX_VECTOR_DIMENSIONS = 16_000;
const MAX_VECTOR_ABS_VALUE = 1_000_000;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_AUTHORIZED_PATHS = 10_000;

const CANDIDATE_COLUMNS = `candidate.candidate_type, candidate.symbol_id, candidate.stable_usr,
      candidate.qualified_name, candidate.symbol_kind, candidate.chunk_id, candidate.chunk_key, candidate.chunk_kind,
      candidate.file_id, candidate.file_path, candidate.text, candidate.raw_score, candidate.edge_type`;

const STATEMENTS = Object.freeze({
  exactSymbols: Object.freeze({
    name: 'retrieval-store-exact-symbols-v1',
    text: `WITH scope AS (
      SELECT generation.id FROM ue_mcp.index_generations generation
      JOIN ue_mcp.projects project ON project.id = generation.project_id
      WHERE project.id = $1::uuid AND generation.id = $2::uuid
        AND project.status = 'active' AND generation.status = 'active'
    ), acl AS (
      SELECT repository_id, path_prefix
      FROM jsonb_to_recordset($3::jsonb) AS item(repository_id uuid, path_prefix text)
    )
    SELECT scope.id::text AS scope_generation_id, ${CANDIDATE_COLUMNS}
    FROM scope LEFT JOIN LATERAL (
      SELECT 'chunk'::text AS candidate_type, symbol.id::text AS symbol_id,
        symbol.stable_usr, symbol.qualified_name, symbol.kind AS symbol_kind,
        chunk.id::text AS chunk_id, encode(chunk.stable_key, 'hex') AS chunk_key, chunk.chunk_kind,
        file.id::text AS file_id, file.path AS file_path, chunk.text,
        CASE WHEN symbol.stable_usr = $4 THEN 1.0 ELSE 0.95 END::double precision AS raw_score,
        NULL::text AS edge_type
      FROM ue_mcp.symbols symbol
      JOIN ue_mcp.code_chunks chunk ON chunk.symbol_id = symbol.id AND chunk.generation_id = scope.id
      JOIN ue_mcp.files file ON file.id = chunk.file_id AND file.generation_id = scope.id
      JOIN ue_mcp.repositories repository ON repository.id = file.repository_id AND repository.project_id = $1::uuid
      WHERE symbol.generation_id = scope.id
        AND (symbol.stable_usr = $4 OR symbol.qualified_name = $4 OR symbol.name = $4)
        AND EXISTS (SELECT 1 FROM acl WHERE acl.repository_id = file.repository_id
          AND (acl.path_prefix = '' OR file.path = acl.path_prefix OR starts_with(file.path, acl.path_prefix || '/')))
      ORDER BY raw_score DESC, CASE chunk.chunk_kind WHEN 'definition' THEN 0 WHEN 'declaration' THEN 1 ELSE 2 END,
        symbol.qualified_name, chunk.stable_key
      LIMIT $5::integer
    ) candidate ON TRUE`,
  }),
  ftsChunks: Object.freeze({
    name: 'retrieval-store-fts-chunks-v1',
    text: `WITH scope AS (
      SELECT generation.id FROM ue_mcp.index_generations generation
      JOIN ue_mcp.projects project ON project.id = generation.project_id
      WHERE project.id = $1::uuid AND generation.id = $2::uuid
        AND project.status = 'active' AND generation.status = 'active'
    ), acl AS (
      SELECT repository_id, path_prefix
      FROM jsonb_to_recordset($3::jsonb) AS item(repository_id uuid, path_prefix text)
    ), query AS (SELECT plainto_tsquery('simple'::regconfig, $4) AS value)
    SELECT scope.id::text AS scope_generation_id, ${CANDIDATE_COLUMNS}
    FROM scope LEFT JOIN LATERAL (
      SELECT 'chunk'::text AS candidate_type, symbol.id::text AS symbol_id,
        symbol.stable_usr, symbol.qualified_name, symbol.kind AS symbol_kind,
        chunk.id::text AS chunk_id, encode(chunk.stable_key, 'hex') AS chunk_key, chunk.chunk_kind, file.id::text AS file_id,
        file.path AS file_path, chunk.text,
        ts_rank_cd(chunk.search_vector, query.value)::double precision AS raw_score,
        NULL::text AS edge_type
      FROM ue_mcp.code_chunks chunk
      JOIN ue_mcp.files file ON file.id = chunk.file_id AND file.generation_id = scope.id
      JOIN ue_mcp.repositories repository ON repository.id = file.repository_id AND repository.project_id = $1::uuid
      LEFT JOIN ue_mcp.symbols symbol ON symbol.id = chunk.symbol_id AND symbol.generation_id = scope.id
      CROSS JOIN query
      WHERE chunk.generation_id = scope.id AND chunk.search_vector @@ query.value
        AND EXISTS (SELECT 1 FROM acl WHERE acl.repository_id = file.repository_id
          AND (acl.path_prefix = '' OR file.path = acl.path_prefix OR starts_with(file.path, acl.path_prefix || '/')))
      ORDER BY raw_score DESC, chunk.stable_key
      LIMIT $5::integer
    ) candidate ON TRUE`,
  }),
  vectorChunks1536: Object.freeze({
    name: 'retrieval-store-vector-chunks-1536-v1',
    text: `WITH scope AS (
      SELECT generation.id FROM ue_mcp.index_generations generation
      JOIN ue_mcp.projects project ON project.id = generation.project_id
      WHERE project.id = $1::uuid AND generation.id = $2::uuid
        AND project.status = 'active' AND generation.status = 'active'
    ), acl AS (
      SELECT repository_id, path_prefix
      FROM jsonb_to_recordset($3::jsonb) AS item(repository_id uuid, path_prefix text)
    )
    SELECT scope.id::text AS scope_generation_id, ${CANDIDATE_COLUMNS}
    FROM scope LEFT JOIN LATERAL (
      SELECT 'chunk'::text AS candidate_type, symbol.id::text AS symbol_id,
        symbol.stable_usr, symbol.qualified_name, symbol.kind AS symbol_kind,
        chunk.id::text AS chunk_id, encode(chunk.stable_key, 'hex') AS chunk_key, chunk.chunk_kind, file.id::text AS file_id,
        file.path AS file_path, chunk.text,
        GREATEST(0.0, 1.0 - (embedding.embedding::vector(1536) <=> $7::vector(1536)))::double precision AS raw_score,
        NULL::text AS edge_type
      FROM ue_mcp.chunk_embeddings embedding
      JOIN ue_mcp.code_chunks chunk ON chunk.id = embedding.chunk_id AND chunk.generation_id = scope.id
      JOIN ue_mcp.files file ON file.id = chunk.file_id AND file.generation_id = scope.id
      JOIN ue_mcp.repositories repository ON repository.id = file.repository_id AND repository.project_id = $1::uuid
      LEFT JOIN ue_mcp.symbols symbol ON symbol.id = chunk.symbol_id AND symbol.generation_id = scope.id
      WHERE embedding.provider = $4 AND embedding.model = $5 AND embedding.dimensions = $6::integer
        AND EXISTS (SELECT 1 FROM acl WHERE acl.repository_id = file.repository_id
          AND (acl.path_prefix = '' OR file.path = acl.path_prefix OR starts_with(file.path, acl.path_prefix || '/')))
      ORDER BY embedding.embedding::vector(1536) <=> $7::vector(1536), chunk.stable_key
      LIMIT $8::integer
    ) candidate ON TRUE`,
  }),
  vectorChunksGeneric: Object.freeze({
    name: 'retrieval-store-vector-chunks-generic-v1',
    text: `WITH scope AS (
      SELECT generation.id FROM ue_mcp.index_generations generation
      JOIN ue_mcp.projects project ON project.id = generation.project_id
      WHERE project.id = $1::uuid AND generation.id = $2::uuid
        AND project.status = 'active' AND generation.status = 'active'
    ), acl AS (
      SELECT repository_id, path_prefix
      FROM jsonb_to_recordset($3::jsonb) AS item(repository_id uuid, path_prefix text)
    )
    SELECT scope.id::text AS scope_generation_id, ${CANDIDATE_COLUMNS}
    FROM scope LEFT JOIN LATERAL (
      SELECT 'chunk'::text AS candidate_type, symbol.id::text AS symbol_id,
        symbol.stable_usr, symbol.qualified_name, symbol.kind AS symbol_kind,
        chunk.id::text AS chunk_id, encode(chunk.stable_key, 'hex') AS chunk_key, chunk.chunk_kind,
        file.id::text AS file_id, file.path AS file_path, chunk.text,
        GREATEST(0.0, 1.0 - (embedding.embedding <=> $7::vector))::double precision AS raw_score,
        NULL::text AS edge_type
      FROM ue_mcp.chunk_embeddings embedding
      JOIN ue_mcp.code_chunks chunk ON chunk.id = embedding.chunk_id AND chunk.generation_id = scope.id
      JOIN ue_mcp.files file ON file.id = chunk.file_id AND file.generation_id = scope.id
      JOIN ue_mcp.repositories repository ON repository.id = file.repository_id AND repository.project_id = $1::uuid
      LEFT JOIN ue_mcp.symbols symbol ON symbol.id = chunk.symbol_id AND symbol.generation_id = scope.id
      WHERE embedding.provider = $4 AND embedding.model = $5 AND embedding.dimensions = $6::integer
        AND EXISTS (SELECT 1 FROM acl WHERE acl.repository_id = file.repository_id
          AND (acl.path_prefix = '' OR file.path = acl.path_prefix OR starts_with(file.path, acl.path_prefix || '/')))
      ORDER BY embedding.embedding <=> $7::vector, chunk.stable_key
      LIMIT $8::integer
    ) candidate ON TRUE`,
  }),
  graphSignals: Object.freeze({
    name: 'retrieval-store-graph-signals-v1',
    text: `WITH scope AS (
      SELECT generation.id FROM ue_mcp.index_generations generation
      JOIN ue_mcp.projects project ON project.id = generation.project_id
      WHERE project.id = $1::uuid AND generation.id = $2::uuid
        AND project.status = 'active' AND generation.status = 'active'
    ), acl AS (
      SELECT repository_id, path_prefix
      FROM jsonb_to_recordset($3::jsonb) AS item(repository_id uuid, path_prefix text)
    )
    SELECT scope.id::text AS scope_generation_id, ${CANDIDATE_COLUMNS}
    FROM scope LEFT JOIN LATERAL (
      SELECT 'chunk'::text AS candidate_type, candidate_symbol.id::text AS symbol_id,
        candidate_symbol.stable_usr, candidate_symbol.qualified_name, candidate_symbol.kind AS symbol_kind,
        chunk.id::text AS chunk_id, encode(chunk.stable_key, 'hex') AS chunk_key, chunk.chunk_kind,
        file.id::text AS file_id, file.path AS file_path, chunk.text, edge.confidence::double precision AS raw_score,
        edge.edge_type
      FROM ue_mcp.symbols anchor
      JOIN ue_mcp.symbol_edges edge ON
        (($6 = 'outgoing' OR $6 = 'both') AND edge.src_symbol_id = anchor.id)
        OR (($6 = 'incoming' OR $6 = 'both') AND edge.dst_symbol_id = anchor.id)
      JOIN ue_mcp.symbols candidate_symbol ON candidate_symbol.id = CASE
        WHEN edge.src_symbol_id = anchor.id THEN edge.dst_symbol_id ELSE edge.src_symbol_id END
        AND candidate_symbol.generation_id = scope.id
      JOIN ue_mcp.code_chunks chunk ON chunk.symbol_id = candidate_symbol.id AND chunk.generation_id = scope.id
      JOIN ue_mcp.files file ON file.id = chunk.file_id AND file.generation_id = scope.id
      JOIN ue_mcp.repositories repository ON repository.id = file.repository_id AND repository.project_id = $1::uuid
      WHERE anchor.generation_id = scope.id AND anchor.stable_usr = $4
        AND edge.edge_type IN (SELECT jsonb_array_elements_text($5::jsonb))
        AND EXISTS (SELECT 1 FROM ue_mcp.symbol_locations anchor_location
          JOIN ue_mcp.files anchor_file ON anchor_file.id = anchor_location.file_id AND anchor_file.generation_id = scope.id
          JOIN ue_mcp.repositories anchor_repository ON anchor_repository.id = anchor_file.repository_id AND anchor_repository.project_id = $1::uuid
          WHERE anchor_location.symbol_id = anchor.id AND EXISTS (SELECT 1 FROM acl
            WHERE acl.repository_id = anchor_file.repository_id AND (acl.path_prefix = '' OR anchor_file.path = acl.path_prefix
              OR starts_with(anchor_file.path, acl.path_prefix || '/'))))
        AND EXISTS (SELECT 1 FROM acl WHERE acl.repository_id = file.repository_id
          AND (acl.path_prefix = '' OR file.path = acl.path_prefix OR starts_with(file.path, acl.path_prefix || '/')))
        AND (edge.file_id IS NULL OR EXISTS (SELECT 1 FROM ue_mcp.files edge_file
          JOIN ue_mcp.repositories edge_repository ON edge_repository.id = edge_file.repository_id AND edge_repository.project_id = $1::uuid
          WHERE edge_file.id = edge.file_id AND edge_file.generation_id = scope.id AND EXISTS (SELECT 1 FROM acl
            WHERE acl.repository_id = edge_file.repository_id AND (acl.path_prefix = '' OR edge_file.path = acl.path_prefix
              OR starts_with(edge_file.path, acl.path_prefix || '/')))))
      ORDER BY raw_score DESC, candidate_symbol.qualified_name, chunk.stable_key, edge.edge_type
      LIMIT $7::integer
    ) candidate ON TRUE`,
  }),
});

function invalid(): never {
  throw new RetrievalStoreError('invalid-request');
}

function boundedString(value: unknown, maximumBytes: number): string {
  if (typeof value !== 'string') invalid();
  const normalized = value.trim().normalize('NFC');
  if (normalized.length === 0 || Buffer.byteLength(normalized, 'utf8') > maximumBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) invalid();
  return normalized;
}

function limit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_LIMIT) invalid();
  return value as number;
}

function nullableString(value: unknown, maximumBytes: number): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maximumBytes) throw new RetrievalStoreError('result-invalid');
  return value;
}

function filePath(value: unknown): string | null {
  const result = nullableString(value, 32_768);
  if (result !== null && (result.length === 0 || result.includes('\\') || result.startsWith('/') || /[\r\n\0]/.test(result)
      || result.split('/').some((part) => part.length === 0 || part === '.' || part === '..'))) throw new RetrievalStoreError('result-invalid');
  return result;
}

function parseCandidates(signal: RetrievalSignal, generationId: string, rows: readonly CandidateRow[]): readonly RetrievalCandidate[] {
  if (rows.length === 0) throw new RetrievalStoreError('scope-not-active');
  if (rows.some((row) => typeof row !== 'object' || row === null || typeof row.scope_generation_id !== 'string'
      || !UUID.test(row.scope_generation_id) || row.scope_generation_id.toLowerCase() !== generationId)) {
    throw new RetrievalStoreError('result-invalid');
  }
  if (rows.length === 1 && rows[0].candidate_type === null) {
    if (Object.entries(rows[0]).some(([key, value]) => key !== 'scope_generation_id' && value !== null)) {
      throw new RetrievalStoreError('result-invalid');
    }
    return Object.freeze([]);
  }
  const candidates = rows.map((row): RetrievalCandidate => {
    if ((row.candidate_type !== 'symbol' && row.candidate_type !== 'chunk')
        || (row.symbol_id !== null && !UUID.test(row.symbol_id))) throw new RetrievalStoreError('result-invalid');
    const hasNoSymbol = row.symbol_id === null && row.stable_usr === null && row.qualified_name === null && row.symbol_kind === null;
    const hasValidSymbol = row.symbol_id !== null && row.stable_usr !== null && Buffer.byteLength(row.stable_usr, 'utf8') <= 4_096
      && row.qualified_name !== null && Buffer.byteLength(row.qualified_name, 'utf8') <= 4_096
      && row.symbol_kind !== null && SYMBOL_KINDS.has(row.symbol_kind);
    if ((!hasNoSymbol && !hasValidSymbol) || (row.candidate_type === 'symbol' && !hasValidSymbol)) {
      throw new RetrievalStoreError('result-invalid');
    }
    const score = typeof row.raw_score === 'string' ? Number(row.raw_score) : row.raw_score;
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0) throw new RetrievalStoreError('result-invalid');
    if (row.candidate_type === 'chunk' && (row.chunk_id === null || !UUID.test(row.chunk_id)
        || row.chunk_key === null || !HASH.test(row.chunk_key)
        || row.chunk_kind === null || !CHUNK_KINDS.has(row.chunk_kind)
        || row.file_id === null || !UUID.test(row.file_id) || row.file_path === null || row.text === null)) {
      throw new RetrievalStoreError('result-invalid');
    }
    if (row.candidate_type === 'symbol' && (row.chunk_id !== null || row.chunk_key !== null || row.chunk_kind !== null || row.text !== null)) {
      throw new RetrievalStoreError('result-invalid');
    }
    if (row.file_id !== null && !UUID.test(row.file_id)) throw new RetrievalStoreError('result-invalid');
    if ((row.file_id === null) !== (row.file_path === null)) throw new RetrievalStoreError('result-invalid');
    const edgeType = row.edge_type;
    if ((signal === 'graph') !== (typeof edgeType === 'string' && EDGE_TYPE_SET.has(edgeType))) throw new RetrievalStoreError('result-invalid');
    return Object.freeze({
      signal, candidate_type: row.candidate_type, symbol_id: row.symbol_id?.toLowerCase() ?? null, stable_usr: row.stable_usr,
      qualified_name: row.qualified_name, symbol_kind: row.symbol_kind,
      chunk_id: row.chunk_id?.toLowerCase() ?? null, chunk_key: row.chunk_key, chunk_kind: row.chunk_kind,
      file_id: row.file_id?.toLowerCase() ?? null, file_path: filePath(row.file_path),
      text: nullableString(row.text, MAX_TEXT_BYTES), raw_score: score, edge_type: edgeType as GraphEdgeType | null,
    });
  });
  return Object.freeze(candidates);
}

export function createRetrievalStore(database: RetrievalStoreDatabase, scope: RetrievalScope): RetrievalStore {
  if (typeof database !== 'object' || database === null || typeof database.execute !== 'function'
      || typeof scope !== 'object' || scope === null || !UUID.test(scope.project_id) || !UUID.test(scope.generation_id)
      || !HASH.test(scope.acl_context_hash) || !Array.isArray(scope.authorized_paths) || scope.authorized_paths.length === 0
      || scope.authorized_paths.length > MAX_AUTHORIZED_PATHS) invalid();
  const projectId = scope.project_id.toLowerCase();
  const generationId = scope.generation_id.toLowerCase();
  const authorizationKeys = new Set<string>();
  const authorizedPaths = scope.authorized_paths.map((entry) => {
    if (typeof entry !== 'object' || entry === null || !UUID.test(entry.repository_id) || typeof entry.path_prefix !== 'string'
        || entry.path_prefix.length > 4_096 || entry.path_prefix.includes('\\') || entry.path_prefix.startsWith('/')
        || entry.path_prefix.split('/').some((part) => part === '..' || part === '.') || /[\r\n\0]/.test(entry.path_prefix)) invalid();
    const normalized = entry.path_prefix.replace(/\/+$/u, '').normalize('NFC');
    const item = { repository_id: entry.repository_id.toLowerCase(), path_prefix: normalized };
    const key = JSON.stringify(item);
    if (authorizationKeys.has(key)) invalid();
    authorizationKeys.add(key);
    return item;
  }).sort((left, right) => left.repository_id.localeCompare(right.repository_id, 'en') || left.path_prefix.localeCompare(right.path_prefix, 'en'));
  const authorizationJson = JSON.stringify(authorizedPaths);
  let embeddingProfile: RetrievalScope['embedding_profile'];
  if (scope.embedding_profile !== undefined) {
    if (typeof scope.embedding_profile !== 'object' || scope.embedding_profile === null
        || !PROVIDER.test(scope.embedding_profile.provider_id) || !MODEL.test(scope.embedding_profile.model)
        || !Number.isSafeInteger(scope.embedding_profile.dimensions) || scope.embedding_profile.dimensions < 1
        || scope.embedding_profile.dimensions > MAX_VECTOR_DIMENSIONS) invalid();
    embeddingProfile = Object.freeze({ ...scope.embedding_profile });
  }

  async function execute(signal: RetrievalSignal, statement: FixedSqlStatement, values: readonly (string | number)[]): Promise<readonly RetrievalCandidate[]> {
    try {
      const result = await database.execute<CandidateRow>(statement, values);
      if (typeof result !== 'object' || result === null || !Array.isArray(result.rows)) throw new RetrievalStoreError('result-invalid');
      return parseCandidates(signal, generationId, result.rows);
    } catch (error) {
      if (error instanceof RetrievalStoreError) throw error;
      throw new RetrievalStoreError('database-failed');
    }
  }

  return Object.freeze({
    exactSymbols(request: ExactSymbolRequest) {
      if (typeof request !== 'object' || request === null) invalid();
      const query = boundedString(request.query, MAX_EXACT_BYTES);
      return execute('exact', STATEMENTS.exactSymbols, [projectId, generationId, authorizationJson, query, limit(request.limit ?? 20)]);
    },
    ftsChunks(request: FtsChunkRequest) {
      if (typeof request !== 'object' || request === null) invalid();
      const query = boundedString(request.query, MAX_FTS_BYTES);
      return execute('fts', STATEMENTS.ftsChunks, [projectId, generationId, authorizationJson, query, limit(request.limit ?? 20)]);
    },
    vectorChunks(request: VectorChunkRequest) {
      if (embeddingProfile === undefined || typeof request !== 'object' || request === null
          || request.provider_id !== embeddingProfile.provider_id || request.model !== embeddingProfile.model
          || request.dimensions !== embeddingProfile.dimensions || !PROVIDER.test(request.provider_id) || !MODEL.test(request.model)
          || !Number.isSafeInteger(request.dimensions) || request.dimensions < 1 || request.dimensions > MAX_VECTOR_DIMENSIONS
          || !Array.isArray(request.embedding) || request.embedding.length !== request.dimensions
          || !request.embedding.every((value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_VECTOR_ABS_VALUE)) invalid();
      const embedding = JSON.stringify(request.embedding);
      if (Buffer.byteLength(embedding, 'utf8') > MAX_TEXT_BYTES) invalid();
      const statement = request.dimensions === 1536 ? STATEMENTS.vectorChunks1536 : STATEMENTS.vectorChunksGeneric;
      return execute('vector', statement, [projectId, generationId, authorizationJson, request.provider_id, request.model,
        request.dimensions, embedding, limit(request.limit ?? 20)]);
    },
    graphSignals(request: GraphSignalRequest) {
      if (typeof request !== 'object' || request === null) invalid();
      const anchorUsr = boundedString(request.anchor_usr, MAX_EXACT_BYTES);
      const direction = request.direction ?? 'both';
      if (direction !== 'incoming' && direction !== 'outgoing' && direction !== 'both') invalid();
      const edgeTypes = request.edge_types === undefined ? EDGE_TYPES : request.edge_types;
      if (!Array.isArray(edgeTypes) || edgeTypes.length < 1 || edgeTypes.length > EDGE_TYPES.length
          || new Set(edgeTypes).size !== edgeTypes.length || !edgeTypes.every((edgeType) => EDGE_TYPE_SET.has(edgeType))) invalid();
      const sortedEdgeTypes = [...edgeTypes].sort((left, right) => left.localeCompare(right, 'en'));
      return execute('graph', STATEMENTS.graphSignals, [projectId, generationId, authorizationJson, anchorUsr,
        JSON.stringify(sortedEdgeTypes), direction, limit(request.limit ?? 20)]);
    },
  });
}
