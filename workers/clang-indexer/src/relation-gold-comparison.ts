import { createHash } from 'node:crypto';
import path from 'node:path';
import type { IndexedFileEdge, IndexedSymbolEdge, RelationIndex, SymbolEdgeType } from './relation-index.ts';

export type RelationGoldReviewStatus = 'pending' | 'approved';

export interface GoldSymbolEdge {
  expectation_id: string;
  edge_type: SymbolEdgeType;
  src_usr: string;
  dst_usr: string;
  file: string | null;
  line: number | null;
  column: number | null;
  confidence: number;
}

export interface GoldFileEdge {
  expectation_id: string;
  edge_type: 'include';
  src_file: string;
  dst_file: string;
  line: number;
  column: number;
}

export interface RelationGoldSuite {
  schema_version: 1;
  suite_id: string;
  minimum_precision: number;
  minimum_recall: number;
  symbol_edges: readonly GoldSymbolEdge[];
  file_edges: readonly GoldFileEdge[];
  review: Readonly<{
    status: RelationGoldReviewStatus;
    reviewer: string | null;
    approved_at: string | null;
    payload_sha256: string | null;
  }>;
}

export interface RelationGoldMismatch {
  code: 'missing-edge' | 'unexpected-edge' | 'field-mismatch';
  expectation_id?: string;
  field?: 'confidence';
}

export interface RelationGoldComparisonReport {
  schema_version: 1;
  suite_id: string;
  suite_payload_sha256: string;
  technical_pass: boolean;
  acceptance_pass: boolean;
  review_status: RelationGoldReviewStatus;
  review_valid: boolean;
  expected_edge_count: number;
  actual_edge_count: number;
  matched_edge_count: number;
  precision: number;
  recall: number;
  mismatch_count: number;
  mismatches_truncated: boolean;
  mismatches: readonly RelationGoldMismatch[];
}

const ROOT_KEYS = ['schema_version', 'suite_id', 'minimum_precision', 'minimum_recall', 'symbol_edges', 'file_edges', 'review'] as const;
const SYMBOL_KEYS = ['expectation_id', 'edge_type', 'src_usr', 'dst_usr', 'file', 'line', 'column', 'confidence'] as const;
const FILE_KEYS = ['expectation_id', 'edge_type', 'src_file', 'dst_file', 'line', 'column'] as const;
const REVIEW_KEYS = ['status', 'reviewer', 'approved_at', 'payload_sha256'] as const;
const SYMBOL_EDGE_TYPES = new Set<SymbolEdgeType>(['calls', 'references', 'inherits', 'overrides', 'owns']);
const MAX_GOLD_BYTES = 16 * 1024 * 1024;
const MAX_EXPECTATIONS = 8_000_000;
const MAX_MISMATCHES = 512;

function invalid(): never {
  throw new TypeError('relation gold suite is invalid');
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) invalid();
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 65_536 || /[\r\n\0]/.test(value)) invalid();
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function coordinate(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10_000_000) invalid();
  return value as number;
}

function score(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) invalid();
  return value;
}

function threshold(value: unknown): number {
  const result = score(value);
  if (result < 0.95) invalid();
  return result;
}

function relativeFile(value: unknown): string {
  const file = text(value);
  if (path.isAbsolute(file) || file.includes('\\') || file.split('/').some((part) => part === '' || part === '..')) invalid();
  return file;
}

function symbolEdge(value: unknown): GoldSymbolEdge {
  const input = object(value);
  exactKeys(input, SYMBOL_KEYS);
  const edgeType = text(input.edge_type) as SymbolEdgeType;
  if (!SYMBOL_EDGE_TYPES.has(edgeType)) invalid();
  const file = input.file === null ? null : relativeFile(input.file);
  const line = input.line === null ? null : coordinate(input.line);
  const column = input.column === null ? null : coordinate(input.column);
  if ((file === null) !== (line === null) || (file === null) !== (column === null) || (edgeType === 'owns') !== (file === null)) invalid();
  const srcUsr = text(input.src_usr);
  const dstUsr = text(input.dst_usr);
  if ((edgeType === 'inherits' || edgeType === 'overrides' || edgeType === 'owns') && srcUsr === dstUsr) invalid();
  return Object.freeze({
    expectation_id: text(input.expectation_id), edge_type: edgeType, src_usr: srcUsr, dst_usr: dstUsr,
    file, line, column, confidence: score(input.confidence),
  });
}

function fileEdge(value: unknown): GoldFileEdge {
  const input = object(value);
  exactKeys(input, FILE_KEYS);
  if (input.edge_type !== 'include') invalid();
  const srcFile = relativeFile(input.src_file);
  const dstFile = relativeFile(input.dst_file);
  if (srcFile === dstFile) invalid();
  return Object.freeze({
    expectation_id: text(input.expectation_id), edge_type: 'include', src_file: srcFile, dst_file: dstFile,
    line: coordinate(input.line), column: coordinate(input.column),
  });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const input = value as Record<string, unknown>;
    return `{${Object.keys(input).sort((left, right) => left.localeCompare(right, 'en')).map((key) => `${JSON.stringify(key)}:${canonical(input[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function payload(suite: RelationGoldSuite): object {
  return {
    schema_version: suite.schema_version,
    suite_id: suite.suite_id,
    minimum_precision: suite.minimum_precision,
    minimum_recall: suite.minimum_recall,
    symbol_edges: suite.symbol_edges,
    file_edges: suite.file_edges,
  };
}

export function relationGoldSuitePayloadSha256(suite: RelationGoldSuite): string {
  return createHash('sha256').update(canonical(payload(suite))).digest('hex');
}

export function parseRelationGoldSuite(json: string): RelationGoldSuite {
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_GOLD_BYTES || json.includes('\0')) invalid();
  let decoded: unknown;
  try { decoded = JSON.parse(json); } catch { return invalid(); }
  const input = object(decoded);
  exactKeys(input, ROOT_KEYS);
  if (input.schema_version !== 1 || !Array.isArray(input.symbol_edges) || !Array.isArray(input.file_edges)
      || input.symbol_edges.length + input.file_edges.length === 0
      || input.symbol_edges.length + input.file_edges.length > MAX_EXPECTATIONS) invalid();
  const symbolEdges = input.symbol_edges.map(symbolEdge);
  const fileEdges = input.file_edges.map(fileEdge);
  const expectationIds = [...symbolEdges, ...fileEdges].map((edge) => edge.expectation_id);
  const identityKeys = [...symbolEdges.map(symbolIdentity), ...fileEdges.map(fileIdentity)];
  if (new Set(expectationIds).size !== expectationIds.length || new Set(identityKeys).size !== identityKeys.length) invalid();
  const reviewInput = object(input.review);
  exactKeys(reviewInput, REVIEW_KEYS);
  if (reviewInput.status !== 'pending' && reviewInput.status !== 'approved') invalid();
  const reviewer = nullableText(reviewInput.reviewer);
  const approvedAt = nullableText(reviewInput.approved_at);
  const reviewHash = nullableText(reviewInput.payload_sha256);
  if (reviewInput.status === 'pending' && (reviewer !== null || approvedAt !== null || reviewHash !== null)) invalid();
  if (reviewInput.status === 'approved' && (reviewer === null || approvedAt === null || reviewHash === null
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(approvedAt) || !/^[a-f0-9]{64}$/.test(reviewHash))) invalid();
  return Object.freeze({
    schema_version: 1,
    suite_id: text(input.suite_id),
    minimum_precision: threshold(input.minimum_precision),
    minimum_recall: threshold(input.minimum_recall),
    symbol_edges: Object.freeze(symbolEdges),
    file_edges: Object.freeze(fileEdges),
    review: Object.freeze({ status: reviewInput.status, reviewer, approved_at: approvedAt, payload_sha256: reviewHash }),
  });
}

function symbolIdentity(edge: Pick<GoldSymbolEdge, 'edge_type' | 'src_usr' | 'dst_usr' | 'file' | 'line' | 'column'>): string {
  return canonical([edge.edge_type, edge.src_usr, edge.dst_usr, edge.file, edge.line, edge.column]);
}

function fileIdentity(edge: Pick<GoldFileEdge, 'edge_type' | 'src_file' | 'dst_file' | 'line' | 'column'>): string {
  return canonical([edge.edge_type, edge.src_file, edge.dst_file, edge.line, edge.column]);
}

function relative(value: string, workspaceRoot: string): string {
  if (!path.isAbsolute(value)) throw new TypeError('relation gold comparison paths are invalid');
  const file = path.relative(path.resolve(workspaceRoot), path.resolve(value));
  if (!file || file.startsWith('..') || path.isAbsolute(file)) throw new TypeError('relation gold comparison edge escapes the workspace');
  return file.replaceAll('\\', '/');
}

function comparableSymbol(edge: IndexedSymbolEdge, workspaceRoot: string): Omit<GoldSymbolEdge, 'expectation_id'> {
  const hasLocation = edge.file !== undefined || edge.line !== undefined || edge.column !== undefined;
  if (hasLocation && (edge.file === undefined || edge.line === undefined || edge.column === undefined)) {
    throw new TypeError('relation gold comparison edge is invalid');
  }
  return {
    edge_type: edge.edge_type, src_usr: edge.src_usr, dst_usr: edge.dst_usr,
    file: edge.file === undefined ? null : relative(edge.file, workspaceRoot),
    line: edge.line ?? null, column: edge.column ?? null, confidence: edge.confidence,
  };
}

function comparableFile(edge: IndexedFileEdge, workspaceRoot: string): Omit<GoldFileEdge, 'expectation_id'> {
  return {
    edge_type: 'include', src_file: relative(edge.src_file, workspaceRoot), dst_file: relative(edge.dst_file, workspaceRoot),
    line: edge.line, column: edge.column,
  };
}

export function compareRelationGold(suite: RelationGoldSuite, actual: RelationIndex, workspaceRoot: string): RelationGoldComparisonReport {
  if (!path.isAbsolute(workspaceRoot) || typeof actual !== 'object' || actual === null || actual.schema_version !== 1
      || !Array.isArray(actual.symbol_edges) || !Array.isArray(actual.file_edges)
      || actual.symbol_edges.length + actual.file_edges.length > MAX_EXPECTATIONS) {
    throw new TypeError('relation gold comparison input is invalid');
  }
  const expected = new Map<string, { expectationId: string; confidence?: number }>();
  for (const edge of suite.symbol_edges) expected.set(symbolIdentity(edge), { expectationId: edge.expectation_id, confidence: edge.confidence });
  for (const edge of suite.file_edges) expected.set(fileIdentity(edge), { expectationId: edge.expectation_id });
  const found = new Set<string>();
  const mismatches: RelationGoldMismatch[] = [];
  let mismatchCount = 0;
  const add = (mismatch: RelationGoldMismatch): void => {
    mismatchCount += 1;
    if (mismatches.length < MAX_MISMATCHES) mismatches.push(Object.freeze(mismatch));
  };
  const actualKeys = new Set<string>();
  for (const edge of actual.symbol_edges) {
    const comparable = comparableSymbol(edge, workspaceRoot);
    const key = symbolIdentity(comparable);
    if (actualKeys.has(key)) throw new TypeError('relation gold comparison contains duplicate actual edges');
    actualKeys.add(key);
    const expectation = expected.get(key);
    if (expectation === undefined) add({ code: 'unexpected-edge' });
    else {
      found.add(key);
      if (expectation.confidence !== comparable.confidence) add({ code: 'field-mismatch', expectation_id: expectation.expectationId, field: 'confidence' });
    }
  }
  for (const edge of actual.file_edges) {
    const key = fileIdentity(comparableFile(edge, workspaceRoot));
    if (actualKeys.has(key)) throw new TypeError('relation gold comparison contains duplicate actual edges');
    actualKeys.add(key);
    if (expected.has(key)) found.add(key);
    else add({ code: 'unexpected-edge' });
  }
  for (const [key, expectation] of expected) {
    if (!found.has(key)) add({ code: 'missing-edge', expectation_id: expectation.expectationId });
  }
  const expectedCount = expected.size;
  const actualCount = actualKeys.size;
  const matchedCount = found.size;
  const precision = actualCount === 0 ? 0 : matchedCount / actualCount;
  const recall = expectedCount === 0 ? 0 : matchedCount / expectedCount;
  const suiteHash = relationGoldSuitePayloadSha256(suite);
  const reviewValid = suite.review.status === 'approved' && suite.review.payload_sha256 === suiteHash;
  const hasFieldMismatch = mismatches.some((mismatch) => mismatch.code === 'field-mismatch');
  const technicalPass = precision >= suite.minimum_precision && recall >= suite.minimum_recall && !hasFieldMismatch;
  return Object.freeze({
    schema_version: 1, suite_id: suite.suite_id, suite_payload_sha256: suiteHash,
    technical_pass: technicalPass, acceptance_pass: technicalPass && reviewValid,
    review_status: suite.review.status, review_valid: reviewValid,
    expected_edge_count: expectedCount, actual_edge_count: actualCount, matched_edge_count: matchedCount,
    precision, recall, mismatch_count: mismatchCount, mismatches_truncated: mismatchCount > mismatches.length,
    mismatches: Object.freeze(mismatches),
  });
}
