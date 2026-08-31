import { createHash } from 'node:crypto';
import path from 'node:path';
import type { IndexedSymbol } from '../../../workers/clang-indexer/src/symbol-merge.ts';

export interface FixedSqlStatement {
  readonly name: string;
  readonly text: string;
}

export interface FixedSqlResult<Row> {
  readonly rows: readonly Row[];
  readonly row_count: number;
}

export interface SymbolPersistenceTransaction {
  execute<Row>(statement: FixedSqlStatement, values: readonly (string | number)[]): Promise<FixedSqlResult<Row>>;
}

export interface SymbolPersistenceDatabase {
  transaction<Result>(operation: (transaction: SymbolPersistenceTransaction) => Promise<Result>): Promise<Result>;
}

export interface PersistedFileBinding {
  id: string;
  absolute_path: string;
}

export interface SymbolPersistenceRequest {
  generation_id: string;
  revision_set_hash: string;
  plan_hash: string;
  symbols: readonly IndexedSymbol[];
  files: readonly PersistedFileBinding[];
  batch_size?: number;
}

export interface SymbolPersistenceReport {
  generation_id: string;
  plan_hash: string;
  payload_hash: string;
  symbol_count: number;
  location_count: number;
  unresolved_owner_count: number;
  already_persisted: boolean;
}

export type SymbolPersistenceErrorCode =
  | 'invalid-request'
  | 'generation-not-found'
  | 'generation-mismatch'
  | 'generation-not-building'
  | 'plan-conflict'
  | 'dirty-generation'
  | 'file-mismatch'
  | 'write-mismatch'
  | 'transaction-failed';

export class SymbolPersistenceError extends Error {
  readonly code: SymbolPersistenceErrorCode;

  constructor(code: SymbolPersistenceErrorCode) {
    super(`symbol persistence ${code}`);
    this.name = 'SymbolPersistenceError';
    this.code = code;
  }
}

interface GenerationRow {
  revision_set_hash: string;
  status: string;
  symbol_plan_hash: string | null;
  symbol_payload_hash: string | null;
  symbol_count: string | number | null;
  symbol_location_count: string | number | null;
  symbols_imported_at: string | null;
}

interface CountRow { symbol_count: string | number; location_count: string | number }
interface IdRow { id: string }
interface SymbolIdRow { stable_usr: string; id: string }

interface PreparedSymbol {
  stable_usr: string;
  qualified_name: string;
  name: string;
  display_name: string;
  kind: string;
  owner_usr: string | null;
  signature_hash: string;
  type_spelling: string;
  result_type: string;
  documentation: string | null;
  clang_documentation_id: string | null;
  template_parameters: readonly string[];
  uht_specifiers: readonly string[];
  uht_metadata: Readonly<Record<string, string>>;
  blueprint_exposure: string;
  locations: readonly {
    kind: string;
    file_id: string;
    start_line: number;
    start_column: number;
    end_line: number;
    end_column: number;
  }[];
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const CLANG_DOCUMENTATION_ID = /^[A-F0-9]{40}$/;
const SYMBOL_KINDS = new Set(['namespace', 'module', 'class', 'struct', 'union', 'enum', 'enumerator', 'function', 'method', 'constructor', 'destructor', 'variable', 'field', 'parameter', 'typedef', 'type_alias', 'macro', 'concept']);
const BLUEPRINT_EXPOSURES = new Set(['none', 'callable', 'pure', 'event', 'type', 'property']);
const MAX_SYMBOLS = 2_000_000;
const MAX_FILES = 2_000_000;
const MAX_LOCATIONS = 10_000_000;
const MAX_BATCH_SIZE = 1_000;
const MAX_BATCH_BYTES = 8 * 1024 * 1024;

const STATEMENTS = Object.freeze({
  lockGeneration: Object.freeze({
    name: 'symbol-persistence-lock-generation-v1',
    text: `SELECT encode(revision_set_hash, 'hex') AS revision_set_hash, status,
      encode(symbol_plan_hash, 'hex') AS symbol_plan_hash,
      encode(symbol_payload_hash, 'hex') AS symbol_payload_hash,
      symbol_count, symbol_location_count, symbols_imported_at::text
      FROM ue_mcp.index_generations WHERE id = $1::uuid FOR UPDATE`,
  }),
  countExisting: Object.freeze({
    name: 'symbol-persistence-count-existing-v1',
    text: `SELECT count(DISTINCT s.id) AS symbol_count, count(sl.id) AS location_count
      FROM ue_mcp.index_generations g
      LEFT JOIN ue_mcp.symbols s ON s.generation_id = g.id
      LEFT JOIN ue_mcp.symbol_locations sl ON sl.symbol_id = s.id
      WHERE g.id = $1::uuid`,
  }),
  validateFiles: Object.freeze({
    name: 'symbol-persistence-validate-files-v1',
    text: `SELECT f.id::text AS id FROM ue_mcp.files f
      JOIN jsonb_to_recordset($2::jsonb) AS requested(id uuid) ON requested.id = f.id
      WHERE f.generation_id = $1::uuid ORDER BY f.id`,
  }),
  insertSymbols: Object.freeze({
    name: 'symbol-persistence-insert-symbols-v1',
    text: `INSERT INTO ue_mcp.symbols
      (generation_id, stable_usr, qualified_name, name, display_name, kind, owner_usr, signature_hash, type_spelling, result_type)
      SELECT $1::uuid, input.stable_usr, input.qualified_name, input.name, input.display_name, input.kind,
        input.owner_usr, decode(input.signature_hash, 'hex'), input.type_spelling, input.result_type
      FROM jsonb_to_recordset($2::jsonb) AS input(
        stable_usr text, qualified_name text, name text, display_name text, kind text, owner_usr text,
        signature_hash text, type_spelling text, result_type text)
      RETURNING stable_usr, id::text AS id`,
  }),
  updateOwners: Object.freeze({
    name: 'symbol-persistence-update-owners-v1',
    text: `UPDATE ue_mcp.symbols AS child SET owner_symbol_id = owner.id
      FROM jsonb_to_recordset($2::jsonb) AS input(child_id uuid, owner_id uuid), ue_mcp.symbols AS owner
      WHERE child.id = input.child_id AND owner.id = input.owner_id
        AND child.generation_id = $1::uuid AND owner.generation_id = $1::uuid`,
  }),
  insertLocations: Object.freeze({
    name: 'symbol-persistence-insert-locations-v1',
    text: `INSERT INTO ue_mcp.symbol_locations
      (symbol_id, location_kind, file_id, start_line, start_column, end_line, end_column)
      SELECT input.symbol_id, input.location_kind, input.file_id, input.start_line, input.start_column,
        input.end_line, input.end_column
      FROM jsonb_to_recordset($2::jsonb) AS input(
        symbol_id uuid, location_kind text, file_id uuid, start_line integer, start_column integer,
        end_line integer, end_column integer)
      JOIN ue_mcp.symbols s ON s.id = input.symbol_id AND s.generation_id = $1::uuid`,
  }),
  insertMetadata: Object.freeze({
    name: 'symbol-persistence-insert-metadata-v1',
    text: `INSERT INTO ue_mcp.symbol_metadata
      (symbol_id, uht_specifiers, uht_metadata, blueprint_exposure, documentation, template_parameters, clang_documentation_id)
      SELECT input.symbol_id, input.uht_specifiers, input.uht_metadata, input.blueprint_exposure,
        input.documentation, input.template_parameters, input.clang_documentation_id
      FROM jsonb_to_recordset($2::jsonb) AS input(
        symbol_id uuid, uht_specifiers text[], uht_metadata jsonb, blueprint_exposure text,
        documentation text, template_parameters text[], clang_documentation_id text)
      JOIN ue_mcp.symbols s ON s.id = input.symbol_id AND s.generation_id = $1::uuid`,
  }),
  complete: Object.freeze({
    name: 'symbol-persistence-complete-v1',
    text: `UPDATE ue_mcp.index_generations SET
      symbol_plan_hash = decode($2, 'hex'), symbol_payload_hash = decode($3, 'hex'),
      symbol_count = $4::bigint, symbol_location_count = $5::bigint, symbols_imported_at = clock_timestamp()
      WHERE id = $1::uuid AND status = 'building' AND symbols_imported_at IS NULL`,
  }),
});

function boundedString(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maximum || /[\0]/.test(value)) {
    throw new SymbolPersistenceError('invalid-request');
  }
  return value;
}

function safeCount(value: string | number | null): number {
  const count = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(count) || (count as number) < 0) throw new SymbolPersistenceError('transaction-failed');
  return count as number;
}

function normalizedSourcePath(value: string): { key: string; value: string } {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new SymbolPersistenceError('invalid-request');
  if (path.win32.isAbsolute(value)) {
    const normalized = path.win32.normalize(value);
    return { key: `windows:${normalized.toLowerCase()}`, value: normalized };
  }
  if (path.posix.isAbsolute(value)) {
    const normalized = path.posix.normalize(value);
    return { key: `posix:${normalized}`, value: normalized };
  }
  throw new SymbolPersistenceError('invalid-request');
}

function orderedMetadata(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SymbolPersistenceError('invalid-request');
  const output: Record<string, string> = {};
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'))) {
    output[boundedString(key, 1_024)] = boundedString((value as Record<string, unknown>)[key], 65_536, true);
  }
  return Object.freeze(output);
}

function boundedStrings(value: unknown, maximumItems: number, maximumLength: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new SymbolPersistenceError('invalid-request');
  return Object.freeze(value.map((entry) => boundedString(entry, maximumLength)));
}

function optionalClangDocumentationId(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !CLANG_DOCUMENTATION_ID.test(value)) throw new SymbolPersistenceError('invalid-request');
  return value;
}

function encodedBatches<Row>(rows: readonly Row[], batchSize: number): readonly string[] {
  const batches: string[] = [];
  let current: Row[] = [];
  let bytes = 2;
  for (const row of rows) {
    const encoded = JSON.stringify(row);
    const rowBytes = Buffer.byteLength(encoded, 'utf8') + (current.length === 0 ? 0 : 1);
    if (rowBytes + 2 > MAX_BATCH_BYTES) throw new SymbolPersistenceError('invalid-request');
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

function prepare(request: SymbolPersistenceRequest): {
  files: readonly PersistedFileBinding[];
  symbols: readonly PreparedSymbol[];
  payloadHash: string;
  locationCount: number;
  unresolvedOwnerCount: number;
  batchSize: number;
} {
  if (!UUID.test(request.generation_id) || !HASH.test(request.revision_set_hash) || !HASH.test(request.plan_hash)
      || !Array.isArray(request.symbols) || request.symbols.length > MAX_SYMBOLS || !Array.isArray(request.files)
      || request.files.length === 0 || request.files.length > MAX_FILES) throw new SymbolPersistenceError('invalid-request');
  const batchSize = request.batch_size ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) throw new SymbolPersistenceError('invalid-request');
  const filesByPath = new Map<string, PersistedFileBinding>();
  const fileIds = new Set<string>();
  for (const file of request.files) {
    if (typeof file !== 'object' || file === null || !UUID.test(file.id)) throw new SymbolPersistenceError('invalid-request');
    const sourcePath = normalizedSourcePath(file.absolute_path);
    const key = sourcePath.key;
    if (filesByPath.has(key) || fileIds.has(file.id.toLowerCase())) throw new SymbolPersistenceError('invalid-request');
    const normalized = Object.freeze({ id: file.id.toLowerCase(), absolute_path: sourcePath.value });
    filesByPath.set(key, normalized);
    fileIds.add(normalized.id);
  }
  const usrs = new Set<string>();
  let locationCount = 0;
  const symbols = request.symbols.map((symbol): PreparedSymbol => {
    if (typeof symbol !== 'object' || symbol === null || !SYMBOL_KINDS.has(symbol.kind) || !HASH.test(symbol.signature_hash)
        || !BLUEPRINT_EXPOSURES.has(symbol.blueprint_exposure)) throw new SymbolPersistenceError('invalid-request');
    const stableUsr = boundedString(symbol.stable_usr, 4_096);
    if (usrs.has(stableUsr)) throw new SymbolPersistenceError('invalid-request');
    usrs.add(stableUsr);
    const ownerUsr = symbol.owner_usr === undefined ? null : boundedString(symbol.owner_usr, 4_096);
    if (ownerUsr === stableUsr) throw new SymbolPersistenceError('invalid-request');
    if (!Array.isArray(symbol.locations)) throw new SymbolPersistenceError('invalid-request');
    locationCount += symbol.locations.length;
    if (!Number.isSafeInteger(locationCount) || locationCount > MAX_LOCATIONS) throw new SymbolPersistenceError('invalid-request');
    const locationKeys = new Set<string>();
    const locations = symbol.locations.map((location) => {
      const file = filesByPath.get(normalizedSourcePath(location.file).key);
      if (file === undefined || !['declaration', 'definition'].includes(location.kind)
          || ![location.start_line, location.start_column, location.end_line, location.end_column].every((value) => Number.isSafeInteger(value) && value > 0)
          || location.end_line < location.start_line
          || (location.end_line === location.start_line && location.end_column < location.start_column)) {
        throw new SymbolPersistenceError('invalid-request');
      }
      const normalized = Object.freeze({
        kind: location.kind, file_id: file.id, start_line: location.start_line, start_column: location.start_column,
        end_line: location.end_line, end_column: location.end_column,
      });
      const key = JSON.stringify(normalized);
      if (locationKeys.has(key)) throw new SymbolPersistenceError('invalid-request');
      locationKeys.add(key);
      return normalized;
    }).sort((left, right) => left.file_id.localeCompare(right.file_id, 'en') || left.start_line - right.start_line
      || left.start_column - right.start_column || left.end_line - right.end_line || left.end_column - right.end_column
      || left.kind.localeCompare(right.kind, 'en'));
    return Object.freeze({
      stable_usr: stableUsr,
      qualified_name: boundedString(symbol.qualified_name, 4_096),
      name: boundedString(symbol.name, 4_096),
      display_name: boundedString(symbol.display_name, 4_096),
      kind: symbol.kind,
      owner_usr: ownerUsr,
      signature_hash: symbol.signature_hash,
      type_spelling: boundedString(symbol.type_spelling, 65_536, true),
      result_type: boundedString(symbol.result_type, 65_536, true),
      documentation: symbol.documentation === undefined ? null : boundedString(symbol.documentation, 1024 * 1024, true),
      clang_documentation_id: optionalClangDocumentationId(symbol.clang_documentation_id),
      template_parameters: boundedStrings(symbol.template_parameters, 1_024, 4_096),
      uht_specifiers: boundedStrings(symbol.uht_specifiers, 1_024, 4_096),
      uht_metadata: orderedMetadata(symbol.uht_metadata),
      blueprint_exposure: symbol.blueprint_exposure,
      locations: Object.freeze(locations),
    });
  }).sort((left, right) => left.stable_usr.localeCompare(right.stable_usr, 'en'));
  const orderedFiles = [...filesByPath.values()].sort((left, right) => left.id.localeCompare(right.id, 'en'));
  const payloadHash = createHash('sha256');
  payloadHash.update(JSON.stringify(orderedFiles.map(({ id }) => id)));
  for (const symbol of symbols) payloadHash.update('\0').update(JSON.stringify(symbol));
  const unresolvedOwnerCount = symbols.filter(({ owner_usr: owner }) => owner !== null && !usrs.has(owner)).length;
  return Object.freeze({
    files: Object.freeze(orderedFiles), symbols: Object.freeze(symbols), payloadHash: payloadHash.digest('hex'),
    locationCount, unresolvedOwnerCount, batchSize,
  });
}

function persistenceReport(request: SymbolPersistenceRequest, prepared: ReturnType<typeof prepare>, alreadyPersisted: boolean): SymbolPersistenceReport {
  return Object.freeze({
    generation_id: request.generation_id,
    plan_hash: request.plan_hash,
    payload_hash: prepared.payloadHash,
    symbol_count: prepared.symbols.length,
    location_count: prepared.locationCount,
    unresolved_owner_count: prepared.unresolvedOwnerCount,
    already_persisted: alreadyPersisted,
  });
}

export async function persistIndexedSymbols(
  database: SymbolPersistenceDatabase,
  request: SymbolPersistenceRequest,
): Promise<SymbolPersistenceReport> {
  if (typeof database !== 'object' || database === null || typeof database.transaction !== 'function') {
    throw new SymbolPersistenceError('invalid-request');
  }
  const prepared = prepare(request);
  try {
    return await database.transaction(async (transaction) => {
      if (typeof transaction !== 'object' || transaction === null || typeof transaction.execute !== 'function') {
        throw new SymbolPersistenceError('transaction-failed');
      }
      const generation = await transaction.execute<GenerationRow>(STATEMENTS.lockGeneration, [request.generation_id]);
      if (generation.rows.length !== 1) throw new SymbolPersistenceError('generation-not-found');
      const state = generation.rows[0];
      if (state.revision_set_hash !== request.revision_set_hash) throw new SymbolPersistenceError('generation-mismatch');
      const completed = state.symbols_imported_at !== null;
      if (completed) {
        if (state.symbol_plan_hash !== request.plan_hash || state.symbol_payload_hash !== prepared.payloadHash
            || safeCount(state.symbol_count) !== prepared.symbols.length || safeCount(state.symbol_location_count) !== prepared.locationCount) {
          throw new SymbolPersistenceError('plan-conflict');
        }
        return persistenceReport(request, prepared, true);
      }
      if (state.symbol_plan_hash !== null || state.symbol_payload_hash !== null || state.symbol_count !== null || state.symbol_location_count !== null) {
        throw new SymbolPersistenceError('dirty-generation');
      }
      if (state.status !== 'building') throw new SymbolPersistenceError('generation-not-building');
      const existing = await transaction.execute<CountRow>(STATEMENTS.countExisting, [request.generation_id]);
      if (existing.rows.length !== 1 || safeCount(existing.rows[0].symbol_count) !== 0 || safeCount(existing.rows[0].location_count) !== 0) {
        throw new SymbolPersistenceError('dirty-generation');
      }
      const verifiedFileIds = new Set<string>();
      for (const batch of encodedBatches(prepared.files.map(({ id }) => ({ id })), prepared.batchSize)) {
        const result = await transaction.execute<IdRow>(STATEMENTS.validateFiles, [request.generation_id, batch]);
        for (const row of result.rows) {
          if (!UUID.test(row.id) || verifiedFileIds.has(row.id.toLowerCase())) throw new SymbolPersistenceError('file-mismatch');
          verifiedFileIds.add(row.id.toLowerCase());
        }
      }
      if (verifiedFileIds.size !== prepared.files.length || prepared.files.some(({ id }) => !verifiedFileIds.has(id))) {
        throw new SymbolPersistenceError('file-mismatch');
      }
      const idsByUsr = new Map<string, string>();
      const symbolRows = prepared.symbols.map((symbol) => ({
        stable_usr: symbol.stable_usr, qualified_name: symbol.qualified_name, name: symbol.name,
        display_name: symbol.display_name, kind: symbol.kind, owner_usr: symbol.owner_usr,
        signature_hash: symbol.signature_hash, type_spelling: symbol.type_spelling, result_type: symbol.result_type,
      }));
      for (const batch of encodedBatches(symbolRows, prepared.batchSize)) {
        const result = await transaction.execute<SymbolIdRow>(STATEMENTS.insertSymbols, [request.generation_id, batch]);
        for (const row of result.rows) {
          if (!UUID.test(row.id) || idsByUsr.has(row.stable_usr)) throw new SymbolPersistenceError('write-mismatch');
          idsByUsr.set(row.stable_usr, row.id.toLowerCase());
        }
      }
      if (idsByUsr.size !== prepared.symbols.length || prepared.symbols.some(({ stable_usr: usr }) => !idsByUsr.has(usr))) {
        throw new SymbolPersistenceError('write-mismatch');
      }
      const ownerRows = prepared.symbols.flatMap((symbol) => {
        const ownerId = symbol.owner_usr === null ? undefined : idsByUsr.get(symbol.owner_usr);
        return ownerId === undefined ? [] : [{ child_id: idsByUsr.get(symbol.stable_usr)!, owner_id: ownerId }];
      });
      let ownerWrites = 0;
      for (const batch of encodedBatches(ownerRows, prepared.batchSize)) {
        const result = await transaction.execute(STATEMENTS.updateOwners, [request.generation_id, batch]);
        ownerWrites += result.row_count;
      }
      if (ownerWrites !== ownerRows.length) throw new SymbolPersistenceError('write-mismatch');
      const locationRows = prepared.symbols.flatMap((symbol) => symbol.locations.map((location) => ({
        symbol_id: idsByUsr.get(symbol.stable_usr)!, location_kind: location.kind, file_id: location.file_id,
        start_line: location.start_line, start_column: location.start_column, end_line: location.end_line, end_column: location.end_column,
      })));
      let locationWrites = 0;
      for (const batch of encodedBatches(locationRows, prepared.batchSize)) {
        const result = await transaction.execute(STATEMENTS.insertLocations, [request.generation_id, batch]);
        locationWrites += result.row_count;
      }
      if (locationWrites !== prepared.locationCount) throw new SymbolPersistenceError('write-mismatch');
      const metadataRows = prepared.symbols.map((symbol) => ({
        symbol_id: idsByUsr.get(symbol.stable_usr)!, uht_specifiers: symbol.uht_specifiers,
        uht_metadata: symbol.uht_metadata, blueprint_exposure: symbol.blueprint_exposure,
        documentation: symbol.documentation, template_parameters: symbol.template_parameters,
        clang_documentation_id: symbol.clang_documentation_id,
      }));
      let metadataWrites = 0;
      for (const batch of encodedBatches(metadataRows, prepared.batchSize)) {
        const result = await transaction.execute(STATEMENTS.insertMetadata, [request.generation_id, batch]);
        metadataWrites += result.row_count;
      }
      if (metadataWrites !== prepared.symbols.length) throw new SymbolPersistenceError('write-mismatch');
      const completedWrite = await transaction.execute(STATEMENTS.complete, [
        request.generation_id, request.plan_hash, prepared.payloadHash, prepared.symbols.length, prepared.locationCount,
      ]);
      if (completedWrite.row_count !== 1) throw new SymbolPersistenceError('write-mismatch');
      return persistenceReport(request, prepared, false);
    });
  } catch (error) {
    if (error instanceof SymbolPersistenceError) throw error;
    throw new SymbolPersistenceError('transaction-failed');
  }
}
