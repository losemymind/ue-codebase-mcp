import { createHash } from 'node:crypto';
import path from 'node:path';
import type { IndexedSymbol } from './symbol-merge.ts';

export type GoldReviewStatus = 'pending' | 'approved';

export interface GoldLocation {
  kind: 'declaration' | 'definition';
  file: string;
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
}

export interface GoldSymbol {
  expectation_id: string;
  stable_usr: string;
  qualified_name: string;
  name: string;
  display_name: string;
  kind: string;
  owner_usr: string | null;
  type_spelling: string;
  result_type: string;
  documentation: string | null;
  clang_documentation_id: string | null;
  template_parameters: readonly string[];
  uht_specifiers: readonly string[];
  uht_metadata: Readonly<Record<string, string>>;
  blueprint_exposure: IndexedSymbol['blueprint_exposure'];
  locations: readonly GoldLocation[];
}

export interface SymbolGoldSuite {
  schema_version: 1;
  suite_id: string;
  allowed_extra_kinds: readonly string[];
  symbols: readonly GoldSymbol[];
  review: Readonly<{
    status: GoldReviewStatus;
    reviewer: string | null;
    approved_at: string | null;
    payload_sha256: string | null;
  }>;
}

export interface GoldMismatch {
  code: 'missing-symbol' | 'unexpected-symbol' | 'field-mismatch';
  expectation_id?: string;
  field?: string;
}

export interface GoldComparisonReport {
  schema_version: 1;
  suite_id: string;
  suite_payload_sha256: string;
  technical_pass: boolean;
  acceptance_pass: boolean;
  review_status: GoldReviewStatus;
  review_valid: boolean;
  expected_symbol_count: number;
  actual_symbol_count: number;
  allowed_extra_symbol_count: number;
  mismatch_count: number;
  mismatches_truncated: boolean;
  mismatches: readonly GoldMismatch[];
}

const ROOT_KEYS = ['schema_version', 'suite_id', 'allowed_extra_kinds', 'symbols', 'review'] as const;
const SYMBOL_KEYS = ['expectation_id', 'stable_usr', 'qualified_name', 'name', 'display_name', 'kind', 'owner_usr', 'type_spelling', 'result_type', 'documentation', 'clang_documentation_id', 'template_parameters', 'uht_specifiers', 'uht_metadata', 'blueprint_exposure', 'locations'] as const;
const LOCATION_KEYS = ['kind', 'file', 'start_line', 'start_column', 'end_line', 'end_column'] as const;
const REVIEW_KEYS = ['status', 'reviewer', 'approved_at', 'payload_sha256'] as const;
const EXPOSURES = new Set(['none', 'callable', 'pure', 'event', 'type', 'property']);
const MAX_GOLD_BYTES = 8 * 1024 * 1024;
const MAX_EXPECTATIONS = 100_000;
const MAX_MISMATCHES = 512;

function invalid(): never {
  throw new TypeError('symbol gold suite is invalid');
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) invalid();
}

function text(value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > 65_536 || value.includes('\0')) invalid();
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10_000_000) invalid();
  return value as number;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 4096) invalid();
  const output = value.map((item) => text(item));
  if (new Set(output).size !== output.length) invalid();
  return Object.freeze(output);
}

function metadata(value: unknown): Readonly<Record<string, string>> {
  const input = object(value);
  if (Object.keys(input).length > 4096) invalid();
  const output: Record<string, string> = {};
  for (const key of Object.keys(input).sort((left, right) => left.localeCompare(right, 'en'))) output[text(key)] = text(input[key]);
  return Object.freeze(output);
}

function location(value: unknown): GoldLocation {
  const input = object(value);
  exactKeys(input, LOCATION_KEYS);
  if (input.kind !== 'declaration' && input.kind !== 'definition') invalid();
  const file = text(input.file);
  if (path.isAbsolute(file) || file.includes('\\') || file.split('/').some((part) => part === '..' || part === '')) invalid();
  const startLine = integer(input.start_line);
  const startColumn = integer(input.start_column);
  const endLine = integer(input.end_line);
  const endColumn = integer(input.end_column);
  if (endLine < startLine || (endLine === startLine && endColumn < startColumn)) invalid();
  return Object.freeze({
    kind: input.kind,
    file,
    start_line: startLine,
    start_column: startColumn,
    end_line: endLine,
    end_column: endColumn,
  });
}

function symbol(value: unknown): GoldSymbol {
  const input = object(value);
  exactKeys(input, SYMBOL_KEYS);
  const exposure = text(input.blueprint_exposure);
  if (!EXPOSURES.has(exposure)) invalid();
  if (!Array.isArray(input.locations) || input.locations.length === 0 || input.locations.length > 4096) invalid();
  const locations = input.locations.map(location);
  const locationKeys = locations.map((item) => JSON.stringify(item));
  if (new Set(locationKeys).size !== locations.length) invalid();
  const clangId = nullableText(input.clang_documentation_id);
  if (clangId !== null && !/^[A-F0-9]{40}$/.test(clangId)) invalid();
  return Object.freeze({
    expectation_id: text(input.expectation_id),
    stable_usr: text(input.stable_usr),
    qualified_name: text(input.qualified_name),
    name: text(input.name),
    display_name: text(input.display_name),
    kind: text(input.kind),
    owner_usr: nullableText(input.owner_usr),
    type_spelling: text(input.type_spelling, true),
    result_type: text(input.result_type, true),
    documentation: nullableText(input.documentation),
    clang_documentation_id: clangId,
    template_parameters: stringArray(input.template_parameters),
    uht_specifiers: stringArray(input.uht_specifiers),
    uht_metadata: metadata(input.uht_metadata),
    blueprint_exposure: exposure as IndexedSymbol['blueprint_exposure'],
    locations: Object.freeze(locations),
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

function payload(suite: SymbolGoldSuite): object {
  return {
    schema_version: suite.schema_version,
    suite_id: suite.suite_id,
    allowed_extra_kinds: suite.allowed_extra_kinds,
    symbols: suite.symbols,
  };
}

export function goldSuitePayloadSha256(suite: SymbolGoldSuite): string {
  return createHash('sha256').update(canonical(payload(suite))).digest('hex');
}

export function parseSymbolGoldSuite(json: string): SymbolGoldSuite {
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_GOLD_BYTES || json.includes('\0')) invalid();
  let decoded: unknown;
  try { decoded = JSON.parse(json); } catch { return invalid(); }
  const input = object(decoded);
  exactKeys(input, ROOT_KEYS);
  if (input.schema_version !== 1 || !Array.isArray(input.symbols) || input.symbols.length === 0 || input.symbols.length > MAX_EXPECTATIONS) invalid();
  const symbols = input.symbols.map(symbol);
  if (new Set(symbols.map((item) => item.expectation_id)).size !== symbols.length || new Set(symbols.map((item) => item.stable_usr)).size !== symbols.length) invalid();
  const reviewInput = object(input.review);
  exactKeys(reviewInput, REVIEW_KEYS);
  if (reviewInput.status !== 'pending' && reviewInput.status !== 'approved') invalid();
  const reviewer = nullableText(reviewInput.reviewer);
  const approvedAt = nullableText(reviewInput.approved_at);
  const reviewHash = nullableText(reviewInput.payload_sha256);
  if (reviewInput.status === 'pending' && (reviewer !== null || approvedAt !== null || reviewHash !== null)) invalid();
  if (reviewInput.status === 'approved' && (reviewer === null || approvedAt === null || reviewHash === null
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(approvedAt) || !/^[a-f0-9]{64}$/.test(reviewHash))) invalid();
  const suite: SymbolGoldSuite = Object.freeze({
    schema_version: 1,
    suite_id: text(input.suite_id),
    allowed_extra_kinds: stringArray(input.allowed_extra_kinds),
    symbols: Object.freeze(symbols),
    review: Object.freeze({ status: reviewInput.status, reviewer, approved_at: approvedAt, payload_sha256: reviewHash }),
  });
  return suite;
}

function relativeLocation(value: IndexedSymbol['locations'][number], workspaceRoot: string): GoldLocation {
  if (!path.isAbsolute(workspaceRoot) || !path.isAbsolute(value.file)) throw new TypeError('gold comparison paths are invalid');
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(value.file));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new TypeError('gold comparison symbol escapes the workspace');
  return {
    kind: value.kind,
    file: relative.replaceAll('\\', '/'),
    start_line: value.start_line,
    start_column: value.start_column,
    end_line: value.end_line,
    end_column: value.end_column,
  };
}

function comparable(value: IndexedSymbol, workspaceRoot: string): Omit<GoldSymbol, 'expectation_id' | 'stable_usr'> {
  return {
    qualified_name: value.qualified_name,
    name: value.name,
    display_name: value.display_name,
    kind: value.kind,
    owner_usr: value.owner_usr ?? null,
    type_spelling: value.type_spelling,
    result_type: value.result_type,
    documentation: value.documentation ?? null,
    clang_documentation_id: value.clang_documentation_id ?? null,
    template_parameters: value.template_parameters,
    uht_specifiers: value.uht_specifiers,
    uht_metadata: value.uht_metadata,
    blueprint_exposure: value.blueprint_exposure,
    locations: value.locations.map((item) => relativeLocation(item, workspaceRoot)),
  };
}

export function compareSymbolGold(suite: SymbolGoldSuite, actual: readonly IndexedSymbol[], workspaceRoot: string): GoldComparisonReport {
  if (!Array.isArray(actual) || actual.length > 2_000_000 || !path.isAbsolute(workspaceRoot)) throw new TypeError('gold comparison input is invalid');
  const actualByUsr = new Map<string, IndexedSymbol>();
  for (const item of actual) {
    if (actualByUsr.has(item.stable_usr)) throw new TypeError('gold comparison contains duplicate actual USRs');
    actualByUsr.set(item.stable_usr, item);
  }
  const allowedKinds = new Set(suite.allowed_extra_kinds);
  const expectedUsrs = new Set(suite.symbols.map((item) => item.stable_usr));
  const mismatches: GoldMismatch[] = [];
  let mismatchCount = 0;
  const add = (mismatch: GoldMismatch): void => {
    mismatchCount += 1;
    if (mismatches.length < MAX_MISMATCHES) mismatches.push(Object.freeze(mismatch));
  };
  for (const expected of suite.symbols) {
    const item = actualByUsr.get(expected.stable_usr);
    if (item === undefined) { add({ code: 'missing-symbol', expectation_id: expected.expectation_id }); continue; }
    const expectedFields = { ...expected } as Record<string, unknown>;
    delete expectedFields.expectation_id;
    delete expectedFields.stable_usr;
    const actualFields = comparable(item, workspaceRoot) as unknown as Record<string, unknown>;
    for (const field of Object.keys(expectedFields)) {
      if (canonical(expectedFields[field]) !== canonical(actualFields[field])) add({ code: 'field-mismatch', expectation_id: expected.expectation_id, field });
    }
  }
  let allowedExtras = 0;
  for (const item of actual) {
    if (expectedUsrs.has(item.stable_usr)) continue;
    if (allowedKinds.has(item.kind)) allowedExtras += 1;
    else add({ code: 'unexpected-symbol' });
  }
  const suiteHash = goldSuitePayloadSha256(suite);
  const reviewValid = suite.review.status === 'approved' && suite.review.payload_sha256 === suiteHash;
  const technicalPass = mismatchCount === 0;
  return Object.freeze({
    schema_version: 1,
    suite_id: suite.suite_id,
    suite_payload_sha256: suiteHash,
    technical_pass: technicalPass,
    acceptance_pass: technicalPass && reviewValid,
    review_status: suite.review.status,
    review_valid: reviewValid,
    expected_symbol_count: suite.symbols.length,
    actual_symbol_count: actual.length,
    allowed_extra_symbol_count: allowedExtras,
    mismatch_count: mismatchCount,
    mismatches_truncated: mismatchCount > mismatches.length,
    mismatches: Object.freeze(mismatches),
  });
}
