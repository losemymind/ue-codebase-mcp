import { createHash } from 'node:crypto';

export type RetrievalGoldLanguage = 'en' | 'zh';
export type RetrievalGoldReviewStatus = 'pending' | 'approved';

export interface RetrievalGoldCase {
  case_id: string;
  language: RetrievalGoldLanguage;
  query: string;
  relevant_chunk_keys: readonly string[];
}

export interface RetrievalGoldSuite {
  schema_version: 1;
  suite_id: string;
  minimum_recall_at_20: number;
  cases: readonly RetrievalGoldCase[];
  review: Readonly<{
    status: RetrievalGoldReviewStatus;
    reviewer: string | null;
    approved_at: string | null;
    payload_sha256: string | null;
  }>;
}

export interface RetrievalGoldResult {
  case_id: string;
  chunk_keys: readonly string[];
}

export interface RetrievalGoldMismatch {
  code: 'missing-case' | 'missing-relevant-chunk';
  case_id: string;
}

export interface RetrievalGoldReport {
  schema_version: 1;
  suite_id: string;
  suite_payload_sha256: string;
  technical_pass: boolean;
  acceptance_pass: boolean;
  review_status: RetrievalGoldReviewStatus;
  review_valid: boolean;
  case_count: number;
  english_case_count: number;
  chinese_case_count: number;
  recall_at_20: number;
  english_recall_at_20: number;
  chinese_recall_at_20: number;
  mismatch_count: number;
  mismatches_truncated: boolean;
  mismatches: readonly RetrievalGoldMismatch[];
}

const ROOT_KEYS = ['schema_version', 'suite_id', 'minimum_recall_at_20', 'cases', 'review'] as const;
const CASE_KEYS = ['case_id', 'language', 'query', 'relevant_chunk_keys'] as const;
const REVIEW_KEYS = ['status', 'reviewer', 'approved_at', 'payload_sha256'] as const;
const HASH = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_GOLD_BYTES = 16 * 1024 * 1024;
const MAX_CASES = 100_000;
const MAX_RELEVANT_PER_CASE = 100;
const MAX_MISMATCHES = 512;

function invalid(): never {
  throw new TypeError('retrieval gold suite is invalid');
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) invalid();
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) invalid();
  return value;
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\r\n\0]/.test(value)) invalid();
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const input = value as Record<string, unknown>;
    return `{${Object.keys(input).sort((left, right) => left.localeCompare(right, 'en')).map((key) => `${JSON.stringify(key)}:${canonical(input[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function payload(suite: RetrievalGoldSuite): object {
  return {
    schema_version: suite.schema_version,
    suite_id: suite.suite_id,
    minimum_recall_at_20: suite.minimum_recall_at_20,
    cases: suite.cases,
  };
}

export function retrievalGoldSuitePayloadSha256(suite: RetrievalGoldSuite): string {
  return createHash('sha256').update(canonical(payload(suite))).digest('hex');
}

export function parseRetrievalGoldSuite(json: string): RetrievalGoldSuite {
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_GOLD_BYTES || json.includes('\0')) invalid();
  let decoded: unknown;
  try { decoded = JSON.parse(json); } catch { return invalid(); }
  const input = object(decoded);
  exactKeys(input, ROOT_KEYS);
  if (input.schema_version !== 1 || typeof input.minimum_recall_at_20 !== 'number'
      || !Number.isFinite(input.minimum_recall_at_20) || input.minimum_recall_at_20 < 0.9 || input.minimum_recall_at_20 > 1
      || !Array.isArray(input.cases) || input.cases.length < 2 || input.cases.length > MAX_CASES) invalid();
  const cases = input.cases.map((value): RetrievalGoldCase => {
    const item = object(value);
    exactKeys(item, CASE_KEYS);
    if (item.language !== 'en' && item.language !== 'zh') invalid();
    if (typeof item.query !== 'string' || item.query.trim().length === 0 || item.query.length > 2_048 || item.query.includes('\0')) invalid();
    if (!Array.isArray(item.relevant_chunk_keys) || item.relevant_chunk_keys.length === 0
        || item.relevant_chunk_keys.length > MAX_RELEVANT_PER_CASE
        || item.relevant_chunk_keys.some((key) => typeof key !== 'string' || !HASH.test(key))) invalid();
    if (new Set(item.relevant_chunk_keys).size !== item.relevant_chunk_keys.length) invalid();
    return Object.freeze({
      case_id: identifier(item.case_id),
      language: item.language,
      query: item.query,
      relevant_chunk_keys: Object.freeze([...item.relevant_chunk_keys]),
    });
  });
  if (new Set(cases.map(({ case_id }) => case_id)).size !== cases.length
      || !cases.some(({ language }) => language === 'en') || !cases.some(({ language }) => language === 'zh')) invalid();
  const reviewInput = object(input.review);
  exactKeys(reviewInput, REVIEW_KEYS);
  if (reviewInput.status !== 'pending' && reviewInput.status !== 'approved') invalid();
  const reviewer = nullableText(reviewInput.reviewer);
  const approvedAt = nullableText(reviewInput.approved_at);
  const reviewHash = nullableText(reviewInput.payload_sha256);
  if (reviewInput.status === 'pending' && (reviewer !== null || approvedAt !== null || reviewHash !== null)) invalid();
  if (reviewInput.status === 'approved' && (reviewer === null || approvedAt === null || reviewHash === null
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(approvedAt) || !HASH.test(reviewHash))) invalid();
  return Object.freeze({
    schema_version: 1,
    suite_id: identifier(input.suite_id),
    minimum_recall_at_20: input.minimum_recall_at_20,
    cases: Object.freeze(cases),
    review: Object.freeze({ status: reviewInput.status, reviewer, approved_at: approvedAt, payload_sha256: reviewHash }),
  });
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function compareRetrievalGold(suite: RetrievalGoldSuite, results: readonly RetrievalGoldResult[]): RetrievalGoldReport {
  if (!Array.isArray(results) || results.length > MAX_CASES) throw new TypeError('retrieval gold results are invalid');
  const resultByCase = new Map<string, readonly string[]>();
  for (const result of results) {
    if (typeof result !== 'object' || result === null || !IDENTIFIER.test(result.case_id) || resultByCase.has(result.case_id)
        || !Array.isArray(result.chunk_keys) || result.chunk_keys.length > 1_000
        || result.chunk_keys.some((key) => typeof key !== 'string' || !HASH.test(key))
        || new Set(result.chunk_keys).size !== result.chunk_keys.length) throw new TypeError('retrieval gold results are invalid');
    resultByCase.set(result.case_id, result.chunk_keys);
  }
  const expectedCases = new Set(suite.cases.map(({ case_id }) => case_id));
  if ([...resultByCase.keys()].some((caseId) => !expectedCases.has(caseId))) throw new TypeError('retrieval gold results contain an unknown case');
  const mismatches: RetrievalGoldMismatch[] = [];
  let mismatchCount = 0;
  const add = (mismatch: RetrievalGoldMismatch): void => {
    mismatchCount += 1;
    if (mismatches.length < MAX_MISMATCHES) mismatches.push(Object.freeze(mismatch));
  };
  const recalls = new Map<string, number>();
  for (const item of suite.cases) {
    const actual = resultByCase.get(item.case_id);
    if (actual === undefined) {
      add({ code: 'missing-case', case_id: item.case_id });
      recalls.set(item.case_id, 0);
      continue;
    }
    const top = new Set(actual.slice(0, 20));
    let matched = 0;
    for (const key of item.relevant_chunk_keys) {
      if (top.has(key)) matched += 1;
      else add({ code: 'missing-relevant-chunk', case_id: item.case_id });
    }
    recalls.set(item.case_id, matched / item.relevant_chunk_keys.length);
  }
  const english = suite.cases.filter(({ language }) => language === 'en').map(({ case_id }) => recalls.get(case_id)!);
  const chinese = suite.cases.filter(({ language }) => language === 'zh').map(({ case_id }) => recalls.get(case_id)!);
  const all = [...recalls.values()];
  const recall = mean(all);
  const englishRecall = mean(english);
  const chineseRecall = mean(chinese);
  const suiteHash = retrievalGoldSuitePayloadSha256(suite);
  const reviewValid = suite.review.status === 'approved' && suite.review.payload_sha256 === suiteHash;
  const technicalPass = recall >= suite.minimum_recall_at_20
    && englishRecall >= suite.minimum_recall_at_20 && chineseRecall >= suite.minimum_recall_at_20;
  return Object.freeze({
    schema_version: 1,
    suite_id: suite.suite_id,
    suite_payload_sha256: suiteHash,
    technical_pass: technicalPass,
    acceptance_pass: technicalPass && reviewValid,
    review_status: suite.review.status,
    review_valid: reviewValid,
    case_count: suite.cases.length,
    english_case_count: english.length,
    chinese_case_count: chinese.length,
    recall_at_20: recall,
    english_recall_at_20: englishRecall,
    chinese_recall_at_20: chineseRecall,
    mismatch_count: mismatchCount,
    mismatches_truncated: mismatchCount > mismatches.length,
    mismatches: Object.freeze(mismatches),
  });
}
