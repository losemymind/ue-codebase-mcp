import {
  type AgentEventRequest,
  type AgentJobPayload,
  type ClaimJobsRequest,
  type ClaimedJob,
  type Clock,
  type CompleteJobRequest,
  type FailJobRequest,
  type FencedOperationResponse,
  type HeartbeatRequest,
  type RegisterAgentRequest,
  type RegisterAgentResponse,
  validateCompletionManifest,
  validateJobPayload,
} from '../../../workers/windows-agent/src/contracts.ts';

export interface JobLeaseStatement { readonly name: string; readonly text: string }
export interface JobLeaseResult<Row> { readonly rows: readonly Row[]; readonly row_count: number }
export interface JobLeaseTransaction {
  execute<Row>(statement: JobLeaseStatement, values: readonly (string | number | boolean)[]): Promise<JobLeaseResult<Row>>;
}
export interface JobLeaseDatabase {
  transaction<Result>(operation: (transaction: JobLeaseTransaction) => Promise<Result>): Promise<Result>;
}
export interface AuthenticatedAgent { readonly agent_id: string }

export type DurableJobLeaseErrorCode = 'invalid-request' | 'agent-disabled' | 'payload-invalid' | 'database-failed';

export class DurableJobLeaseError extends Error {
  readonly code: DurableJobLeaseErrorCode;

  constructor(code: DurableJobLeaseErrorCode) {
    super(`durable job lease ${code}`);
    this.name = 'DurableJobLeaseError';
    this.code = code;
  }
}

interface AgentRow { id: string; status: string; registered_at: string }
interface CandidateRow { job_id: string; agent_payload: unknown; next_event_sequence: string | number }
interface ClaimRow extends CandidateRow { attempt: string | number; lease_token: string; lease_expires_at: string }
interface LeaseExpiryRow { lease_expires_at: string }
interface EventStateRow {
  active: boolean;
  next_event_sequence: string | number;
  level: string | null;
  event_type: string | null;
  redacted_payload: unknown;
}
interface CompletionStateRow { status: string; agent_id: string | null; completion_attempt: string | number | null; completion_manifest: unknown }
interface FailureStateRow {
  status: string;
  agent_id: string | null;
  last_failure_attempt: string | number | null;
  last_error_code: string | null;
  last_error_retryable: boolean | null;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const EVENT_TYPE = /^[a-z][a-z0-9_.]{0,127}$/;
const PHASE = /^[a-z][a-z0-9_.-]{0,63}$/;
const MAX_POLL_MS = 250;
const DIAGNOSTIC_BY_CODE = Object.freeze({
  DEPENDENCY_UNAVAILABLE: 'dependency unavailable',
  INVALID_SOURCE_INPUT: 'invalid source input',
  RESOURCE_LIMIT: 'resource limit exceeded',
  UNHANDLED_AGENT_FAILURE: 'job handler failed; inspect protected local diagnostics',
} as const);

const STATEMENTS = Object.freeze({
  register: Object.freeze({
    name: 'job-lease-register-agent-v2',
    text: `INSERT INTO ue_mcp.agents (agent_key, version, capabilities, last_heartbeat_at, status)
      VALUES ($1, $2, $3::jsonb, clock_timestamp(), 'online')
      ON CONFLICT (agent_key) DO UPDATE SET version = EXCLUDED.version, capabilities = EXCLUDED.capabilities,
        last_heartbeat_at = clock_timestamp(), status = 'online'
      WHERE ue_mcp.agents.status IN ('online', 'offline')
      RETURNING id::text, status,
        to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS registered_at`,
  }),
  recover: Object.freeze({
    name: 'job-lease-recover-expired-v2',
    text: `WITH expired AS (
        SELECT id FROM ue_mcp.jobs WHERE status = 'running' AND lease_expires_at <= clock_timestamp()
        ORDER BY lease_expires_at, id FOR UPDATE SKIP LOCKED LIMIT 1000
      )
      UPDATE ue_mcp.jobs job SET
        status = CASE WHEN job.attempt < job.max_attempts THEN 'queued' ELSE 'failed' END,
        available_at = CASE WHEN job.attempt < job.max_attempts
          THEN clock_timestamp() + ($1::integer * interval '1 millisecond') ELSE job.available_at END,
        started_at = CASE WHEN job.attempt < job.max_attempts THEN NULL ELSE job.started_at END,
        finished_at = CASE WHEN job.attempt < job.max_attempts THEN NULL ELSE clock_timestamp() END,
        lease_agent_id = NULL, lease_token = NULL, lease_expires_at = NULL,
        last_error_code = 'LEASE_EXPIRED', last_error_retryable = (job.attempt < job.max_attempts),
        last_failure_agent_id = job.lease_agent_id, last_failure_attempt = job.attempt
      FROM expired WHERE job.id = expired.id RETURNING job.id::text`,
  }),
  selectCandidate: Object.freeze({
    name: 'job-lease-select-candidate-v2',
    text: `SELECT job.id::text AS job_id, job.agent_payload, job.next_event_sequence
      FROM ue_mcp.jobs job
      JOIN ue_mcp.agents agent ON agent.agent_key = $1 AND agent.status = 'online'
        AND agent.capabilities @> '{"svn-sync":true,"clang-index":true,"module-index":true}'::jsonb
      WHERE job.status = 'queued' AND job.type = 'reindex' AND job.available_at <= clock_timestamp()
        AND job.cancellation_requested_at IS NULL AND job.agent_payload IS NOT NULL
      ORDER BY job.priority DESC, job.available_at, job.requested_at, job.id
      FOR UPDATE OF job SKIP LOCKED LIMIT 1`,
  }),
  activeClaim: Object.freeze({
    name: 'job-lease-select-active-v2',
    text: `SELECT job.id::text AS job_id, job.agent_payload, job.next_event_sequence,
        job.attempt, job.lease_token::text,
        to_char(job.lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS lease_expires_at
      FROM ue_mcp.jobs job JOIN ue_mcp.agents agent ON agent.id = job.lease_agent_id
      WHERE agent.agent_key = $1 AND agent.status = 'online' AND job.status = 'running'
        AND job.lease_token IS NOT NULL AND job.lease_expires_at > clock_timestamp()
        AND job.agent_payload IS NOT NULL
      ORDER BY job.started_at, job.id FOR UPDATE OF job LIMIT 1`,
  }),
  claim: Object.freeze({
    name: 'job-lease-claim-v2',
    text: `UPDATE ue_mcp.jobs job SET status = 'running', attempt = attempt + 1,
        lease_agent_id = agent.id, lease_token = gen_random_uuid(),
        lease_expires_at = clock_timestamp() + ($3::integer * interval '1 millisecond'),
        started_at = clock_timestamp(), finished_at = NULL
      FROM ue_mcp.agents agent
      WHERE job.id = $1::uuid AND agent.agent_key = $2 AND agent.status = 'online'
        AND agent.capabilities @> '{"svn-sync":true,"clang-index":true,"module-index":true}'::jsonb
        AND job.status = 'queued' AND job.available_at <= clock_timestamp()
        AND job.cancellation_requested_at IS NULL AND job.agent_payload IS NOT NULL
      RETURNING job.id::text AS job_id, job.agent_payload, job.next_event_sequence,
        job.attempt, job.lease_token::text,
        to_char(job.lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS lease_expires_at`,
  }),
  heartbeat: Object.freeze({
    name: 'job-lease-heartbeat-v2',
    text: `WITH current_agent AS (
        UPDATE ue_mcp.agents SET last_heartbeat_at = clock_timestamp()
        WHERE agent_key = $2 AND status = 'online' RETURNING id
      )
      UPDATE ue_mcp.jobs job SET lease_expires_at = clock_timestamp() + ($5::integer * interval '1 millisecond')
      FROM current_agent agent
      WHERE job.id = $1::uuid AND job.lease_agent_id = agent.id AND job.attempt = $3::integer
        AND job.lease_token = $4::uuid AND job.status = 'running' AND job.lease_expires_at > clock_timestamp()
      RETURNING to_char(job.lease_expires_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS lease_expires_at`,
  }),
  appendEvent: Object.freeze({
    name: 'job-lease-append-event-v2',
    text: `WITH active AS (
        SELECT job.id FROM ue_mcp.jobs job JOIN ue_mcp.agents agent ON agent.id = job.lease_agent_id
        WHERE job.id = $1::uuid AND agent.agent_key = $2 AND job.attempt = $3::integer
          AND job.lease_token = $4::uuid AND job.status = 'running'
          AND job.lease_expires_at > clock_timestamp() AND job.next_event_sequence = $5::bigint
        FOR UPDATE OF job
      ), inserted AS (
        INSERT INTO ue_mcp.job_events (job_id, sequence, level, event_type, redacted_payload)
        SELECT id, $5::bigint, $6, $7, $8::jsonb FROM active
        ON CONFLICT DO NOTHING RETURNING job_id
      )
      UPDATE ue_mcp.jobs job SET next_event_sequence = next_event_sequence + 1
      FROM inserted WHERE job.id = inserted.job_id RETURNING job.next_event_sequence`,
  }),
  eventState: Object.freeze({
    name: 'job-lease-event-state-v2',
    text: `SELECT (job.status = 'running' AND agent.agent_key = $2 AND job.attempt = $3::integer
          AND job.lease_token = $4::uuid AND job.lease_expires_at > clock_timestamp()) AS active,
        job.next_event_sequence, event.level, event.event_type, event.redacted_payload
      FROM ue_mcp.jobs job
      LEFT JOIN ue_mcp.agents agent ON agent.id = job.lease_agent_id
      LEFT JOIN ue_mcp.job_events event ON event.job_id = job.id AND event.sequence = $5::bigint
      WHERE job.id = $1::uuid`,
  }),
  complete: Object.freeze({
    name: 'job-lease-complete-v2',
    text: `UPDATE ue_mcp.jobs job SET status = 'succeeded', completion_manifest = $5::jsonb,
        completion_agent_id = agent.id, completion_attempt = job.attempt, finished_at = clock_timestamp(),
        lease_agent_id = NULL, lease_token = NULL, lease_expires_at = NULL
      FROM ue_mcp.agents agent
      WHERE job.id = $1::uuid AND agent.agent_key = $2 AND job.lease_agent_id = agent.id
        AND job.attempt = $3::integer AND job.lease_token = $4::uuid AND job.status = 'running'
        AND job.lease_expires_at > clock_timestamp()
        AND job.agent_payload->'revision_set'->>'hash' = $6
      RETURNING job.id::text`,
  }),
  completionState: Object.freeze({
    name: 'job-lease-completion-state-v2',
    text: `SELECT job.status, agent.agent_key AS agent_id, job.completion_attempt, job.completion_manifest
      FROM ue_mcp.jobs job LEFT JOIN ue_mcp.agents agent ON agent.id = job.completion_agent_id
      WHERE job.id = $1::uuid`,
  }),
  fail: Object.freeze({
    name: 'job-lease-fail-v2',
    text: `UPDATE ue_mcp.jobs job SET
        status = CASE WHEN $6::boolean AND job.attempt < job.max_attempts THEN 'queued' ELSE 'failed' END,
        available_at = CASE WHEN $6::boolean AND job.attempt < job.max_attempts
          THEN clock_timestamp() + ($7::integer * interval '1 millisecond') ELSE job.available_at END,
        started_at = CASE WHEN $6::boolean AND job.attempt < job.max_attempts THEN NULL ELSE job.started_at END,
        finished_at = CASE WHEN $6::boolean AND job.attempt < job.max_attempts THEN NULL ELSE clock_timestamp() END,
        lease_agent_id = NULL, lease_token = NULL, lease_expires_at = NULL,
        last_error_code = $5, last_error_retryable = $6,
        last_failure_agent_id = agent.id, last_failure_attempt = job.attempt
      FROM ue_mcp.agents agent
      WHERE job.id = $1::uuid AND agent.agent_key = $2 AND job.lease_agent_id = agent.id
        AND job.attempt = $3::integer AND job.lease_token = $4::uuid AND job.status = 'running'
        AND job.lease_expires_at > clock_timestamp()
      RETURNING job.status`,
  }),
  failureState: Object.freeze({
    name: 'job-lease-failure-state-v2',
    text: `SELECT job.status, agent.agent_key AS agent_id, job.last_failure_attempt,
        job.last_error_code, job.last_error_retryable
      FROM ue_mcp.jobs job LEFT JOIN ue_mcp.agents agent ON agent.id = job.last_failure_agent_id
      WHERE job.id = $1::uuid`,
  }),
});

function invalid(): never { throw new DurableJobLeaseError('invalid-request'); }

function exactFields(value: unknown, allowed: readonly string[]): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}

function safeInteger(value: unknown, minimum: number, maximum: number): number {
  const parsed = typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < minimum || (parsed as number) > maximum) invalid();
  return parsed as number;
}

function storedInteger(value: unknown, minimum: number, maximum: number): number {
  try { return safeInteger(value, minimum, maximum); } catch { throw new DurableJobLeaseError('database-failed'); }
}

function utc(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || Number.isNaN(Date.parse(value))) throw new DurableJobLeaseError('database-failed');
  return new Date(value).toISOString();
}

function exactIdentity(identity: AuthenticatedAgent, agentId: string): void {
  if (typeof identity !== 'object' || identity === null || !AGENT_ID.test(identity.agent_id)
      || identity.agent_id !== agentId) invalid();
}

function leaseRequest(request: { job_id: string; agent_id: string; attempt: number; lease_token: string; lease_expires_at: string }): void {
  if (!UUID.test(request.job_id) || !AGENT_ID.test(request.agent_id) || !Number.isInteger(request.attempt)
      || request.attempt < 1 || request.attempt > 100 || !UUID.test(request.lease_token)
      || typeof request.lease_expires_at !== 'string' || Number.isNaN(Date.parse(request.lease_expires_at))) invalid();
}

function parsePayload(value: unknown): AgentJobPayload {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > 1024 * 1024) throw new Error('oversized');
    return validateJobPayload(parsed);
  } catch {
    throw new DurableJobLeaseError('payload-invalid');
  }
}

function claimedJob(row: ClaimRow, agentId: string, payload: AgentJobPayload): ClaimedJob {
  if (!UUID.test(row.job_id) || !UUID.test(row.lease_token)) throw new DurableJobLeaseError('database-failed');
  return Object.freeze({
    lease: Object.freeze({ job_id: row.job_id, agent_id: agentId,
      attempt: storedInteger(row.attempt, 1, 100), lease_token: row.lease_token,
      lease_expires_at: utc(row.lease_expires_at) }),
    payload,
    next_event_sequence: storedInteger(row.next_event_sequence, 0, Number.MAX_SAFE_INTEGER),
  });
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalJson(item)]));
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function registration(request: RegisterAgentRequest): void {
  exactFields(request, ['schema', 'version', 'agent_id', 'agent_version', 'ue_version', 'vcs', 'capabilities']);
  if (request.schema !== 'ue-codebase-mcp/agent-register' || request.version !== 2 || !AGENT_ID.test(request.agent_id)
      || !VERSION.test(request.agent_version) || request.ue_version !== '5.6' || !Array.isArray(request.vcs)
      || request.vcs.length !== 1 || request.vcs[0] !== 'svn' || !Array.isArray(request.capabilities)
      || request.capabilities.length < 1 || request.capabilities.length > 3
      || new Set(request.capabilities).size !== request.capabilities.length
      || request.capabilities.some((value) => !['svn-sync', 'clang-index', 'module-index'].includes(value))) invalid();
}

function claimRequest(request: ClaimJobsRequest): void {
  exactFields(request, ['schema', 'version', 'agent_id', 'supported_kinds', 'wait_ms']);
  if (request.schema !== 'ue-codebase-mcp/job-claim' || request.version !== 2 || !AGENT_ID.test(request.agent_id)
      || request.supported_kinds.length !== 1 || request.supported_kinds[0] !== 'reindex'
      || !Number.isInteger(request.wait_ms) || request.wait_ms < 0 || request.wait_ms > 60_000) invalid();
}

function eventFields(request: AgentEventRequest): string {
  if (!['debug', 'info', 'warning', 'error'].includes(request.level) || !EVENT_TYPE.test(request.event_type)
      || !Number.isSafeInteger(request.sequence) || request.sequence < 0 || typeof request.fields !== 'object'
      || request.fields === null || Array.isArray(request.fields)) invalid();
  const keys = Object.keys(request.fields);
  if (keys.some((key) => !['phase', 'progress_percent', 'item_count'].includes(key))
      || (request.fields.phase !== undefined && !PHASE.test(request.fields.phase))
      || (request.fields.progress_percent !== undefined && (!Number.isInteger(request.fields.progress_percent)
        || request.fields.progress_percent < 0 || request.fields.progress_percent > 100))
      || (request.fields.item_count !== undefined && (!Number.isSafeInteger(request.fields.item_count) || request.fields.item_count < 0))) invalid();
  return JSON.stringify(request.fields);
}

export class DurableJobLeaseService {
  readonly #database: JobLeaseDatabase;
  readonly #clock: Clock;
  readonly #leaseDurationMs: number;
  readonly #retryDelayMs: number;

  constructor(database: JobLeaseDatabase, options: { clock: Clock; lease_duration_ms?: number; retry_delay_ms?: number }) {
    if (typeof database !== 'object' || database === null || typeof database.transaction !== 'function'
        || typeof options !== 'object' || options === null || typeof options.clock !== 'object'
        || options.clock === null || typeof options.clock.now !== 'function' || typeof options.clock.sleep !== 'function') invalid();
    this.#database = database;
    this.#clock = options.clock;
    this.#leaseDurationMs = options.lease_duration_ms ?? 30_000;
    this.#retryDelayMs = options.retry_delay_ms ?? 1_000;
    if (!Number.isInteger(this.#leaseDurationMs) || this.#leaseDurationMs < 1_000 || this.#leaseDurationMs > 300_000
        || !Number.isInteger(this.#retryDelayMs) || this.#retryDelayMs < 0 || this.#retryDelayMs > 300_000) invalid();
  }

  async #transaction<Result>(operation: (transaction: JobLeaseTransaction) => Promise<Result>): Promise<Result> {
    try { return await this.#database.transaction(operation); } catch (error) {
      if (error instanceof DurableJobLeaseError) throw error;
      throw new DurableJobLeaseError('database-failed');
    }
  }

  async register(request: RegisterAgentRequest, identity: AuthenticatedAgent): Promise<RegisterAgentResponse> {
    registration(request);
    exactIdentity(identity, request.agent_id);
    const capabilities = JSON.stringify(Object.fromEntries(request.capabilities.map((name) => [name, true])));
    const result = await this.#transaction((transaction) => transaction.execute<AgentRow>(STATEMENTS.register,
      [request.agent_id, request.agent_version, capabilities]));
    if (result.row_count !== 1 || result.rows.length !== 1 || !UUID.test(result.rows[0].id) || result.rows[0].status !== 'online') {
      throw new DurableJobLeaseError('agent-disabled');
    }
    return Object.freeze({ accepted: true, registered_at: utc(result.rows[0].registered_at) });
  }

  async recoverExpiredLeases(): Promise<number> {
    const result = await this.#transaction((transaction) => transaction.execute(STATEMENTS.recover, [this.#retryDelayMs]));
    if (!Number.isSafeInteger(result.row_count) || result.row_count < 0 || result.row_count > 1000) throw new DurableJobLeaseError('database-failed');
    return result.row_count;
  }

  async #claimOnce(agentId: string): Promise<ClaimedJob | null> {
    return this.#transaction(async (transaction) => {
      const recovered = await transaction.execute(STATEMENTS.recover, [this.#retryDelayMs]);
      if (!Number.isSafeInteger(recovered.row_count) || recovered.row_count < 0 || recovered.row_count > 1000) {
        throw new DurableJobLeaseError('database-failed');
      }
      const active = await transaction.execute<ClaimRow>(STATEMENTS.activeClaim, [agentId]);
      if (active.row_count === 1 && active.rows.length === 1) {
        return claimedJob(active.rows[0], agentId, parsePayload(active.rows[0].agent_payload));
      }
      if (active.row_count !== 0 || active.rows.length !== 0) throw new DurableJobLeaseError('database-failed');
      const selected = await transaction.execute<CandidateRow>(STATEMENTS.selectCandidate, [agentId]);
      if (selected.row_count === 0 && selected.rows.length === 0) return null;
      if (selected.row_count !== 1 || selected.rows.length !== 1) throw new DurableJobLeaseError('database-failed');
      if (!UUID.test(selected.rows[0].job_id)) throw new DurableJobLeaseError('database-failed');
      const payload = parsePayload(selected.rows[0].agent_payload);
      const claimed = await transaction.execute<ClaimRow>(STATEMENTS.claim,
        [selected.rows[0].job_id, agentId, this.#leaseDurationMs]);
      if (claimed.row_count !== 1 || claimed.rows.length !== 1 || !UUID.test(claimed.rows[0].lease_token)) {
        throw new DurableJobLeaseError('database-failed');
      }
      return claimedJob(claimed.rows[0], agentId, payload);
    });
  }

  async claim(request: ClaimJobsRequest, identity: AuthenticatedAgent): Promise<ClaimedJob | null> {
    claimRequest(request);
    exactIdentity(identity, request.agent_id);
    const deadline = this.#clock.now().getTime() + request.wait_ms;
    while (true) {
      const claimed = await this.#claimOnce(request.agent_id);
      if (claimed !== null || this.#clock.now().getTime() >= deadline) return claimed;
      await this.#clock.sleep(Math.min(MAX_POLL_MS, deadline - this.#clock.now().getTime()));
    }
  }

  async heartbeat(request: HeartbeatRequest, identity: AuthenticatedAgent): Promise<FencedOperationResponse> {
    exactFields(request, ['job_id', 'agent_id', 'attempt', 'lease_token', 'lease_expires_at', 'progress_percent', 'resources']);
    leaseRequest(request);
    exactIdentity(identity, request.agent_id);
    exactFields(request.resources, ['memory_mb', 'cpu_percent']);
    if (!Number.isInteger(request.progress_percent) || request.progress_percent < 0 || request.progress_percent > 100
        || !Number.isInteger(request.resources?.memory_mb) || request.resources.memory_mb < 0 || request.resources.memory_mb > 262_144
        || !Number.isInteger(request.resources?.cpu_percent) || request.resources.cpu_percent < 0 || request.resources.cpu_percent > 100) invalid();
    const result = await this.#transaction((transaction) => transaction.execute<LeaseExpiryRow>(STATEMENTS.heartbeat,
      [request.job_id, request.agent_id, request.attempt, request.lease_token, this.#leaseDurationMs]));
    if (result.row_count === 0 && result.rows.length === 0) return Object.freeze({ accepted: false, disposition: 'lease_lost' });
    if (result.row_count !== 1 || result.rows.length !== 1) throw new DurableJobLeaseError('database-failed');
    return Object.freeze({ accepted: true, disposition: 'accepted', lease_expires_at: utc(result.rows[0].lease_expires_at) });
  }

  async event(request: AgentEventRequest, identity: AuthenticatedAgent): Promise<FencedOperationResponse> {
    exactFields(request, ['job_id', 'agent_id', 'attempt', 'lease_token', 'lease_expires_at', 'sequence', 'level', 'event_type', 'fields']);
    leaseRequest(request);
    exactIdentity(identity, request.agent_id);
    const fields = eventFields(request);
    return this.#transaction(async (transaction) => {
      const inserted = await transaction.execute(STATEMENTS.appendEvent,
        [request.job_id, request.agent_id, request.attempt, request.lease_token, request.sequence,
          request.level, request.event_type, fields]);
      if (inserted.row_count === 1 && inserted.rows.length === 1) return Object.freeze({ accepted: true, disposition: 'accepted' });
      if (inserted.row_count !== 0 || inserted.rows.length !== 0) throw new DurableJobLeaseError('database-failed');
      const state = await transaction.execute<EventStateRow>(STATEMENTS.eventState,
        [request.job_id, request.agent_id, request.attempt, request.lease_token, request.sequence]);
      if (state.row_count === 0 && state.rows.length === 0) return Object.freeze({ accepted: false, disposition: 'lease_lost' });
      if (state.row_count !== 1 || state.rows.length !== 1) throw new DurableJobLeaseError('database-failed');
      const row = state.rows[0];
      if (!row.active) return Object.freeze({ accepted: false, disposition: 'lease_lost' });
      const same = row.level === request.level && row.event_type === request.event_type
        && sameJson(row.redacted_payload, request.fields);
      return Object.freeze(same
        ? { accepted: true, disposition: 'already_applied' }
        : { accepted: false, disposition: 'sequence_conflict' });
    });
  }

  async complete(request: CompleteJobRequest, identity: AuthenticatedAgent): Promise<FencedOperationResponse> {
    exactFields(request, ['job_id', 'agent_id', 'attempt', 'lease_token', 'lease_expires_at', 'result']);
    leaseRequest(request);
    exactIdentity(identity, request.agent_id);
    let manifest;
    try { manifest = validateCompletionManifest(request.result); } catch { return invalid(); }
    const encoded = JSON.stringify(manifest);
    return this.#transaction(async (transaction) => {
      const completed = await transaction.execute(STATEMENTS.complete,
        [request.job_id, request.agent_id, request.attempt, request.lease_token, encoded, manifest.revision_set_hash]);
      if (completed.row_count === 1 && completed.rows.length === 1) return Object.freeze({ accepted: true, disposition: 'accepted' });
      if (completed.row_count !== 0 || completed.rows.length !== 0) throw new DurableJobLeaseError('database-failed');
      const state = await transaction.execute<CompletionStateRow>(STATEMENTS.completionState, [request.job_id]);
      if (state.row_count !== 1 || state.rows.length !== 1) return Object.freeze({ accepted: false, disposition: 'lease_lost' });
      const row = state.rows[0];
      const same = row.status === 'succeeded' && row.agent_id === request.agent_id
        && storedInteger(row.completion_attempt, 1, 100) === request.attempt && sameJson(row.completion_manifest, manifest);
      return Object.freeze(same
        ? { accepted: true, disposition: 'already_applied' }
        : { accepted: false, disposition: 'lease_lost' });
    });
  }

  async fail(request: FailJobRequest, identity: AuthenticatedAgent): Promise<FencedOperationResponse> {
    exactFields(request, ['job_id', 'agent_id', 'attempt', 'lease_token', 'lease_expires_at', 'error_code', 'retryable', 'diagnostic']);
    leaseRequest(request);
    exactIdentity(identity, request.agent_id);
    if (!Object.hasOwn(DIAGNOSTIC_BY_CODE, request.error_code) || typeof request.retryable !== 'boolean'
        || DIAGNOSTIC_BY_CODE[request.error_code] !== request.diagnostic) invalid();
    return this.#transaction(async (transaction) => {
      const failed = await transaction.execute(STATEMENTS.fail,
        [request.job_id, request.agent_id, request.attempt, request.lease_token,
          request.error_code, request.retryable, this.#retryDelayMs]);
      if (failed.row_count === 1 && failed.rows.length === 1) return Object.freeze({ accepted: true, disposition: 'accepted' });
      if (failed.row_count !== 0 || failed.rows.length !== 0) throw new DurableJobLeaseError('database-failed');
      const state = await transaction.execute<FailureStateRow>(STATEMENTS.failureState, [request.job_id]);
      if (state.row_count !== 1 || state.rows.length !== 1) return Object.freeze({ accepted: false, disposition: 'lease_lost' });
      const row = state.rows[0];
      const same = row.agent_id === request.agent_id && storedInteger(row.last_failure_attempt, 1, 100) === request.attempt
        && row.last_error_code === request.error_code && row.last_error_retryable === request.retryable;
      return Object.freeze(same
        ? { accepted: true, disposition: 'already_applied' }
        : { accepted: false, disposition: 'lease_lost' });
    });
  }
}
