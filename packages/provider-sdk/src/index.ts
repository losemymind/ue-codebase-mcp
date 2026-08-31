import { createHash } from 'node:crypto';
import type { ProviderConfig } from '../../config/src/index.ts';

export interface EmbeddingInput {
  chunk_key: string;
  content_hash: string;
  text: string;
  token_count: number;
}

export interface EmbeddingVector {
  chunk_key: string;
  content_hash: string;
  embedding: readonly number[];
  cached: boolean;
}

export interface EmbeddingCacheKey {
  cache_key: string;
  project_id: string;
  provider_id: string;
  model: string;
  dimensions: number;
  content_hash: string;
}

export interface EmbeddingCache {
  get(key: EmbeddingCacheKey): Promise<readonly number[] | undefined>;
  set(key: EmbeddingCacheKey, embedding: readonly number[]): Promise<void>;
}

export interface EmbeddingBatchRequest {
  provider_id: string;
  model: string;
  dimensions: number;
  idempotency_key: string;
  inputs: readonly { content_hash: string; text: string }[];
}

export interface EmbeddingBatchResponse {
  embeddings: readonly { content_hash: string; embedding: readonly number[] }[];
}

export type EmbeddingBatchExecutor = (request: EmbeddingBatchRequest) => Promise<EmbeddingBatchResponse>;

export interface EmbeddingPipelinePolicy {
  max_batch_items?: number;
  max_batch_utf8_bytes?: number;
  max_batch_tokens?: number;
  max_attempts?: number;
  circuit_breaker_failures?: number;
  retry_delay?: (attempt: number) => Promise<void>;
  is_transient_error?: (error: unknown) => boolean;
}

export interface EmbeddingPipelineReport {
  vectors: readonly EmbeddingVector[];
  unique_content_count: number;
  cache_hit_count: number;
  provider_input_count: number;
  provider_batch_count: number;
  provider_attempt_count: number;
}

export type EmbeddingPipelineErrorCode =
  | 'invalid-input'
  | 'provider-disabled'
  | 'provider-approval-required'
  | 'cache-failed'
  | 'invalid-provider-response'
  | 'provider-failed'
  | 'circuit-open';

export class EmbeddingPipelineError extends Error {
  readonly code: EmbeddingPipelineErrorCode;

  constructor(code: EmbeddingPipelineErrorCode) {
    super(`embedding pipeline ${code}`);
    this.name = 'EmbeddingPipelineError';
    this.code = code;
  }
}

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_INPUTS = 10_000_000;
const MAX_TEXT_BYTES = 256 * 1024;
const DEFAULT_BATCH_ITEMS = 64;
const DEFAULT_BATCH_BYTES = 1024 * 1024;
const DEFAULT_BATCH_TOKENS = 32_768;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new EmbeddingPipelineError('invalid-input');
  }
  return value as number;
}

function validVector(value: unknown, dimensions: number): value is readonly number[] {
  return Array.isArray(value) && value.length === dimensions && value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

function cacheKey(provider: ProviderConfig, projectId: string, contentHash: string): EmbeddingCacheKey {
  const identity = {
    schema_version: 1,
    project_id: projectId,
    provider: provider.id,
    model: provider.embedding.model,
    dimensions: provider.embedding.dimensions,
    content_hash: contentHash,
  };
  return Object.freeze({
    cache_key: sha256(JSON.stringify(identity)),
    project_id: projectId,
    provider_id: provider.id,
    model: provider.embedding.model,
    dimensions: provider.embedding.dimensions,
    content_hash: contentHash,
  });
}

interface UniqueInput {
  content_hash: string;
  text: string;
  token_count: number;
}

function validateInputs(inputs: readonly EmbeddingInput[]): { unique: readonly UniqueInput[]; byHash: ReadonlyMap<string, UniqueInput> } {
  if (!Array.isArray(inputs) || inputs.length > MAX_INPUTS) throw new EmbeddingPipelineError('invalid-input');
  const chunkKeys = new Set<string>();
  const byHash = new Map<string, UniqueInput>();
  for (const input of inputs) {
    if (typeof input !== 'object' || input === null || typeof input.chunk_key !== 'string' || input.chunk_key.length === 0
        || chunkKeys.has(input.chunk_key) || typeof input.text !== 'string' || input.text.length === 0 || input.text.includes('\0')
        || Buffer.byteLength(input.text, 'utf8') > MAX_TEXT_BYTES || !HASH.test(input.content_hash)
        || sha256(input.text) !== input.content_hash || !Number.isSafeInteger(input.token_count) || input.token_count < 1) {
      throw new EmbeddingPipelineError('invalid-input');
    }
    chunkKeys.add(input.chunk_key);
    const existing = byHash.get(input.content_hash);
    if (existing !== undefined && (existing.text !== input.text || existing.token_count !== input.token_count)) {
      throw new EmbeddingPipelineError('invalid-input');
    }
    byHash.set(input.content_hash, { content_hash: input.content_hash, text: input.text, token_count: input.token_count });
  }
  return { unique: Object.freeze([...byHash.values()].sort((left, right) => left.content_hash.localeCompare(right.content_hash, 'en'))), byHash };
}

function batches(inputs: readonly UniqueInput[], maxItems: number, maxBytes: number, maxTokens: number): readonly (readonly UniqueInput[])[] {
  const result: UniqueInput[][] = [];
  let batch: UniqueInput[] = [];
  let bytes = 0;
  let tokens = 0;
  for (const input of inputs) {
    const inputBytes = Buffer.byteLength(input.text, 'utf8');
    if (inputBytes > maxBytes || input.token_count > maxTokens) throw new EmbeddingPipelineError('invalid-input');
    if (batch.length > 0 && (batch.length === maxItems || bytes + inputBytes > maxBytes || tokens + input.token_count > maxTokens)) {
      result.push(batch);
      batch = [];
      bytes = 0;
      tokens = 0;
    }
    batch.push(input);
    bytes += inputBytes;
    tokens += input.token_count;
  }
  if (batch.length > 0) result.push(batch);
  return Object.freeze(result.map((value) => Object.freeze(value)));
}

function requestId(provider: ProviderConfig, projectId: string, inputs: readonly UniqueInput[]): string {
  return sha256(JSON.stringify({
    schema_version: 1,
    project_id: projectId,
    provider: provider.id,
    model: provider.embedding.model,
    dimensions: provider.embedding.dimensions,
    content_hashes: inputs.map((input) => input.content_hash),
  }));
}

export async function embedCodeChunks(
  provider: ProviderConfig,
  projectId: string,
  inputs: readonly EmbeddingInput[],
  cache: EmbeddingCache,
  execute: EmbeddingBatchExecutor,
  policy: EmbeddingPipelinePolicy = {},
): Promise<EmbeddingPipelineReport> {
  if (typeof provider !== 'object' || provider === null || typeof cache?.get !== 'function' || typeof cache?.set !== 'function' || typeof execute !== 'function') {
    throw new EmbeddingPipelineError('invalid-input');
  }
  if (!provider.enabled) throw new EmbeddingPipelineError('provider-disabled');
  if (!provider.data_processing_approved) throw new EmbeddingPipelineError('provider-approval-required');
  if (!UUID.test(projectId)) throw new EmbeddingPipelineError('invalid-input');
  const dimensions = integer(provider.embedding?.dimensions, 1, 16_000);
  if (typeof provider.id !== 'string' || provider.id.length === 0 || typeof provider.embedding.model !== 'string' || provider.embedding.model.length === 0) {
    throw new EmbeddingPipelineError('invalid-input');
  }
  const maxItems = integer(policy.max_batch_items ?? DEFAULT_BATCH_ITEMS, 1, 2_048);
  const maxBytes = integer(policy.max_batch_utf8_bytes ?? DEFAULT_BATCH_BYTES, 1, 16 * 1024 * 1024);
  const maxTokens = integer(policy.max_batch_tokens ?? DEFAULT_BATCH_TOKENS, 1, 1_000_000);
  const maxAttempts = integer(policy.max_attempts ?? 3, 1, 10);
  const circuitFailures = integer(policy.circuit_breaker_failures ?? 3, 1, 100);
  const validated = validateInputs(inputs);
  const vectorsByHash = new Map<string, { embedding: readonly number[]; cached: boolean }>();
  let cacheHits = 0;
  for (const input of validated.unique) {
    let cached: readonly number[] | undefined;
    try {
      cached = await cache.get(cacheKey(provider, projectId, input.content_hash));
    } catch {
      throw new EmbeddingPipelineError('cache-failed');
    }
    if (cached === undefined) continue;
    if (!validVector(cached, dimensions)) throw new EmbeddingPipelineError('invalid-provider-response');
    vectorsByHash.set(input.content_hash, { embedding: Object.freeze([...cached]), cached: true });
    cacheHits += 1;
  }

  const pending = validated.unique.filter((input) => !vectorsByHash.has(input.content_hash));
  let batchCount = 0;
  let attemptCount = 0;
  let consecutiveFailures = 0;
  const retryDelay = policy.retry_delay ?? (async () => undefined);
  const transient = policy.is_transient_error ?? (() => false);
  for (const batch of batches(pending, maxItems, maxBytes, maxTokens)) {
    if (consecutiveFailures >= circuitFailures) throw new EmbeddingPipelineError('circuit-open');
    batchCount += 1;
    const idempotencyKey = requestId(provider, projectId, batch);
    let response: EmbeddingBatchResponse | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attemptCount += 1;
      try {
        response = await execute(Object.freeze({
          provider_id: provider.id,
          model: provider.embedding.model,
          dimensions,
          idempotency_key: idempotencyKey,
          inputs: Object.freeze(batch.map((input) => Object.freeze({ content_hash: input.content_hash, text: input.text }))),
        }));
        consecutiveFailures = 0;
        break;
      } catch (error) {
        consecutiveFailures += 1;
        let retryable = false;
        try { retryable = transient(error); } catch { throw new EmbeddingPipelineError('provider-failed'); }
        if (!retryable || attempt === maxAttempts) throw new EmbeddingPipelineError('provider-failed');
        if (consecutiveFailures >= circuitFailures) throw new EmbeddingPipelineError('circuit-open');
        try { await retryDelay(attempt); } catch { throw new EmbeddingPipelineError('provider-failed'); }
      }
    }
    if (response === undefined || !Array.isArray(response.embeddings) || response.embeddings.length !== batch.length) {
      throw new EmbeddingPipelineError('invalid-provider-response');
    }
    const expected = new Set(batch.map((input) => input.content_hash));
    for (const item of response.embeddings) {
      if (typeof item !== 'object' || item === null || !expected.delete(item.content_hash) || !validVector(item.embedding, dimensions)) {
        throw new EmbeddingPipelineError('invalid-provider-response');
      }
      const embedding = Object.freeze([...item.embedding]);
      vectorsByHash.set(item.content_hash, { embedding, cached: false });
      try {
        await cache.set(cacheKey(provider, projectId, item.content_hash), embedding);
      } catch {
        throw new EmbeddingPipelineError('cache-failed');
      }
    }
    if (expected.size !== 0) throw new EmbeddingPipelineError('invalid-provider-response');
  }

  const vectors = inputs.map((input): EmbeddingVector => {
    const value = vectorsByHash.get(input.content_hash);
    if (value === undefined) throw new EmbeddingPipelineError('invalid-provider-response');
    return Object.freeze({ chunk_key: input.chunk_key, content_hash: input.content_hash, embedding: value.embedding, cached: value.cached });
  });
  return Object.freeze({
    vectors: Object.freeze(vectors),
    unique_content_count: validated.byHash.size,
    cache_hit_count: cacheHits,
    provider_input_count: pending.length,
    provider_batch_count: batchCount,
    provider_attempt_count: attemptCount,
  });
}
