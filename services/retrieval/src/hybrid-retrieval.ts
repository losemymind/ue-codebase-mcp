import type { ProviderConfig } from '../../../packages/config/src/index.ts';
import {
  rankHybridCandidates,
  type HybridCandidate,
  type HybridRankedCandidate,
  type HybridRankingOptions,
  type HybridSource,
} from './hybrid-ranking.ts';
import {
  applyRerankScores,
  requestRerankScores,
  type ApplyRerankOptions,
  type RerankExecutor,
  type RerankPolicy,
  type RerankedCandidate,
} from './rerank.ts';
import { RetrievalStoreError, type RetrievalCandidate, type RetrievalStore, type VectorChunkRequest } from './retrieval-store.ts';

export interface HybridRetrievalRequest {
  query: string;
  limit?: number;
  candidate_limit?: number;
  max_output_utf8_bytes?: number;
  query_vector?: Omit<VectorChunkRequest, 'limit'>;
  graph_anchor_usr?: string;
}

export interface HybridRetrievalRerank {
  provider: ProviderConfig;
  project_id: string;
  execute: RerankExecutor;
  policy?: RerankPolicy;
  options?: ApplyRerankOptions;
}

export interface HybridRetrievalOptions {
  ranking?: Omit<HybridRankingOptions, 'limit'>;
  rerank?: HybridRetrievalRerank;
}

export interface HybridRetrievalHit {
  rank: number;
  chunk_key: string;
  symbol_key: string | null;
  file_key: string;
  file_path: string;
  chunk_kind: string;
  text: string;
  fusion_score: number;
  evidence: HybridRankedCandidate['evidence'];
  rerank_score: number | null;
}

export interface HybridRetrievalReport {
  hits: readonly HybridRetrievalHit[];
  requested_signals: readonly HybridSource[];
  degraded_signals: readonly (HybridSource | 'rerank')[];
  rerank_applied: boolean;
}

export type HybridRetrievalErrorCode = 'invalid-request' | 'mandatory-signal-failed' | 'candidate-conflict';

export class HybridRetrievalError extends Error {
  readonly code: HybridRetrievalErrorCode;

  constructor(code: HybridRetrievalErrorCode) {
    super(`hybrid retrieval ${code}`);
    this.name = 'HybridRetrievalError';
    this.code = code;
  }
}

const MAX_QUERY_BYTES = 4_096;
const MAX_LIMIT = 100;
const MAX_CANDIDATES = 100;
const MIN_OUTPUT_BYTES = 1_024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new HybridRetrievalError('invalid-request');
  return value as number;
}

function query(value: unknown): string {
  if (typeof value !== 'string') throw new HybridRetrievalError('invalid-request');
  const normalized = value.trim().normalize('NFC');
  if (normalized.length === 0 || normalized.includes('\0') || Buffer.byteLength(normalized, 'utf8') > MAX_QUERY_BYTES) {
    throw new HybridRetrievalError('invalid-request');
  }
  return normalized;
}

function candidateIdentity(candidate: RetrievalCandidate): { rankable: HybridCandidate; candidate: RetrievalCandidate } {
  if (candidate.candidate_type !== 'chunk' || candidate.chunk_key === null || candidate.file_id === null
      || candidate.file_path === null || candidate.chunk_kind === null || candidate.text === null) {
    throw new HybridRetrievalError('candidate-conflict');
  }
  return {
    rankable: {
      chunk_key: candidate.chunk_key,
      symbol_key: candidate.stable_usr,
      file_key: candidate.file_id,
      score: Math.max(0, candidate.raw_score),
    },
    candidate,
  };
}

export async function retrieveHybrid(
  store: RetrievalStore,
  request: HybridRetrievalRequest,
  options: HybridRetrievalOptions = {},
): Promise<HybridRetrievalReport> {
  if (typeof store !== 'object' || store === null || typeof store.exactSymbols !== 'function' || typeof store.ftsChunks !== 'function'
      || typeof store.vectorChunks !== 'function' || typeof store.graphSignals !== 'function' || typeof request !== 'object'
      || request === null || typeof options !== 'object' || options === null) throw new HybridRetrievalError('invalid-request');
  const normalizedQuery = query(request.query);
  const limit = integer(request.limit ?? 20, 1, MAX_LIMIT);
  const candidateLimit = integer(request.candidate_limit ?? Math.max(limit, 50), limit, MAX_CANDIDATES);
  const outputBudget = integer(request.max_output_utf8_bytes ?? 1024 * 1024, MIN_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
  if (request.graph_anchor_usr !== undefined && (typeof request.graph_anchor_usr !== 'string' || request.graph_anchor_usr.length === 0)) {
    throw new HybridRetrievalError('invalid-request');
  }
  const requested: HybridSource[] = ['exact', 'fts'];
  if (request.query_vector !== undefined) requested.push('vector');
  if (request.graph_anchor_usr !== undefined) requested.push('graph');
  let mandatory: readonly [readonly RetrievalCandidate[], readonly RetrievalCandidate[]];
  try {
    mandatory = await Promise.all([
      store.exactSymbols({ query: normalizedQuery, limit: candidateLimit }),
      store.ftsChunks({ query: normalizedQuery, limit: candidateLimit }),
    ]);
  } catch {
    throw new HybridRetrievalError('mandatory-signal-failed');
  }
  const sets: Partial<Record<HybridSource, readonly RetrievalCandidate[]>> = { exact: mandatory[0], fts: mandatory[1] };
  const degraded: Array<HybridSource | 'rerank'> = [];
  const optional = async (signal: 'vector' | 'graph', operation: () => Promise<readonly RetrievalCandidate[]>): Promise<void> => {
    try {
      sets[signal] = await operation();
    } catch (error) {
      if (error instanceof RetrievalStoreError && error.code === 'scope-not-active') throw new HybridRetrievalError('mandatory-signal-failed');
      degraded.push(signal);
      sets[signal] = [];
    }
  };
  const optionalTasks: Promise<void>[] = [];
  if (request.query_vector !== undefined) optionalTasks.push(optional('vector', () => store.vectorChunks({ ...request.query_vector!, limit: candidateLimit })));
  if (request.graph_anchor_usr !== undefined) optionalTasks.push(optional('graph', () => store.graphSignals({ anchor_usr: request.graph_anchor_usr!, limit: candidateLimit })));
  await Promise.all(optionalTasks);

  const metadata = new Map<string, RetrievalCandidate>();
  const rankingSets: Partial<Record<HybridSource, readonly HybridCandidate[]>> = {};
  for (const signal of requested) {
    rankingSets[signal] = (sets[signal] ?? []).map((item) => {
      const value = candidateIdentity(item);
      const existing = metadata.get(value.rankable.chunk_key);
      if (existing !== undefined && (existing.file_id !== item.file_id || existing.stable_usr !== item.stable_usr
          || existing.file_path !== item.file_path || existing.text !== item.text || existing.chunk_kind !== item.chunk_kind)) {
        throw new HybridRetrievalError('candidate-conflict');
      }
      metadata.set(value.rankable.chunk_key, item);
      return value.rankable;
    });
  }
  const rankingLimit = options.rerank === undefined ? limit : Math.min(candidateLimit, MAX_CANDIDATES);
  const hybrid = rankHybridCandidates(rankingSets, { ...(options.ranking ?? {}), limit: rankingLimit });
  let finalRanking: readonly (HybridRankedCandidate | RerankedCandidate)[] = hybrid;
  let rerankApplied = false;
  if (options.rerank !== undefined && hybrid.length > 0) {
    try {
      const report = await requestRerankScores(
        options.rerank.provider,
        options.rerank.project_id,
        normalizedQuery,
        hybrid.map(({ chunk_key }) => ({ chunk_key, text: metadata.get(chunk_key)!.text! })),
        options.rerank.execute,
        options.rerank.policy,
      );
      finalRanking = applyRerankScores(hybrid, report.scores, options.rerank.options);
      rerankApplied = true;
    } catch {
      degraded.push('rerank');
    }
  }
  const hits: HybridRetrievalHit[] = [];
  let outputBytes = 0;
  for (const ranked of finalRanking) {
    const item = metadata.get(ranked.chunk_key);
    if (item === undefined || item.file_path === null || item.chunk_kind === null || item.text === null) {
      throw new HybridRetrievalError('candidate-conflict');
    }
    const itemBytes = Buffer.byteLength(item.text, 'utf8');
    if (outputBytes + itemBytes > outputBudget) continue;
    outputBytes += itemBytes;
    hits.push(Object.freeze({
      rank: hits.length + 1,
      chunk_key: ranked.chunk_key,
      symbol_key: ranked.symbol_key,
      file_key: ranked.file_key,
      file_path: item.file_path,
      chunk_kind: item.chunk_kind,
      text: item.text,
      fusion_score: ranked.fusion_score,
      evidence: ranked.evidence,
      rerank_score: 'rerank_score' in ranked ? ranked.rerank_score : null,
    }));
    if (hits.length === limit) break;
  }
  return Object.freeze({
    hits: Object.freeze(hits),
    requested_signals: Object.freeze(requested),
    degraded_signals: Object.freeze(degraded),
    rerank_applied: rerankApplied,
  });
}
