import { createHash } from 'node:crypto';
import type { EmbeddingCache, EmbeddingCacheKey, EmbeddingVector } from '../../../packages/provider-sdk/src/index.ts';
import type { FixedSqlResult, FixedSqlStatement } from './symbol-persistence.ts';

export interface EmbeddingPersistenceTransaction {
  execute<Row>(statement: FixedSqlStatement, values: readonly (string | number)[]): Promise<FixedSqlResult<Row>>;
}

export interface EmbeddingPersistenceDatabase {
  execute<Row>(statement: FixedSqlStatement, values: readonly (string | number)[]): Promise<FixedSqlResult<Row>>;
  transaction<Result>(operation: (transaction: EmbeddingPersistenceTransaction) => Promise<Result>): Promise<Result>;
}

export interface EmbeddingPersistenceRequest {
  generation_id: string;
  provider_id: string;
  model: string;
  dimensions: number;
  vectors: readonly EmbeddingVector[];
  batch_size?: number;
}

export interface EmbeddingPersistenceReport {
  generation_id: string;
  provider_id: string;
  model: string;
  dimensions: number;
  embedding_count: number;
  cached_input_count: number;
  already_persisted: boolean;
}

export type EmbeddingPersistenceErrorCode =
  | 'invalid-request'
  | 'generation-not-found'
  | 'generation-not-building'
  | 'chunks-not-imported'
  | 'chunk-mismatch'
  | 'dirty-generation'
  | 'write-mismatch'
  | 'transaction-failed';

export class EmbeddingPersistenceError extends Error {
  readonly code: EmbeddingPersistenceErrorCode;

  constructor(code: EmbeddingPersistenceErrorCode) {
    super(`embedding persistence ${code}`);
    this.name = 'EmbeddingPersistenceError';
    this.code = code;
  }
}

interface GenerationRow { status: string; chunks_imported_at: string | null }
interface ChunkRow { stable_key: string; content_hash: string; id: string }
interface ExistingRow { stable_key: string; content_hash: string; dimensions: string | number }
interface VectorRow { embedding: string }

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const MAX_VECTORS = 10_000_000;
const MAX_BATCH_SIZE = 1_000;
const MAX_BATCH_BYTES = 8 * 1024 * 1024;

const STATEMENTS = Object.freeze({
  readCache: Object.freeze({
    name: 'embedding-persistence-read-cache-v1',
    text: `SELECT embedding.embedding::text AS embedding FROM ue_mcp.chunk_embeddings embedding
      JOIN ue_mcp.code_chunks chunk ON chunk.id = embedding.chunk_id
      JOIN ue_mcp.index_generations generation ON generation.id = chunk.generation_id
      WHERE generation.project_id = $1::uuid AND embedding.provider = $2 AND embedding.model = $3
        AND embedding.dimensions = $4::integer AND embedding.content_hash = decode($5, 'hex')
      ORDER BY embedding.created_at, embedding.chunk_id LIMIT 1`,
  }),
  lockGeneration: Object.freeze({
    name: 'embedding-persistence-lock-generation-v1',
    text: `SELECT status, chunks_imported_at::text FROM ue_mcp.index_generations WHERE id = $1::uuid FOR UPDATE`,
  }),
  resolveChunks: Object.freeze({
    name: 'embedding-persistence-resolve-chunks-v1',
    text: `SELECT encode(chunk.stable_key, 'hex') AS stable_key, encode(chunk.content_hash, 'hex') AS content_hash,
        chunk.id::text AS id
      FROM ue_mcp.code_chunks chunk
      JOIN jsonb_to_recordset($2::jsonb) AS requested(stable_key text)
        ON chunk.stable_key = decode(requested.stable_key, 'hex')
      WHERE chunk.generation_id = $1::uuid ORDER BY chunk.stable_key`,
  }),
  loadExisting: Object.freeze({
    name: 'embedding-persistence-load-existing-v1',
    text: `SELECT encode(chunk.stable_key, 'hex') AS stable_key,
        encode(embedding.content_hash, 'hex') AS content_hash, embedding.dimensions
      FROM ue_mcp.chunk_embeddings embedding
      JOIN ue_mcp.code_chunks chunk ON chunk.id = embedding.chunk_id
      WHERE chunk.generation_id = $1::uuid AND embedding.provider = $2 AND embedding.model = $3
      ORDER BY chunk.stable_key`,
  }),
  insertEmbeddings: Object.freeze({
    name: 'embedding-persistence-insert-v1',
    text: `INSERT INTO ue_mcp.chunk_embeddings
      (chunk_id, provider, model, dimensions, embedding, content_hash)
      SELECT input.chunk_id, $2, $3, $4::integer, input.embedding::vector, decode(input.content_hash, 'hex')
      FROM jsonb_to_recordset($5::jsonb) AS input(chunk_id uuid, content_hash text, embedding text)
      JOIN ue_mcp.code_chunks chunk ON chunk.id = input.chunk_id AND chunk.generation_id = $1::uuid
      WHERE chunk.content_hash = decode(input.content_hash, 'hex')`,
  }),
});

function invalid(): never {
  throw new EmbeddingPersistenceError('invalid-request');
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid();
  return value as number;
}

function count(value: string | number): number {
  const result = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(result) || (result as number) < 0) throw new EmbeddingPersistenceError('transaction-failed');
  return result as number;
}

function parseVector(value: unknown): readonly number[] | undefined {
  if (typeof value !== 'string' || value.length > 16 * 1024 * 1024) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'number' && Number.isFinite(item)) ? Object.freeze(parsed) : undefined;
  } catch {
    return undefined;
  }
}

function validCacheKey(key: EmbeddingCacheKey): boolean {
  if (typeof key !== 'object' || key === null || !HASH.test(key.cache_key) || !UUID.test(key.project_id) || !IDENTIFIER.test(key.provider_id)
      || !MODEL.test(key.model) || !HASH.test(key.content_hash) || !Number.isSafeInteger(key.dimensions)
      || key.dimensions < 1 || key.dimensions > 16_000) return false;
  const expected = createHash('sha256').update(JSON.stringify({
    schema_version: 1,
    project_id: key.project_id,
    provider: key.provider_id,
    model: key.model,
    dimensions: key.dimensions,
    content_hash: key.content_hash,
  })).digest('hex');
  return key.cache_key === expected;
}

export function createPersistentEmbeddingCache(database: Pick<EmbeddingPersistenceDatabase, 'execute'>): EmbeddingCache {
  if (typeof database !== 'object' || database === null || typeof database.execute !== 'function') invalid();
  const memory = new Map<string, readonly number[]>();
  return Object.freeze({
    async get(key: EmbeddingCacheKey): Promise<readonly number[] | undefined> {
      if (!validCacheKey(key)) invalid();
      const existing = memory.get(key.cache_key);
      if (existing !== undefined) return existing;
      try {
        const result = await database.execute<VectorRow>(STATEMENTS.readCache, [key.project_id, key.provider_id, key.model, key.dimensions, key.content_hash]);
        if (result.rows.length === 0) return undefined;
        if (result.rows.length !== 1) throw new EmbeddingPersistenceError('transaction-failed');
        const vector = parseVector(result.rows[0].embedding);
        if (vector === undefined || vector.length !== key.dimensions) throw new EmbeddingPersistenceError('transaction-failed');
        memory.set(key.cache_key, vector);
        return vector;
      } catch (error) {
        if (error instanceof EmbeddingPersistenceError) throw error;
        throw new EmbeddingPersistenceError('transaction-failed');
      }
    },
    async set(key: EmbeddingCacheKey, embedding: readonly number[]): Promise<void> {
      if (!validCacheKey(key) || !Array.isArray(embedding)
          || embedding.length !== key.dimensions || !embedding.every((item) => typeof item === 'number' && Number.isFinite(item))) invalid();
      memory.set(key.cache_key, Object.freeze([...embedding]));
    },
  });
}

function batches<Row>(rows: readonly Row[], batchSize: number): readonly string[] {
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

export async function persistChunkEmbeddings(
  database: Pick<EmbeddingPersistenceDatabase, 'transaction'>,
  request: EmbeddingPersistenceRequest,
): Promise<EmbeddingPersistenceReport> {
  if (typeof database !== 'object' || database === null || typeof database.transaction !== 'function'
      || typeof request !== 'object' || request === null || !UUID.test(request.generation_id)
      || !IDENTIFIER.test(request.provider_id) || !MODEL.test(request.model) || !Array.isArray(request.vectors)
      || request.vectors.length > MAX_VECTORS) invalid();
  const dimensions = integer(request.dimensions, 1, 16_000);
  const batchSize = integer(request.batch_size ?? 500, 1, MAX_BATCH_SIZE);
  const keys = new Set<string>();
  const vectors = request.vectors.map((item) => {
    if (typeof item !== 'object' || item === null || !HASH.test(item.chunk_key) || keys.has(item.chunk_key)
        || !HASH.test(item.content_hash) || !Array.isArray(item.embedding) || item.embedding.length !== dimensions
        || !item.embedding.every((value) => typeof value === 'number' && Number.isFinite(value)) || typeof item.cached !== 'boolean') invalid();
    keys.add(item.chunk_key);
    return Object.freeze({ stable_key: item.chunk_key, content_hash: item.content_hash, embedding: JSON.stringify(item.embedding), cached: item.cached });
  }).sort((left, right) => left.stable_key.localeCompare(right.stable_key, 'en'));
  const resultReport = (alreadyPersisted: boolean): EmbeddingPersistenceReport => Object.freeze({
    generation_id: request.generation_id, provider_id: request.provider_id, model: request.model, dimensions,
    embedding_count: vectors.length, cached_input_count: vectors.filter(({ cached }) => cached).length, already_persisted: alreadyPersisted,
  });
  try {
    return await database.transaction(async (transaction) => {
      const generation = await transaction.execute<GenerationRow>(STATEMENTS.lockGeneration, [request.generation_id]);
      if (generation.rows.length !== 1) throw new EmbeddingPersistenceError('generation-not-found');
      if (generation.rows[0].status !== 'building') throw new EmbeddingPersistenceError('generation-not-building');
      if (generation.rows[0].chunks_imported_at === null) throw new EmbeddingPersistenceError('chunks-not-imported');
      const resolved = new Map<string, ChunkRow>();
      for (const batch of batches(vectors.map(({ stable_key }) => ({ stable_key })), batchSize)) {
        const query = await transaction.execute<ChunkRow>(STATEMENTS.resolveChunks, [request.generation_id, batch]);
        for (const row of query.rows) {
          if (!HASH.test(row.stable_key) || !HASH.test(row.content_hash) || !UUID.test(row.id) || resolved.has(row.stable_key)) {
            throw new EmbeddingPersistenceError('chunk-mismatch');
          }
          resolved.set(row.stable_key, row);
        }
      }
      if (resolved.size !== vectors.length || vectors.some((item) => resolved.get(item.stable_key)?.content_hash !== item.content_hash)) {
        throw new EmbeddingPersistenceError('chunk-mismatch');
      }
      const existing = await transaction.execute<ExistingRow>(STATEMENTS.loadExisting, [request.generation_id, request.provider_id, request.model]);
      if (existing.rows.length > 0) {
        const existingByKey = new Map<string, ExistingRow>();
        for (const row of existing.rows) {
          if (!HASH.test(row.stable_key) || !HASH.test(row.content_hash) || count(row.dimensions) !== dimensions || existingByKey.has(row.stable_key)) {
            throw new EmbeddingPersistenceError('dirty-generation');
          }
          existingByKey.set(row.stable_key, row);
        }
        if (existingByKey.size === vectors.length
            && vectors.every((item) => existingByKey.get(item.stable_key)?.content_hash === item.content_hash)) return resultReport(true);
        throw new EmbeddingPersistenceError('dirty-generation');
      }
      const rows = vectors.map((item) => ({ chunk_id: resolved.get(item.stable_key)!.id, content_hash: item.content_hash, embedding: item.embedding }));
      let writes = 0;
      for (const batch of batches(rows, batchSize)) {
        writes += (await transaction.execute(STATEMENTS.insertEmbeddings, [request.generation_id, request.provider_id, request.model, dimensions, batch])).row_count;
      }
      if (writes !== vectors.length) throw new EmbeddingPersistenceError('write-mismatch');
      return resultReport(false);
    });
  } catch (error) {
    if (error instanceof EmbeddingPersistenceError) throw error;
    throw new EmbeddingPersistenceError('transaction-failed');
  }
}
