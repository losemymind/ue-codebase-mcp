import { createHash } from 'node:crypto';
import type { FixedSqlResult, FixedSqlStatement } from './symbol-persistence.ts';

export interface GenerationPublicationTransaction {
  execute<Row>(statement: FixedSqlStatement, values: readonly (string | number)[]): Promise<FixedSqlResult<Row>>;
}

export interface GenerationPublicationDatabase {
  transaction<Result>(operation: (transaction: GenerationPublicationTransaction) => Promise<Result>): Promise<Result>;
}

export type PublicationActorType = 'user' | 'service' | 'agent' | 'system';

export interface PublicationActor {
  type: PublicationActorType;
  id: string;
}

export interface StageGenerationRequest {
  project_id: string;
  revision_set_hash: string;
  revisions: readonly { repository_branch_id: string; revision_id: string }[];
  actor: PublicationActor;
}

export interface ValidateGenerationRequest {
  project_id: string;
  generation_id: string;
  manifest_uri: string;
  manifest_hash: string;
  embedding_profile: { provider: string; model: string; dimensions: number };
  expected_publication_version?: number;
  actor: PublicationActor;
}

export interface PublishGenerationRequest {
  project_id: string;
  generation_id: string;
  validation_hash: string;
  expected_publication_version: number;
  actor: PublicationActor;
}

export interface RollbackGenerationRequest {
  project_id: string;
  target_generation_id: string;
  expected_target_version: number;
  expected_active_generation_id?: string;
  actor: PublicationActor;
}

export interface GarbageCollectGenerationsRequest {
  project_id: string;
  operation_id?: string;
  retention_days?: number;
  retain_recent?: number;
  limit?: number;
  execute?: boolean;
  actor: PublicationActor;
}

export interface GenerationArtifactStore {
  deleteManifest(request: Readonly<{
    operation_id: string;
    generation_id: string;
    manifest_uri: string;
    manifest_hash: string;
    idempotency_key: string;
  }>): Promise<Readonly<{ receipt_hash: string }>>;
}

export interface StageGenerationReport {
  generation_id: string;
  revision_set_hash: string;
  revision_count: number;
  publication_version: number;
  already_staged: boolean;
}

export interface ValidateGenerationReport {
  generation_id: string;
  validation_hash: string;
  publication_version: number;
  counts: Readonly<Record<'revisions' | 'files' | 'symbols' | 'symbol_locations' | 'symbol_edges' | 'file_dependencies' | 'code_chunks' | 'embeddings', number>>;
  already_validated: boolean;
}

export interface PublishGenerationReport {
  generation_id: string;
  previous_active_generation_id: string | null;
  publication_version: number;
  already_active: boolean;
}

export interface RollbackGenerationReport {
  generation_id: string;
  superseded_generation_id: string | null;
  publication_version: number;
  already_active: boolean;
}

export interface GarbageCollectGenerationsReport {
  candidate_generation_ids: readonly string[];
  deleted_generation_ids: readonly string[];
  retention_days: number;
  retain_recent: number;
}

export type GenerationPublicationErrorCode =
  | 'invalid-request'
  | 'project-not-found'
  | 'project-not-active'
  | 'generation-not-found'
  | 'revision-mismatch'
  | 'generation-conflict'
  | 'generation-not-building'
  | 'generation-not-ready'
  | 'generation-not-superseded'
  | 'generation-gc-claimed'
  | 'generation-incomplete'
  | 'validation-conflict'
  | 'publication-conflict'
  | 'active-generation-mismatch'
  | 'write-mismatch'
  | 'transaction-failed';

export class GenerationPublicationError extends Error {
  readonly code: GenerationPublicationErrorCode;

  constructor(code: GenerationPublicationErrorCode) {
    super(`generation publication ${code}`);
    this.name = 'GenerationPublicationError';
    this.code = code;
  }
}

interface ProjectRow { status: string }
interface RevisionRow { repository_branch_id: string; revision_id: string; repository_id: string }
interface MappingRow { repository_branch_id: string; revision_id: string }
interface GenerationRow {
  id: string;
  project_id: string;
  revision_set_hash: string;
  status: string;
  manifest_uri: string | null;
  manifest_hash: string | null;
  validation_hash: string | null;
  validated_at: string | null;
  symbol_plan_hash: string | null;
  symbol_payload_hash: string | null;
  symbol_count: string | number | null;
  symbol_location_count: string | number | null;
  symbols_imported_at: string | null;
  relation_plan_hash: string | null;
  relation_payload_hash: string | null;
  symbol_edge_count: string | number | null;
  file_dependency_count: string | number | null;
  relations_imported_at: string | null;
  chunk_plan_hash: string | null;
  chunk_payload_hash: string | null;
  code_chunk_count: string | number | null;
  chunks_imported_at: string | null;
  embedding_provider: string | null;
  embedding_model: string | null;
  embedding_dimensions: string | number | null;
  embedding_count: string | number | null;
  gc_claimed_at: string | null;
  publication_version: string | number;
}

interface SnapshotRow {
  revision_count: string | number;
  repository_count: string | number;
  invalid_revision_count: string | number;
  file_count: string | number;
  invalid_file_count: string | number;
  invalid_module_count: string | number;
  symbol_count: string | number;
  symbol_location_count: string | number;
  invalid_symbol_count: string | number;
  symbol_edge_count: string | number;
  invalid_symbol_edge_count: string | number;
  file_dependency_count: string | number;
  invalid_file_dependency_count: string | number;
  code_chunk_count: string | number;
  invalid_code_chunk_count: string | number;
  embedding_count: string | number;
  invalid_embedding_count: string | number;
  unresolved_failure_count: string | number;
}

interface VersionRow { publication_version: string | number }
interface GcRow {
  id: string;
  status: string;
  manifest_uri: string | null;
  manifest_hash: string | null;
  publication_version: string | number;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const ACTOR_TYPES = new Set<PublicationActorType>(['user', 'service', 'agent', 'system']);
const MAX_REVISIONS = 128;

const STATEMENTS = Object.freeze({
  lockProject: Object.freeze({
    name: 'generation-publication-lock-project-v1',
    text: `SELECT status FROM ue_mcp.projects WHERE id = $1::uuid FOR UPDATE`,
  }),
  validateRevisions: Object.freeze({
    name: 'generation-publication-validate-revisions-v1',
    text: `SELECT input.repository_branch_id::text, input.revision_id::text, repository.id::text AS repository_id
      FROM jsonb_to_recordset($2::jsonb) AS input(repository_branch_id uuid, revision_id uuid)
      JOIN ue_mcp.revisions revision ON revision.id = input.revision_id
        AND revision.repository_branch_id = input.repository_branch_id
      JOIN ue_mcp.repository_branches branch ON branch.id = input.repository_branch_id
      JOIN ue_mcp.repositories repository ON repository.id = branch.repository_id
      WHERE repository.project_id = $1::uuid AND repository.enabled
      ORDER BY input.repository_branch_id`,
  }),
  loadGenerationByHash: Object.freeze({
    name: 'generation-publication-load-by-hash-v1',
    text: `SELECT id::text, status, publication_version
      FROM ue_mcp.index_generations
      WHERE project_id = $1::uuid AND revision_set_hash = decode($2, 'hex') FOR UPDATE`,
  }),
  insertGeneration: Object.freeze({
    name: 'generation-publication-insert-staging-v1',
    text: `INSERT INTO ue_mcp.index_generations
      (project_id, revision_set_hash, status, started_at)
      VALUES ($1::uuid, decode($2, 'hex'), 'building', clock_timestamp())
      RETURNING id::text, status, publication_version`,
  }),
  insertRevisionMappings: Object.freeze({
    name: 'generation-publication-insert-revisions-v1',
    text: `INSERT INTO ue_mcp.generation_revisions (generation_id, repository_branch_id, revision_id)
      SELECT $1::uuid, input.repository_branch_id, input.revision_id
      FROM jsonb_to_recordset($2::jsonb) AS input(repository_branch_id uuid, revision_id uuid)`,
  }),
  loadRevisionMappings: Object.freeze({
    name: 'generation-publication-load-revisions-v1',
    text: `SELECT repository_branch_id::text, revision_id::text
      FROM ue_mcp.generation_revisions WHERE generation_id = $1::uuid ORDER BY repository_branch_id`,
  }),
  lockGeneration: Object.freeze({
    name: 'generation-publication-lock-generation-v1',
    text: `SELECT id::text, project_id::text, encode(revision_set_hash, 'hex') AS revision_set_hash,
      status, manifest_uri, encode(manifest_hash, 'hex') AS manifest_hash,
      encode(validation_hash, 'hex') AS validation_hash, validated_at::text,
      encode(symbol_plan_hash, 'hex') AS symbol_plan_hash,
      encode(symbol_payload_hash, 'hex') AS symbol_payload_hash,
      symbol_count, symbol_location_count, symbols_imported_at::text,
      encode(relation_plan_hash, 'hex') AS relation_plan_hash,
      encode(relation_payload_hash, 'hex') AS relation_payload_hash,
      symbol_edge_count, file_dependency_count, relations_imported_at::text,
      encode(chunk_plan_hash, 'hex') AS chunk_plan_hash,
      encode(chunk_payload_hash, 'hex') AS chunk_payload_hash,
      code_chunk_count, chunks_imported_at::text,
      embedding_provider, embedding_model, embedding_dimensions, embedding_count, gc_claimed_at::text, publication_version
      FROM ue_mcp.index_generations WHERE id = $1::uuid AND project_id = $2::uuid FOR UPDATE`,
  }),
  loadSnapshot: Object.freeze({
    name: 'generation-publication-load-validation-snapshot-v1',
    text: `SELECT
      (SELECT count(*) FROM ue_mcp.generation_revisions WHERE generation_id = $1::uuid) AS revision_count,
      (SELECT count(DISTINCT branch.repository_id) FROM ue_mcp.generation_revisions mapping
        JOIN ue_mcp.repository_branches branch ON branch.id = mapping.repository_branch_id
        WHERE mapping.generation_id = $1::uuid) AS repository_count,
      (SELECT count(*) FROM ue_mcp.generation_revisions mapping
        JOIN ue_mcp.repository_branches branch ON branch.id = mapping.repository_branch_id
        JOIN ue_mcp.repositories repository ON repository.id = branch.repository_id
        JOIN ue_mcp.revisions revision ON revision.id = mapping.revision_id
        WHERE mapping.generation_id = $1::uuid
          AND (repository.project_id <> $2::uuid OR NOT repository.enabled
            OR revision.repository_branch_id <> mapping.repository_branch_id)) AS invalid_revision_count,
      (SELECT count(*) FROM ue_mcp.files file WHERE file.generation_id = $1::uuid) AS file_count,
      (SELECT count(*) FROM ue_mcp.files file
        JOIN ue_mcp.repositories repository ON repository.id = file.repository_id
        WHERE file.generation_id = $1::uuid AND (repository.project_id <> $2::uuid OR NOT EXISTS (
          SELECT 1 FROM ue_mcp.generation_revisions mapping
          JOIN ue_mcp.repository_branches branch ON branch.id = mapping.repository_branch_id
          WHERE mapping.generation_id = $1::uuid AND branch.repository_id = file.repository_id))) AS invalid_file_count,
      (SELECT count(*) FROM ue_mcp.modules module
        LEFT JOIN ue_mcp.files build_file ON build_file.id = module.build_file_id
        WHERE module.generation_id = $1::uuid AND build_file.id IS NOT NULL AND build_file.generation_id <> $1::uuid)
        + (SELECT count(*) FROM ue_mcp.module_dependencies dependency
          JOIN ue_mcp.modules source ON source.id = dependency.src_module_id
          JOIN ue_mcp.modules destination ON destination.id = dependency.dst_module_id
          LEFT JOIN ue_mcp.files evidence ON evidence.id = dependency.source_file_id
          WHERE (source.generation_id = $1::uuid OR destination.generation_id = $1::uuid)
            AND (source.generation_id <> $1::uuid OR destination.generation_id <> $1::uuid
              OR (evidence.id IS NOT NULL AND evidence.generation_id <> $1::uuid))) AS invalid_module_count,
      (SELECT count(*) FROM ue_mcp.symbols symbol WHERE symbol.generation_id = $1::uuid) AS symbol_count,
      (SELECT count(*) FROM ue_mcp.symbol_locations location
        JOIN ue_mcp.symbols symbol ON symbol.id = location.symbol_id
        WHERE symbol.generation_id = $1::uuid) AS symbol_location_count,
      (SELECT count(*) FROM ue_mcp.symbols symbol
        JOIN ue_mcp.symbols owner ON owner.id = symbol.owner_symbol_id
        WHERE (symbol.generation_id = $1::uuid OR owner.generation_id = $1::uuid)
          AND symbol.generation_id <> owner.generation_id)
      + (SELECT count(*) FROM ue_mcp.symbol_locations location
          JOIN ue_mcp.symbols symbol ON symbol.id = location.symbol_id
          JOIN ue_mcp.files file ON file.id = location.file_id
          WHERE (symbol.generation_id = $1::uuid OR file.generation_id = $1::uuid)
            AND symbol.generation_id <> file.generation_id)
      + (SELECT count(*) FROM ue_mcp.symbols symbol
          JOIN ue_mcp.modules module ON module.id = symbol.module_id
          WHERE (symbol.generation_id = $1::uuid OR module.generation_id = $1::uuid)
            AND symbol.generation_id <> module.generation_id) AS invalid_symbol_count,
      (SELECT count(*) FROM ue_mcp.symbol_edges edge
        JOIN ue_mcp.symbols source ON source.id = edge.src_symbol_id
        JOIN ue_mcp.symbols destination ON destination.id = edge.dst_symbol_id
        WHERE source.generation_id = $1::uuid AND destination.generation_id = $1::uuid) AS symbol_edge_count,
      (SELECT count(*) FROM ue_mcp.symbol_edges edge
        JOIN ue_mcp.symbols source ON source.id = edge.src_symbol_id
        JOIN ue_mcp.symbols destination ON destination.id = edge.dst_symbol_id
        LEFT JOIN ue_mcp.files evidence ON evidence.id = edge.file_id
        WHERE (source.generation_id = $1::uuid OR destination.generation_id = $1::uuid)
          AND (source.generation_id <> $1::uuid OR destination.generation_id <> $1::uuid
            OR (evidence.id IS NOT NULL AND evidence.generation_id <> $1::uuid))) AS invalid_symbol_edge_count,
      (SELECT count(*) FROM ue_mcp.file_dependencies dependency
        JOIN ue_mcp.files source ON source.id = dependency.src_file_id
        JOIN ue_mcp.files destination ON destination.id = dependency.dst_file_id
        WHERE source.generation_id = $1::uuid AND destination.generation_id = $1::uuid) AS file_dependency_count,
      (SELECT count(*) FROM ue_mcp.file_dependencies dependency
        JOIN ue_mcp.files source ON source.id = dependency.src_file_id
        JOIN ue_mcp.files destination ON destination.id = dependency.dst_file_id
        WHERE (source.generation_id = $1::uuid OR destination.generation_id = $1::uuid)
          AND (source.generation_id <> $1::uuid OR destination.generation_id <> $1::uuid)) AS invalid_file_dependency_count,
      (SELECT count(*) FROM ue_mcp.code_chunks chunk WHERE chunk.generation_id = $1::uuid) AS code_chunk_count,
      (SELECT count(*) FROM ue_mcp.code_chunks chunk
        JOIN ue_mcp.files file ON file.id = chunk.file_id
        LEFT JOIN ue_mcp.symbols symbol ON symbol.id = chunk.symbol_id
        WHERE chunk.generation_id = $1::uuid AND (file.generation_id <> $1::uuid
          OR (symbol.id IS NOT NULL AND symbol.generation_id <> $1::uuid))) AS invalid_code_chunk_count,
      (SELECT count(*) FROM ue_mcp.chunk_embeddings embedding
        JOIN ue_mcp.code_chunks chunk ON chunk.id = embedding.chunk_id
        WHERE chunk.generation_id = $1::uuid AND embedding.provider = $3 AND embedding.model = $4
          AND embedding.dimensions = $5::integer) AS embedding_count,
      (SELECT count(*) FROM ue_mcp.chunk_embeddings embedding
        JOIN ue_mcp.code_chunks chunk ON chunk.id = embedding.chunk_id
        WHERE chunk.generation_id = $1::uuid AND embedding.provider = $3 AND embedding.model = $4
          AND embedding.dimensions = $5::integer AND embedding.content_hash <> chunk.content_hash) AS invalid_embedding_count,
      (SELECT count(*) FROM ue_mcp.index_failures failure
        WHERE failure.generation_id = $1::uuid AND failure.retry_state <> 'resolved') AS unresolved_failure_count`,
  }),
  markReady: Object.freeze({
    name: 'generation-publication-mark-ready-v1',
    text: `UPDATE ue_mcp.index_generations SET status = 'ready', manifest_uri = $3,
      manifest_hash = decode($4, 'hex'), validation_hash = decode($5, 'hex'), validated_at = clock_timestamp(),
      embedding_provider = $6, embedding_model = $7, embedding_dimensions = $8::integer,
      embedding_count = $9::bigint, publication_version = publication_version + 1
      WHERE id = $1::uuid AND project_id = $2::uuid AND status = 'building'
        AND publication_version = $10::bigint AND validated_at IS NULL
      RETURNING publication_version`,
  }),
  quarantineInvalid: Object.freeze({
    name: 'generation-publication-quarantine-invalid-v1',
    text: `UPDATE ue_mcp.index_generations SET status = 'failed', publication_version = publication_version + 1
      WHERE id = $1::uuid AND project_id = $2::uuid AND status = 'building'
        AND publication_version = $3::bigint AND validated_at IS NULL
      RETURNING publication_version`,
  }),
  loadActive: Object.freeze({
    name: 'generation-publication-load-active-v1',
    text: `SELECT id::text, project_id::text, encode(revision_set_hash, 'hex') AS revision_set_hash,
      status, manifest_uri, encode(manifest_hash, 'hex') AS manifest_hash,
      encode(validation_hash, 'hex') AS validation_hash, validated_at::text,
      NULL::text AS symbol_plan_hash, NULL::text AS symbol_payload_hash,
      NULL::bigint AS symbol_count, NULL::bigint AS symbol_location_count, NULL::text AS symbols_imported_at,
      NULL::text AS relation_plan_hash, NULL::text AS relation_payload_hash,
      NULL::bigint AS symbol_edge_count, NULL::bigint AS file_dependency_count, NULL::text AS relations_imported_at,
      NULL::text AS chunk_plan_hash, NULL::text AS chunk_payload_hash,
      NULL::bigint AS code_chunk_count, NULL::text AS chunks_imported_at,
      embedding_provider, embedding_model, embedding_dimensions, embedding_count, gc_claimed_at::text, publication_version
      FROM ue_mcp.index_generations WHERE project_id = $1::uuid AND status = 'active' FOR UPDATE`,
  }),
  supersedeActive: Object.freeze({
    name: 'generation-publication-supersede-active-v1',
    text: `UPDATE ue_mcp.index_generations SET status = 'superseded', superseded_at = clock_timestamp(),
      publication_version = publication_version + 1
      WHERE id = $1::uuid AND project_id = $2::uuid AND status = 'active' AND publication_version = $3::bigint`,
  }),
  activateReady: Object.freeze({
    name: 'generation-publication-activate-ready-v1',
    text: `UPDATE ue_mcp.index_generations SET status = 'active', published_at = clock_timestamp(),
      superseded_at = NULL, publication_version = publication_version + 1
      WHERE id = $1::uuid AND project_id = $2::uuid AND status = 'ready'
        AND validation_hash = decode($3, 'hex') AND publication_version = $4::bigint
      RETURNING publication_version`,
  }),
  activateRollback: Object.freeze({
    name: 'generation-publication-activate-rollback-v1',
    text: `UPDATE ue_mcp.index_generations SET status = 'active', superseded_at = NULL,
      publication_version = publication_version + 1
      WHERE id = $1::uuid AND project_id = $2::uuid AND status = 'superseded'
        AND publication_version = $3::bigint AND validated_at IS NOT NULL AND gc_claimed_at IS NULL
      RETURNING publication_version`,
  }),
  gcCandidates: Object.freeze({
    name: 'generation-publication-gc-candidates-v1',
    text: `WITH ranked_valid AS (
        SELECT id, row_number() OVER (ORDER BY published_at DESC, id DESC) AS valid_rank
        FROM ue_mcp.index_generations
        WHERE project_id = $1::uuid AND status IN ('active', 'superseded') AND validated_at IS NOT NULL
      ), candidates AS (
        SELECT generation.id
        FROM ue_mcp.index_generations generation
        LEFT JOIN ranked_valid ranked ON ranked.id = generation.id
        WHERE generation.project_id = $1::uuid
          AND (generation.gc_claim_hash IS NULL OR generation.gc_claim_hash = decode($5, 'hex'))
          AND NOT EXISTS (SELECT 1 FROM ue_mcp.backup_runs backup
            WHERE backup.generation_id = generation.id AND backup.status = 'running')
          AND ((generation.status = 'superseded' AND generation.published_at < clock_timestamp() - make_interval(days => $2::integer)
                AND ranked.valid_rank > $3::integer)
            OR (generation.status = 'failed' AND generation.updated_at < clock_timestamp() - make_interval(days => $2::integer)))
        ORDER BY COALESCE(generation.published_at, generation.updated_at), generation.id
        LIMIT $4::integer
      )
      SELECT generation.id::text, generation.status, generation.manifest_uri,
        encode(generation.manifest_hash, 'hex') AS manifest_hash, generation.publication_version
      FROM ue_mcp.index_generations generation JOIN candidates ON candidates.id = generation.id
      ORDER BY COALESCE(generation.published_at, generation.updated_at), generation.id
      FOR UPDATE OF generation SKIP LOCKED`,
  }),
  claimGcCandidate: Object.freeze({
    name: 'generation-publication-gc-claim-v1',
    text: `UPDATE ue_mcp.index_generations SET
      gc_claim_hash = decode($4, 'hex'), gc_claimed_at = COALESCE(gc_claimed_at, clock_timestamp()),
      publication_version = publication_version + CASE WHEN gc_claim_hash IS NULL THEN 1 ELSE 0 END
      WHERE id = $1::uuid AND project_id = $2::uuid AND status IN ('superseded', 'failed')
        AND publication_version = $3::bigint
        AND (gc_claim_hash IS NULL OR gc_claim_hash = decode($4, 'hex'))
      RETURNING id::text, status, manifest_uri, encode(manifest_hash, 'hex') AS manifest_hash, publication_version`,
  }),
  deleteGcCandidate: Object.freeze({
    name: 'generation-publication-gc-delete-v1',
    text: `DELETE FROM ue_mcp.index_generations
      WHERE id = $1::uuid AND project_id = $2::uuid AND status IN ('superseded', 'failed')
        AND publication_version = $3::bigint AND gc_claim_hash = decode($4, 'hex')`,
  }),
  insertEvent: Object.freeze({
    name: 'generation-publication-insert-event-v1',
    text: `INSERT INTO ue_mcp.generation_publication_events
      (project_id, target_generation_id, previous_active_generation_id, event_type,
       actor_type, actor_id, request_hash, publication_version)
      VALUES ($1::uuid, $2::uuid, NULLIF($3, '')::uuid, $4, $5, $6, decode($7, 'hex'), $8::bigint)`,
  }),
});

function invalid(): never {
  throw new GenerationPublicationError('invalid-request');
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !keys.includes(key))) invalid();
  return object;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid();
  return value as number;
}

function storedInteger(value: string | number | null): number {
  const result = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(result) || (result as number) < 0) throw new GenerationPublicationError('transaction-failed');
  return result as number;
}

function actor(value: unknown): PublicationActor {
  const object = exactObject(value, ['type', 'id']);
  if (!ACTOR_TYPES.has(object.type as PublicationActorType) || typeof object.id !== 'string'
      || object.id.length < 1 || object.id.length > 512 || /[\r\n\0]/.test(object.id)) invalid();
  return Object.freeze({ type: object.type as PublicationActorType, id: object.id });
}

function requestHash(value: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify({ schema_version: 1, ...value })).digest('hex');
}

function safeManifestUri(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\r\n\0]/.test(value)) invalid();
  let uri: URL;
  try { uri = new URL(value); } catch { invalid(); }
  if (!['https:', 's3:', 'gs:', 'az:'].includes(uri.protocol) || uri.username || uri.password || uri.search || uri.hash) invalid();
  return uri.href;
}

function storedManifestUri(value: string): string {
  try {
    const uri = safeManifestUri(value);
    if (uri !== value) throw new Error('non-canonical');
    return uri;
  } catch {
    throw new GenerationPublicationError('transaction-failed');
  }
}

function profile(value: unknown): { provider: string; model: string; dimensions: number } {
  const object = exactObject(value, ['provider', 'model', 'dimensions']);
  if (typeof object.provider !== 'string' || !IDENTIFIER.test(object.provider)
      || typeof object.model !== 'string' || !MODEL.test(object.model)) invalid();
  return Object.freeze({
    provider: object.provider,
    model: object.model,
    dimensions: integer(object.dimensions, 1, 16_000),
  });
}

async function lockedProject(transaction: GenerationPublicationTransaction, projectId: string): Promise<void> {
  const project = await transaction.execute<ProjectRow>(STATEMENTS.lockProject, [projectId]);
  if (project.rows.length !== 1) throw new GenerationPublicationError('project-not-found');
  if (project.rows[0].status !== 'active') throw new GenerationPublicationError('project-not-active');
}

function sameMappings(left: readonly MappingRow[], right: readonly { repository_branch_id: string; revision_id: string }[]): boolean {
  return left.length === right.length && left.every((item, index) => item.repository_branch_id === right[index].repository_branch_id
    && item.revision_id === right[index].revision_id);
}

async function event(
  transaction: GenerationPublicationTransaction,
  values: readonly [string, string, string, string, PublicationActorType, string, string, number],
): Promise<void> {
  const inserted = await transaction.execute(STATEMENTS.insertEvent, values);
  if (inserted.row_count !== 1) throw new GenerationPublicationError('write-mismatch');
}

export async function stageGeneration(
  database: GenerationPublicationDatabase,
  input: StageGenerationRequest,
): Promise<Readonly<StageGenerationReport>> {
  if (typeof database !== 'object' || database === null || typeof database.transaction !== 'function') invalid();
  const request = exactObject(input, ['project_id', 'revision_set_hash', 'revisions', 'actor']);
  if (!UUID.test(request.project_id as string) || !HASH.test(request.revision_set_hash as string)
      || !Array.isArray(request.revisions) || request.revisions.length < 1 || request.revisions.length > MAX_REVISIONS) invalid();
  const acting = actor(request.actor);
  const revisions = request.revisions.map((value) => {
    const item = exactObject(value, ['repository_branch_id', 'revision_id']);
    if (!UUID.test(item.repository_branch_id as string) || !UUID.test(item.revision_id as string)) invalid();
    return Object.freeze({ repository_branch_id: item.repository_branch_id as string, revision_id: item.revision_id as string });
  }).sort((left, right) => left.repository_branch_id.localeCompare(right.repository_branch_id, 'en'));
  if (new Set(revisions.map(({ repository_branch_id }) => repository_branch_id)).size !== revisions.length
      || new Set(revisions.map(({ revision_id }) => revision_id)).size !== revisions.length) invalid();
  const hash = requestHash({ action: 'stage', project_id: request.project_id, revision_set_hash: request.revision_set_hash, revisions });
  try {
    return await database.transaction(async (transaction) => {
      await lockedProject(transaction, request.project_id as string);
      const verified = await transaction.execute<RevisionRow>(STATEMENTS.validateRevisions, [request.project_id as string, JSON.stringify(revisions)]);
      if (verified.rows.some((row) => !UUID.test(row.repository_branch_id) || !UUID.test(row.revision_id) || !UUID.test(row.repository_id))
          || verified.rows.length !== revisions.length || !sameMappings(verified.rows, revisions)
          || new Set(verified.rows.map(({ repository_id }) => repository_id)).size !== revisions.length) {
        throw new GenerationPublicationError('revision-mismatch');
      }
      const existing = await transaction.execute<{ id: string; status: string; publication_version: string | number }>(
        STATEMENTS.loadGenerationByHash,
        [request.project_id as string, request.revision_set_hash as string],
      );
      if (existing.rows.length > 1) throw new GenerationPublicationError('transaction-failed');
      if (existing.rows.length === 1) {
        const row = existing.rows[0];
        const mappings = await transaction.execute<MappingRow>(STATEMENTS.loadRevisionMappings, [row.id]);
        if (!UUID.test(row.id) || mappings.rows.some((mapping) => !UUID.test(mapping.repository_branch_id) || !UUID.test(mapping.revision_id))
            || !['building', 'ready', 'active', 'superseded'].includes(row.status) || !sameMappings(mappings.rows, revisions)) {
          throw new GenerationPublicationError('generation-conflict');
        }
        return Object.freeze({
          generation_id: row.id,
          revision_set_hash: request.revision_set_hash as string,
          revision_count: revisions.length,
          publication_version: storedInteger(row.publication_version),
          already_staged: true,
        });
      }
      const inserted = await transaction.execute<{ id: string; status: string; publication_version: string | number }>(
        STATEMENTS.insertGeneration,
        [request.project_id as string, request.revision_set_hash as string],
      );
      if (inserted.rows.length !== 1) throw new GenerationPublicationError('write-mismatch');
      const generation = inserted.rows[0];
      if (!UUID.test(generation.id) || generation.status !== 'building') {
        throw new GenerationPublicationError('transaction-failed');
      }
      const mappings = await transaction.execute(STATEMENTS.insertRevisionMappings, [generation.id, JSON.stringify(revisions)]);
      if (mappings.row_count !== revisions.length) throw new GenerationPublicationError('write-mismatch');
      const version = storedInteger(generation.publication_version);
      await event(transaction, [request.project_id as string, generation.id, '', 'staged', acting.type, acting.id, hash, version]);
      return Object.freeze({
        generation_id: generation.id,
        revision_set_hash: request.revision_set_hash as string,
        revision_count: revisions.length,
        publication_version: version,
        already_staged: false,
      });
    });
  } catch (error) {
    if (error instanceof GenerationPublicationError) throw error;
    throw new GenerationPublicationError('transaction-failed');
  }
}

function completeMarker(state: GenerationRow): boolean {
  return state.symbols_imported_at !== null && HASH.test(state.symbol_plan_hash ?? '') && HASH.test(state.symbol_payload_hash ?? '')
    && state.symbol_count !== null && state.symbol_location_count !== null
    && state.relations_imported_at !== null && HASH.test(state.relation_plan_hash ?? '') && HASH.test(state.relation_payload_hash ?? '')
    && state.symbol_edge_count !== null && state.file_dependency_count !== null
    && state.chunks_imported_at !== null && HASH.test(state.chunk_plan_hash ?? '') && HASH.test(state.chunk_payload_hash ?? '')
    && state.code_chunk_count !== null;
}

function snapshotCounts(row: SnapshotRow): Record<keyof SnapshotRow, number> {
  return {
    revision_count: storedInteger(row.revision_count),
    repository_count: storedInteger(row.repository_count),
    invalid_revision_count: storedInteger(row.invalid_revision_count),
    file_count: storedInteger(row.file_count),
    invalid_file_count: storedInteger(row.invalid_file_count),
    invalid_module_count: storedInteger(row.invalid_module_count),
    symbol_count: storedInteger(row.symbol_count),
    symbol_location_count: storedInteger(row.symbol_location_count),
    invalid_symbol_count: storedInteger(row.invalid_symbol_count),
    symbol_edge_count: storedInteger(row.symbol_edge_count),
    invalid_symbol_edge_count: storedInteger(row.invalid_symbol_edge_count),
    file_dependency_count: storedInteger(row.file_dependency_count),
    invalid_file_dependency_count: storedInteger(row.invalid_file_dependency_count),
    code_chunk_count: storedInteger(row.code_chunk_count),
    invalid_code_chunk_count: storedInteger(row.invalid_code_chunk_count),
    embedding_count: storedInteger(row.embedding_count),
    invalid_embedding_count: storedInteger(row.invalid_embedding_count),
    unresolved_failure_count: storedInteger(row.unresolved_failure_count),
  };
}

function validateCompleteness(state: GenerationRow, snapshot: Record<keyof SnapshotRow, number>): void {
  if (!completeMarker(state) || snapshot.revision_count < 1 || snapshot.revision_count !== snapshot.repository_count
      || snapshot.invalid_revision_count !== 0 || snapshot.invalid_file_count !== 0 || snapshot.invalid_module_count !== 0
      || snapshot.invalid_symbol_count !== 0
      || snapshot.invalid_symbol_edge_count !== 0 || snapshot.invalid_file_dependency_count !== 0
      || snapshot.invalid_code_chunk_count !== 0 || snapshot.invalid_embedding_count !== 0
      || snapshot.unresolved_failure_count !== 0
      || storedInteger(state.symbol_count) !== snapshot.symbol_count
      || storedInteger(state.symbol_location_count) !== snapshot.symbol_location_count
      || storedInteger(state.symbol_edge_count) !== snapshot.symbol_edge_count
      || storedInteger(state.file_dependency_count) !== snapshot.file_dependency_count
      || storedInteger(state.code_chunk_count) !== snapshot.code_chunk_count
      || snapshot.embedding_count !== snapshot.code_chunk_count) {
    throw new GenerationPublicationError('generation-incomplete');
  }
}

export async function validateGeneration(
  database: GenerationPublicationDatabase,
  input: ValidateGenerationRequest,
): Promise<Readonly<ValidateGenerationReport>> {
  if (typeof database !== 'object' || database === null || typeof database.transaction !== 'function') invalid();
  const request = exactObject(input, ['project_id', 'generation_id', 'manifest_uri', 'manifest_hash', 'embedding_profile', 'expected_publication_version', 'actor']);
  if (!UUID.test(request.project_id as string) || !UUID.test(request.generation_id as string) || !HASH.test(request.manifest_hash as string)) invalid();
  const manifestUri = safeManifestUri(request.manifest_uri);
  const embeddingProfile = profile(request.embedding_profile);
  const expectedVersion = integer(request.expected_publication_version ?? 0, 0, Number.MAX_SAFE_INTEGER);
  const acting = actor(request.actor);
  try {
    return await database.transaction(async (transaction) => {
      await lockedProject(transaction, request.project_id as string);
      const generation = await transaction.execute<GenerationRow>(STATEMENTS.lockGeneration, [request.generation_id as string, request.project_id as string]);
      if (generation.rows.length !== 1) throw new GenerationPublicationError('generation-not-found');
      const state = generation.rows[0];
      const validatedState = ['ready', 'active', 'superseded'].includes(state.status);
      if (!validatedState && state.status !== 'building') throw new GenerationPublicationError('generation-not-building');
      if (validatedState) {
        if (state.manifest_uri !== manifestUri || state.manifest_hash !== request.manifest_hash
            || state.embedding_provider !== embeddingProfile.provider || state.embedding_model !== embeddingProfile.model
            || storedInteger(state.embedding_dimensions) !== embeddingProfile.dimensions || !HASH.test(state.validation_hash ?? '')) {
          throw new GenerationPublicationError('validation-conflict');
        }
      }
      if (!validatedState && storedInteger(state.publication_version) !== expectedVersion) {
        throw new GenerationPublicationError('publication-conflict');
      }
      const snapshotResult = await transaction.execute<SnapshotRow>(STATEMENTS.loadSnapshot, [
        request.generation_id as string,
        request.project_id as string,
        embeddingProfile.provider,
        embeddingProfile.model,
        embeddingProfile.dimensions,
      ]);
      if (snapshotResult.rows.length !== 1) throw new GenerationPublicationError('transaction-failed');
      const snapshot = snapshotCounts(snapshotResult.rows[0]);
      validateCompleteness(state, snapshot);
      if (validatedState) {
        if (storedInteger(state.embedding_count) !== snapshot.embedding_count) {
          throw new GenerationPublicationError('generation-incomplete');
        }
        return Object.freeze({
          generation_id: state.id,
          validation_hash: state.validation_hash as string,
          publication_version: storedInteger(state.publication_version),
          counts: Object.freeze({
            revisions: snapshot.revision_count, files: snapshot.file_count, symbols: snapshot.symbol_count,
            symbol_locations: snapshot.symbol_location_count, symbol_edges: snapshot.symbol_edge_count,
            file_dependencies: snapshot.file_dependency_count, code_chunks: snapshot.code_chunk_count,
            embeddings: snapshot.embedding_count,
          }),
          already_validated: true,
        });
      }
      const validationHash = requestHash({
        action: 'validate', project_id: request.project_id, generation_id: state.id,
        revision_set_hash: state.revision_set_hash, manifest_uri: manifestUri, manifest_hash: request.manifest_hash,
        embedding_profile: embeddingProfile,
        markers: {
          symbol_plan_hash: state.symbol_plan_hash, symbol_payload_hash: state.symbol_payload_hash,
          relation_plan_hash: state.relation_plan_hash, relation_payload_hash: state.relation_payload_hash,
          chunk_plan_hash: state.chunk_plan_hash, chunk_payload_hash: state.chunk_payload_hash,
        },
        snapshot,
      });
      const updated = await transaction.execute<VersionRow>(STATEMENTS.markReady, [
        state.id, request.project_id as string, manifestUri, request.manifest_hash as string, validationHash,
        embeddingProfile.provider, embeddingProfile.model, embeddingProfile.dimensions, snapshot.embedding_count, expectedVersion,
      ]);
      if (updated.rows.length !== 1) throw new GenerationPublicationError('write-mismatch');
      const version = storedInteger(updated.rows[0].publication_version);
      const hash = requestHash({ action: 'validated', project_id: request.project_id, generation_id: state.id, validation_hash: validationHash });
      await event(transaction, [request.project_id as string, state.id, '', 'validated', acting.type, acting.id, hash, version]);
      return Object.freeze({
        generation_id: state.id,
        validation_hash: validationHash,
        publication_version: version,
        counts: Object.freeze({
          revisions: snapshot.revision_count, files: snapshot.file_count, symbols: snapshot.symbol_count,
          symbol_locations: snapshot.symbol_location_count, symbol_edges: snapshot.symbol_edge_count,
          file_dependencies: snapshot.file_dependency_count, code_chunks: snapshot.code_chunk_count,
          embeddings: snapshot.embedding_count,
        }),
        already_validated: false,
      });
    });
  } catch (error) {
    if (error instanceof GenerationPublicationError && error.code === 'generation-incomplete') {
      try {
        await database.transaction(async (transaction) => {
          await lockedProject(transaction, request.project_id as string);
          const quarantined = await transaction.execute<VersionRow>(STATEMENTS.quarantineInvalid, [
            request.generation_id as string, request.project_id as string, expectedVersion,
          ]);
          if (quarantined.rows.length !== 1) throw new GenerationPublicationError('write-mismatch');
          const version = storedInteger(quarantined.rows[0].publication_version);
          const hash = requestHash({ action: 'validation_failed', project_id: request.project_id,
            generation_id: request.generation_id, expected_version: expectedVersion });
          await event(transaction, [request.project_id as string, request.generation_id as string, '',
            'validation_failed', acting.type, acting.id, hash, version]);
        });
      } catch {
        throw new GenerationPublicationError('transaction-failed');
      }
      throw error;
    }
    if (error instanceof GenerationPublicationError) throw error;
    throw new GenerationPublicationError('transaction-failed');
  }
}

export async function publishGeneration(
  database: GenerationPublicationDatabase,
  input: PublishGenerationRequest,
): Promise<Readonly<PublishGenerationReport>> {
  if (typeof database !== 'object' || database === null || typeof database.transaction !== 'function') invalid();
  const request = exactObject(input, ['project_id', 'generation_id', 'validation_hash', 'expected_publication_version', 'actor']);
  if (!UUID.test(request.project_id as string) || !UUID.test(request.generation_id as string) || !HASH.test(request.validation_hash as string)) invalid();
  const expectedVersion = integer(request.expected_publication_version, 0, Number.MAX_SAFE_INTEGER);
  const acting = actor(request.actor);
  try {
    return await database.transaction(async (transaction) => {
      await lockedProject(transaction, request.project_id as string);
      const targetResult = await transaction.execute<GenerationRow>(STATEMENTS.lockGeneration, [request.generation_id as string, request.project_id as string]);
      if (targetResult.rows.length !== 1) throw new GenerationPublicationError('generation-not-found');
      const target = targetResult.rows[0];
      if (target.validation_hash !== request.validation_hash) throw new GenerationPublicationError('validation-conflict');
      if (target.status === 'active') {
        return Object.freeze({
          generation_id: target.id,
          previous_active_generation_id: null,
          publication_version: storedInteger(target.publication_version),
          already_active: true,
        });
      }
      if (target.status !== 'ready') throw new GenerationPublicationError('generation-not-ready');
      if (storedInteger(target.publication_version) !== expectedVersion) throw new GenerationPublicationError('publication-conflict');
      const activeResult = await transaction.execute<GenerationRow>(STATEMENTS.loadActive, [request.project_id as string]);
      if (activeResult.rows.length > 1) throw new GenerationPublicationError('transaction-failed');
      const previous = activeResult.rows[0];
      if (previous !== undefined) {
        const superseded = await transaction.execute(STATEMENTS.supersedeActive, [
          previous.id, request.project_id as string, storedInteger(previous.publication_version),
        ]);
        if (superseded.row_count !== 1) throw new GenerationPublicationError('write-mismatch');
      }
      const activated = await transaction.execute<VersionRow>(STATEMENTS.activateReady, [
        target.id, request.project_id as string, request.validation_hash as string, expectedVersion,
      ]);
      if (activated.rows.length !== 1) throw new GenerationPublicationError('write-mismatch');
      const version = storedInteger(activated.rows[0].publication_version);
      const hash = requestHash({ action: 'publish', project_id: request.project_id, generation_id: target.id, validation_hash: request.validation_hash, expected_version: expectedVersion });
      await event(transaction, [request.project_id as string, target.id, previous?.id ?? '', 'published', acting.type, acting.id, hash, version]);
      return Object.freeze({
        generation_id: target.id,
        previous_active_generation_id: previous?.id ?? null,
        publication_version: version,
        already_active: false,
      });
    });
  } catch (error) {
    if (error instanceof GenerationPublicationError) throw error;
    throw new GenerationPublicationError('transaction-failed');
  }
}

export async function rollbackGeneration(
  database: GenerationPublicationDatabase,
  input: RollbackGenerationRequest,
): Promise<Readonly<RollbackGenerationReport>> {
  if (typeof database !== 'object' || database === null || typeof database.transaction !== 'function') invalid();
  const request = exactObject(input, ['project_id', 'target_generation_id', 'expected_target_version', 'expected_active_generation_id', 'actor']);
  if (!UUID.test(request.project_id as string) || !UUID.test(request.target_generation_id as string)
      || (request.expected_active_generation_id !== undefined && !UUID.test(request.expected_active_generation_id as string))) invalid();
  const targetVersion = integer(request.expected_target_version, 0, Number.MAX_SAFE_INTEGER);
  const acting = actor(request.actor);
  try {
    return await database.transaction(async (transaction) => {
      await lockedProject(transaction, request.project_id as string);
      const targetResult = await transaction.execute<GenerationRow>(STATEMENTS.lockGeneration, [request.target_generation_id as string, request.project_id as string]);
      if (targetResult.rows.length !== 1) throw new GenerationPublicationError('generation-not-found');
      const target = targetResult.rows[0];
      if (target.status === 'active') {
        return Object.freeze({ generation_id: target.id, superseded_generation_id: null,
          publication_version: storedInteger(target.publication_version), already_active: true });
      }
      if (target.status !== 'superseded' || target.validated_at === null) {
        throw new GenerationPublicationError('generation-not-superseded');
      }
      if (target.gc_claimed_at !== null) throw new GenerationPublicationError('generation-gc-claimed');
      if (storedInteger(target.publication_version) !== targetVersion) throw new GenerationPublicationError('publication-conflict');
      const activeResult = await transaction.execute<GenerationRow>(STATEMENTS.loadActive, [request.project_id as string]);
      if (activeResult.rows.length !== 1) throw new GenerationPublicationError('active-generation-mismatch');
      const active = activeResult.rows[0];
      if (request.expected_active_generation_id !== undefined && active.id !== request.expected_active_generation_id) {
        throw new GenerationPublicationError('active-generation-mismatch');
      }
      const superseded = await transaction.execute(STATEMENTS.supersedeActive, [
        active.id, request.project_id as string, storedInteger(active.publication_version),
      ]);
      if (superseded.row_count !== 1) throw new GenerationPublicationError('write-mismatch');
      const activated = await transaction.execute<VersionRow>(STATEMENTS.activateRollback, [
        target.id, request.project_id as string, targetVersion,
      ]);
      if (activated.rows.length !== 1) throw new GenerationPublicationError('write-mismatch');
      const version = storedInteger(activated.rows[0].publication_version);
      const hash = requestHash({ action: 'rollback', project_id: request.project_id, target_generation_id: target.id,
        active_generation_id: active.id, expected_target_version: targetVersion });
      await event(transaction, [request.project_id as string, target.id, active.id, 'rolled_back', acting.type, acting.id, hash, version]);
      return Object.freeze({ generation_id: target.id, superseded_generation_id: active.id,
        publication_version: version, already_active: false });
    });
  } catch (error) {
    if (error instanceof GenerationPublicationError) throw error;
    throw new GenerationPublicationError('transaction-failed');
  }
}

export async function garbageCollectGenerations(
  database: GenerationPublicationDatabase,
  input: GarbageCollectGenerationsRequest,
  artifactStore?: GenerationArtifactStore,
): Promise<Readonly<GarbageCollectGenerationsReport>> {
  if (typeof database !== 'object' || database === null || typeof database.transaction !== 'function') invalid();
  const request = exactObject(input, ['project_id', 'operation_id', 'retention_days', 'retain_recent', 'limit', 'execute', 'actor']);
  if (!UUID.test(request.project_id as string) || (request.execute !== undefined && typeof request.execute !== 'boolean')) invalid();
  const retentionDays = integer(request.retention_days ?? 7, 7, 3650);
  const retainRecent = integer(request.retain_recent ?? 2, 2, 100);
  const limit = integer(request.limit ?? 50, 1, 100);
  const execute = request.execute ?? false;
  if (execute && (!UUID.test(request.operation_id as string) || typeof artifactStore !== 'object'
      || artifactStore === null || typeof artifactStore.deleteManifest !== 'function')) invalid();
  if (!execute && request.operation_id !== undefined && !UUID.test(request.operation_id as string)) invalid();
  const acting = actor(request.actor);
  const claimHash = requestHash({ action: 'gc-claim', project_id: request.project_id,
    operation_id: request.operation_id ?? 'preview', retention_days: retentionDays, retain_recent: retainRecent, limit });
  try {
    const claimed = await database.transaction(async (transaction) => {
      await lockedProject(transaction, request.project_id as string);
      const candidates = await transaction.execute<GcRow>(STATEMENTS.gcCandidates, [
        request.project_id as string, retentionDays, retainRecent, limit, claimHash,
      ]);
      const ids = candidates.rows.map((candidate) => {
        if (!UUID.test(candidate.id) || !['superseded', 'failed'].includes(candidate.status)
            || (candidate.manifest_uri === null) !== (candidate.manifest_hash === null)
            || (candidate.manifest_uri !== null && (!HASH.test(candidate.manifest_hash ?? '')
              || storedManifestUri(candidate.manifest_uri) !== candidate.manifest_uri))) {
          throw new GenerationPublicationError('transaction-failed');
        }
        storedInteger(candidate.publication_version);
        return candidate.id;
      });
      if (new Set(ids).size !== ids.length || ids.length > limit) throw new GenerationPublicationError('transaction-failed');
      if (!execute) return Object.freeze([...candidates.rows]);
      const result: GcRow[] = [];
      for (const candidate of candidates.rows) {
        const locked = await transaction.execute<GcRow>(STATEMENTS.claimGcCandidate, [
          candidate.id, request.project_id as string, storedInteger(candidate.publication_version), claimHash,
        ]);
        if (locked.rows.length !== 1) throw new GenerationPublicationError('write-mismatch');
        const row = locked.rows[0];
        const version = storedInteger(row.publication_version);
        await event(transaction, [request.project_id as string, row.id, '', 'gc_claimed', acting.type, acting.id, claimHash, version]);
        result.push(row);
      }
      return Object.freeze(result);
    });
    const ids = claimed.map(({ id }) => id);
    if (!execute) return Object.freeze({ candidate_generation_ids: Object.freeze(ids), deleted_generation_ids: Object.freeze([]), retention_days: retentionDays, retain_recent: retainRecent });

    const receipts: { generation_id: string; receipt_hash: string }[] = [];
    for (const candidate of claimed) {
      if (candidate.manifest_uri === null || candidate.manifest_hash === null) continue;
      const idempotencyKey = requestHash({ action: 'gc-artifact-delete', operation_id: request.operation_id,
        generation_id: candidate.id, manifest_hash: candidate.manifest_hash });
      const receipt = await artifactStore!.deleteManifest(Object.freeze({
        operation_id: request.operation_id as string,
        generation_id: candidate.id,
        manifest_uri: candidate.manifest_uri,
        manifest_hash: candidate.manifest_hash,
        idempotency_key: idempotencyKey,
      }));
      if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)
          || Object.keys(receipt).some((key) => key !== 'receipt_hash') || !HASH.test(receipt.receipt_hash)) {
        throw new GenerationPublicationError('transaction-failed');
      }
      receipts.push({ generation_id: candidate.id, receipt_hash: receipt.receipt_hash });
    }
    const auditHash = requestHash({ action: 'gc-delete', project_id: request.project_id,
      operation_id: request.operation_id, claim_hash: claimHash, receipts });
    const deleted = await database.transaction(async (transaction) => {
      await lockedProject(transaction, request.project_id as string);
      const result: string[] = [];
      for (const candidate of claimed) {
        const version = storedInteger(candidate.publication_version);
        await event(transaction, [request.project_id as string, candidate.id, '', 'gc_deleted', acting.type, acting.id, auditHash, version]);
        const removed = await transaction.execute(STATEMENTS.deleteGcCandidate, [
          candidate.id, request.project_id as string, version, claimHash,
        ]);
        if (removed.row_count !== 1) throw new GenerationPublicationError('write-mismatch');
        result.push(candidate.id);
      }
      return Object.freeze(result);
    });
    return Object.freeze({ candidate_generation_ids: Object.freeze(ids), deleted_generation_ids: deleted,
      retention_days: retentionDays, retain_recent: retainRecent });
  } catch (error) {
    if (error instanceof GenerationPublicationError) throw error;
    throw new GenerationPublicationError('transaction-failed');
  }
}
