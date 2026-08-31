import { createHash } from 'node:crypto';
import type { ProviderConfig } from '../../../packages/config/src/index.ts';
import type { HybridRankedCandidate } from './hybrid-ranking.ts';

export interface RerankInput {
  chunk_key: string;
  text: string;
}

export interface RerankRequest {
  provider_id: string;
  model: string;
  idempotency_key: string;
  query: string;
  inputs: readonly RerankInput[];
}

export interface RerankResponse {
  scores: readonly { chunk_key: string; score: number }[];
}

export type RerankExecutor = (request: RerankRequest) => Promise<RerankResponse>;

export interface RerankPolicy {
  max_attempts?: number;
  retry_delay?: (attempt: number) => Promise<void>;
  is_transient_error?: (error: unknown) => boolean;
}

export interface RerankReport {
  provider_id: string;
  model: string;
  scores: readonly { chunk_key: string; score: number }[];
  attempt_count: number;
}

export interface RerankedCandidate extends HybridRankedCandidate {
  pre_rerank_rank: number;
  rerank_score: number;
  rerank_fusion_score: number;
}

export interface ApplyRerankOptions {
  rerank_weight?: number;
  preserve_top_exact?: boolean;
}

export type RerankErrorCode =
  | 'invalid-input'
  | 'provider-disabled'
  | 'provider-approval-required'
  | 'rerank-not-configured'
  | 'provider-failed'
  | 'invalid-provider-response';

export class RerankError extends Error {
  readonly code: RerankErrorCode;

  constructor(code: RerankErrorCode) {
    super(`rerank ${code}`);
    this.name = 'RerankError';
    this.code = code;
  }
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_INPUTS = 100;
const MAX_QUERY_BYTES = 16 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new RerankError('invalid-input');
  return value as number;
}

function validateInputs(query: string, inputs: readonly RerankInput[]): readonly RerankInput[] {
  if (typeof query !== 'string' || query.trim().length === 0 || query.includes('\0')
      || Buffer.byteLength(query, 'utf8') > MAX_QUERY_BYTES || !Array.isArray(inputs)
      || inputs.length === 0 || inputs.length > MAX_INPUTS) throw new RerankError('invalid-input');
  let bytes = Buffer.byteLength(query, 'utf8');
  const keys = new Set<string>();
  const validated = inputs.map((input) => {
    if (typeof input !== 'object' || input === null || !HASH.test(input.chunk_key) || keys.has(input.chunk_key)
        || typeof input.text !== 'string' || input.text.length === 0 || input.text.includes('\0')
        || Buffer.byteLength(input.text, 'utf8') > MAX_TEXT_BYTES) throw new RerankError('invalid-input');
    keys.add(input.chunk_key);
    bytes += Buffer.byteLength(input.text, 'utf8');
    return Object.freeze({ chunk_key: input.chunk_key, text: input.text });
  });
  if (bytes > MAX_REQUEST_BYTES) throw new RerankError('invalid-input');
  return Object.freeze(validated);
}

function idempotencyKey(provider: ProviderConfig, projectId: string, query: string, inputs: readonly RerankInput[]): string {
  return sha256(JSON.stringify({
    schema_version: 1,
    project_id: projectId,
    provider: provider.id,
    model: provider.rerank!.model,
    query_hash: sha256(query),
    inputs: inputs.map((input) => ({ chunk_key: input.chunk_key, content_hash: sha256(input.text) })),
  }));
}

export async function requestRerankScores(
  provider: ProviderConfig,
  projectId: string,
  query: string,
  inputs: readonly RerankInput[],
  execute: RerankExecutor,
  policy: RerankPolicy = {},
): Promise<RerankReport> {
  if (typeof provider !== 'object' || provider === null || typeof execute !== 'function' || !UUID.test(projectId)) throw new RerankError('invalid-input');
  if (!provider.enabled) throw new RerankError('provider-disabled');
  if (!provider.data_processing_approved) throw new RerankError('provider-approval-required');
  if (provider.rerank === undefined) throw new RerankError('rerank-not-configured');
  const validated = validateInputs(query, inputs);
  const maxAttempts = integer(policy.max_attempts ?? 2, 1, 5);
  const transient = policy.is_transient_error ?? (() => false);
  const retryDelay = policy.retry_delay ?? (async () => undefined);
  const key = idempotencyKey(provider, projectId, query, validated);
  let response: RerankResponse | undefined;
  let attemptCount = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptCount += 1;
    try {
      response = await execute(Object.freeze({
        provider_id: provider.id,
        model: provider.rerank.model,
        idempotency_key: key,
        query,
        inputs: validated,
      }));
      break;
    } catch (error) {
      let retryable = false;
      try { retryable = transient(error); } catch { throw new RerankError('provider-failed'); }
      if (!retryable || attempt === maxAttempts) throw new RerankError('provider-failed');
      try { await retryDelay(attempt); } catch { throw new RerankError('provider-failed'); }
    }
  }
  if (response === undefined || !Array.isArray(response.scores) || response.scores.length !== validated.length) {
    throw new RerankError('invalid-provider-response');
  }
  const expected = new Set(validated.map(({ chunk_key }) => chunk_key));
  const scores = response.scores.map((item) => {
    if (typeof item !== 'object' || item === null || !expected.delete(item.chunk_key)
        || typeof item.score !== 'number' || !Number.isFinite(item.score) || item.score < 0 || item.score > 1) {
      throw new RerankError('invalid-provider-response');
    }
    return Object.freeze({ chunk_key: item.chunk_key, score: item.score });
  });
  if (expected.size !== 0) throw new RerankError('invalid-provider-response');
  return Object.freeze({
    provider_id: provider.id,
    model: provider.rerank.model,
    scores: Object.freeze(scores),
    attempt_count: attemptCount,
  });
}

export function applyRerankScores(
  candidates: readonly HybridRankedCandidate[],
  scores: readonly { chunk_key: string; score: number }[],
  options: ApplyRerankOptions = {},
): readonly RerankedCandidate[] {
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > MAX_INPUTS || !Array.isArray(scores)
      || scores.length !== candidates.length || typeof options !== 'object' || options === null) throw new RerankError('invalid-input');
  const allowed = new Set(['rerank_weight', 'preserve_top_exact']);
  if (Object.keys(options).some((key) => !allowed.has(key))) throw new RerankError('invalid-input');
  const weight = options.rerank_weight ?? 0.7;
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 1
      || (options.preserve_top_exact !== undefined && typeof options.preserve_top_exact !== 'boolean')) throw new RerankError('invalid-input');
  const candidateByKey = new Map<string, HybridRankedCandidate>();
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null || !HASH.test(candidate.chunk_key) || candidateByKey.has(candidate.chunk_key)
        || !Number.isSafeInteger(candidate.rank) || candidate.rank < 1 || !Array.isArray(candidate.evidence)) throw new RerankError('invalid-input');
    candidateByKey.set(candidate.chunk_key, candidate);
  }
  const scoreByKey = new Map<string, number>();
  for (const item of scores) {
    if (typeof item !== 'object' || item === null || !candidateByKey.has(item.chunk_key) || scoreByKey.has(item.chunk_key)
        || typeof item.score !== 'number' || !Number.isFinite(item.score) || item.score < 0 || item.score > 1) throw new RerankError('invalid-input');
    scoreByKey.set(item.chunk_key, item.score);
  }
  if (scoreByKey.size !== candidateByKey.size) throw new RerankError('invalid-input');
  const rerankRanks = [...scoreByKey].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'en'));
  const rerankRankByKey = new Map(rerankRanks.map(([key], index) => [key, index + 1]));
  const topExact = options.preserve_top_exact === false ? undefined : candidates.find(({ evidence }) =>
    evidence.some(({ source, source_rank }) => source === 'exact' && source_rank === 1))?.chunk_key;
  return Object.freeze(candidates.map((candidate): RerankedCandidate => Object.freeze({
    ...candidate,
    pre_rerank_rank: candidate.rank,
    rerank_score: scoreByKey.get(candidate.chunk_key)!,
    rerank_fusion_score: (1 - weight) / candidate.rank + weight / rerankRankByKey.get(candidate.chunk_key)!,
  })).sort((left, right) =>
    (left.chunk_key === topExact ? -1 : right.chunk_key === topExact ? 1 : 0)
    || right.rerank_fusion_score - left.rerank_fusion_score || left.chunk_key.localeCompare(right.chunk_key, 'en'))
    .map((candidate, index) => Object.freeze({ ...candidate, rank: index + 1 })));
}
