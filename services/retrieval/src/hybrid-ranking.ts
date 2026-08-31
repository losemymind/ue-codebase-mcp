export const HYBRID_SOURCES = ['exact', 'fts', 'vector', 'graph'] as const;

export type HybridSource = (typeof HYBRID_SOURCES)[number];

export interface HybridCandidate {
  chunk_key: string;
  symbol_key?: string | null;
  file_key: string;
  score: number;
}

export type HybridCandidateSets = Partial<Record<HybridSource, readonly HybridCandidate[]>>;

export interface HybridRankingOptions {
  weights?: Partial<Record<HybridSource, number>>;
  rrf_k?: number;
  limit?: number;
  max_per_symbol?: number;
  max_per_file?: number;
  preserve_top_exact?: boolean;
}

export interface HybridEvidence {
  source: HybridSource;
  source_rank: number;
  source_score: number;
  weighted_rrf_score: number;
}

export interface HybridRankedCandidate {
  rank: number;
  chunk_key: string;
  symbol_key: string | null;
  file_key: string;
  fusion_score: number;
  evidence: readonly HybridEvidence[];
}

export type HybridRankingErrorCode = 'invalid-input' | 'invalid-options';

export class HybridRankingError extends Error {
  readonly code: HybridRankingErrorCode;

  constructor(code: HybridRankingErrorCode, message: string) {
    super(message);
    this.name = 'HybridRankingError';
    this.code = code;
  }
}

const DEFAULT_WEIGHTS: Readonly<Record<HybridSource, number>> = Object.freeze({
  exact: 1,
  fts: 0.8,
  vector: 0.7,
  graph: 0.5,
});
const MAX_CANDIDATES_PER_SOURCE = 10_000;
const MAX_LIMIT = 1_000;
const MAX_RRF_K = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeString(value: unknown, field: string, allowNull = false): string | null {
  if (allowNull && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) {
    throw new HybridRankingError('invalid-input', `${field} must be a non-empty bounded string`);
  }
  return value;
}

function boundedNumber(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new HybridRankingError('invalid-options', `${field} is outside its permitted range`);
  }
  return value;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  const number = boundedNumber(value, field, minimum, maximum);
  if (!Number.isInteger(number)) {
    throw new HybridRankingError('invalid-options', `${field} must be an integer`);
  }
  return number;
}

function validateCandidate(value: unknown, source: HybridSource, index: number): HybridCandidate {
  const field = `${source}[${index}]`;
  if (!isRecord(value)) {
    throw new HybridRankingError('invalid-input', `${field} must be an object`);
  }
  const chunkKey = safeString(value.chunk_key, `${field}.chunk_key`) as string;
  const fileKey = safeString(value.file_key, `${field}.file_key`) as string;
  const symbolKey = safeString(value.symbol_key, `${field}.symbol_key`, true);
  if (typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0) {
    throw new HybridRankingError('invalid-input', `${field}.score must be a finite non-negative number`);
  }
  return { chunk_key: chunkKey, file_key: fileKey, symbol_key: symbolKey, score: value.score };
}

function validateCandidateSets(value: unknown): Record<HybridSource, HybridCandidate[]> {
  if (!isRecord(value)) {
    throw new HybridRankingError('invalid-input', 'candidate sets must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!(HYBRID_SOURCES as readonly string[]).includes(key)) {
      throw new HybridRankingError('invalid-input', 'candidate sets contain an unsupported source');
    }
  }

  return Object.fromEntries(HYBRID_SOURCES.map((source) => {
    const candidates = value[source] ?? [];
    if (!Array.isArray(candidates) || candidates.length > MAX_CANDIDATES_PER_SOURCE) {
      throw new HybridRankingError('invalid-input', `${source} candidates must be a bounded array`);
    }
    return [source, candidates.map((candidate, index) => validateCandidate(candidate, source, index))];
  })) as unknown as Record<HybridSource, HybridCandidate[]>;
}

interface ResolvedOptions {
  weights: Record<HybridSource, number>;
  rrf_k: number;
  limit: number;
  max_per_symbol: number;
  max_per_file: number;
  preserve_top_exact: boolean;
}

function resolveOptions(value: unknown): ResolvedOptions {
  if (!isRecord(value)) {
    throw new HybridRankingError('invalid-options', 'ranking options must be an object');
  }
  const allowed = new Set(['weights', 'rrf_k', 'limit', 'max_per_symbol', 'max_per_file', 'preserve_top_exact']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new HybridRankingError('invalid-options', 'ranking options contain an unsupported field');
  }

  const rawWeights = value.weights ?? {};
  if (!isRecord(rawWeights)) throw new HybridRankingError('invalid-options', 'weights must be an object');
  for (const key of Object.keys(rawWeights)) {
    if (!(HYBRID_SOURCES as readonly string[]).includes(key)) {
      throw new HybridRankingError('invalid-options', 'weights contain an unsupported source');
    }
  }
  const weights = Object.fromEntries(HYBRID_SOURCES.map((source) => [
    source,
    boundedNumber(rawWeights[source] ?? DEFAULT_WEIGHTS[source], `weights.${source}`, 0, 1),
  ])) as unknown as Record<HybridSource, number>;
  if (Object.values(weights).every((weight) => weight === 0)) {
    throw new HybridRankingError('invalid-options', 'at least one source weight must be positive');
  }

  if (value.preserve_top_exact !== undefined && typeof value.preserve_top_exact !== 'boolean') {
    throw new HybridRankingError('invalid-options', 'preserve_top_exact must be boolean');
  }
  return {
    weights,
    rrf_k: boundedInteger(value.rrf_k ?? 60, 'rrf_k', 1, MAX_RRF_K),
    limit: boundedInteger(value.limit ?? 20, 'limit', 1, MAX_LIMIT),
    max_per_symbol: boundedInteger(value.max_per_symbol ?? 3, 'max_per_symbol', 1, MAX_LIMIT),
    max_per_file: boundedInteger(value.max_per_file ?? 5, 'max_per_file', 1, MAX_LIMIT),
    preserve_top_exact: value.preserve_top_exact ?? true,
  };
}

interface MutableMergedCandidate {
  chunk_key: string;
  symbol_key: string | null;
  file_key: string;
  fusion_score: number;
  evidence: HybridEvidence[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Fuses exact, FTS, vector, and graph candidates with weighted reciprocal-rank
 * fusion. Source scores establish rank only, so incomparable score scales cannot
 * dominate the result. Chunk identity is the sole final tie-break.
 */
export function rankHybridCandidates(
  candidateSets: HybridCandidateSets,
  options: HybridRankingOptions = {},
): readonly HybridRankedCandidate[] {
  const sources = validateCandidateSets(candidateSets);
  const resolved = resolveOptions(options);
  const merged = new Map<string, MutableMergedCandidate>();

  for (const source of HYBRID_SOURCES) {
    const bestPerChunk = new Map<string, HybridCandidate>();
    for (const candidate of sources[source]) {
      const prior = bestPerChunk.get(candidate.chunk_key);
      if (prior && (prior.file_key !== candidate.file_key || prior.symbol_key !== candidate.symbol_key)) {
        throw new HybridRankingError('invalid-input', `${source} contains conflicting chunk identity metadata`);
      }
      if (!prior || candidate.score > prior.score) bestPerChunk.set(candidate.chunk_key, candidate);
    }
    const ranked = [...bestPerChunk.values()].sort((left, right) =>
      right.score - left.score || compareText(left.chunk_key, right.chunk_key));

    for (let index = 0; index < ranked.length; index += 1) {
      const candidate = ranked[index];
      const existing = merged.get(candidate.chunk_key);
      if (existing && (existing.file_key !== candidate.file_key || existing.symbol_key !== candidate.symbol_key)) {
        throw new HybridRankingError('invalid-input', 'sources contain conflicting chunk identity metadata');
      }
      const weightedScore = resolved.weights[source] / (resolved.rrf_k + index + 1);
      const target = existing ?? {
        chunk_key: candidate.chunk_key,
        symbol_key: candidate.symbol_key ?? null,
        file_key: candidate.file_key,
        fusion_score: 0,
        evidence: [],
      };
      target.fusion_score += weightedScore;
      target.evidence.push({
        source,
        source_rank: index + 1,
        source_score: candidate.score,
        weighted_rrf_score: weightedScore,
      });
      merged.set(candidate.chunk_key, target);
    }
  }

  const topExactKey = resolved.preserve_top_exact
    ? [...merged.values()].find(({ evidence }) => evidence.some(({ source, source_rank }) => source === 'exact' && source_rank === 1))?.chunk_key
    : undefined;
  const ordered = [...merged.values()].filter(({ fusion_score }) => fusion_score > 0).sort((left, right) =>
    (left.chunk_key === topExactKey ? -1 : right.chunk_key === topExactKey ? 1 : 0)
    || right.fusion_score - left.fusion_score || compareText(left.chunk_key, right.chunk_key));
  const symbolCounts = new Map<string, number>();
  const fileCounts = new Map<string, number>();
  const selected: HybridRankedCandidate[] = [];
  for (const candidate of ordered) {
    const symbolCount = candidate.symbol_key === null ? 0 : (symbolCounts.get(candidate.symbol_key) ?? 0);
    const fileCount = fileCounts.get(candidate.file_key) ?? 0;
    if (symbolCount >= resolved.max_per_symbol || fileCount >= resolved.max_per_file) continue;
    selected.push({ ...candidate, rank: selected.length + 1 });
    if (candidate.symbol_key !== null) symbolCounts.set(candidate.symbol_key, symbolCount + 1);
    fileCounts.set(candidate.file_key, fileCount + 1);
    if (selected.length === resolved.limit) break;
  }
  return selected;
}
