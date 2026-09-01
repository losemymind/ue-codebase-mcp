import { randomUUID } from 'node:crypto';
import {
  type AgentAuth,
  type AgentEventRequest,
  type AgentJobPayload,
  type AgentTransport,
  type ClaimJobsRequest,
  type ClaimedJob,
  type Clock,
  type CompleteJobRequest,
  type CompletionManifest,
  type FailJobRequest,
  type FencedOperationResponse,
  type HeartbeatRequest,
  type RegisterAgentRequest,
  type RegisterAgentResponse,
  validateCompletionManifest,
  validateJobPayload,
} from './contracts.ts';

type ReferenceJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

interface ReferenceJob {
  id: string;
  payload: AgentJobPayload;
  status: ReferenceJobStatus;
  attempt: number;
  maxAttempts: number;
  availableAt: number;
  leaseAgentId?: string;
  leaseExpiresAt?: number;
  leaseToken?: string;
  nextEventSequence: number;
  events: AgentEventRequest[];
  completion?: CompletionManifest;
  completedBy?: { agentId: string; attempt: number };
}

export interface ReferenceJobSnapshot {
  id: string;
  status: ReferenceJobStatus;
  attempt: number;
  lease_agent_id?: string;
  lease_expires_at?: string;
  next_event_sequence: number;
}

export class LeaseCoordinator implements AgentTransport {
  readonly #clock: Clock;
  readonly #leaseDurationMs: number;
  readonly #retryDelayMs: number;
  readonly #jobs = new Map<string, ReferenceJob>();
  readonly #agents = new Map<string, RegisterAgentRequest>();
  #nextJobId = 1;

  constructor(options: { clock: Clock; lease_duration_ms?: number; retry_delay_ms?: number }) {
    this.#clock = options.clock;
    this.#leaseDurationMs = options.lease_duration_ms ?? 30_000;
    this.#retryDelayMs = options.retry_delay_ms ?? 1_000;
    if (!Number.isInteger(this.#leaseDurationMs) || this.#leaseDurationMs < 1_000 || this.#leaseDurationMs > 300_000) throw new RangeError('lease duration is out of bounds');
    if (!Number.isInteger(this.#retryDelayMs) || this.#retryDelayMs < 0 || this.#retryDelayMs > 300_000) throw new RangeError('retry delay is out of bounds');
  }

  #authorize(auth: AgentAuth): void {
    if (typeof auth.token !== 'string' || auth.token.length < 16 || auth.token.length > 8192
        || !/^[A-Za-z0-9._~-]+$/.test(auth.token)) throw new Error('agent authentication rejected');
  }

  enqueue(payload: unknown, options: { max_attempts?: number } = {}): string {
    const validated = validateJobPayload(payload);
    const maxAttempts = options.max_attempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new RangeError('max_attempts is out of bounds');
    const id = `job-${String(this.#nextJobId).padStart(4, '0')}`;
    this.#nextJobId += 1;
    this.#jobs.set(id, {
      id,
      payload: validated,
      status: 'queued',
      attempt: 0,
      maxAttempts,
      availableAt: this.#clock.now().getTime(),
      nextEventSequence: 0,
      events: [],
    });
    return id;
  }

  recoverExpiredLeases(): number {
    const now = this.#clock.now().getTime();
    let recovered = 0;
    for (const job of this.#jobs.values()) {
      if (job.status !== 'running' || job.leaseExpiresAt === undefined || job.leaseExpiresAt > now) continue;
      job.leaseAgentId = undefined;
      job.leaseExpiresAt = undefined;
      job.leaseToken = undefined;
      job.status = job.attempt < job.maxAttempts ? 'queued' : 'failed';
      job.availableAt = now;
      recovered += 1;
    }
    return recovered;
  }

  snapshot(jobId: string): ReferenceJobSnapshot {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error('job does not exist');
    return Object.freeze({
      id: job.id,
      status: job.status,
      attempt: job.attempt,
      ...(job.leaseAgentId === undefined ? {} : { lease_agent_id: job.leaseAgentId }),
      ...(job.leaseExpiresAt === undefined ? {} : { lease_expires_at: new Date(job.leaseExpiresAt).toISOString() }),
      next_event_sequence: job.nextEventSequence,
    });
  }

  async register(request: RegisterAgentRequest, auth: AgentAuth): Promise<RegisterAgentResponse> {
    this.#authorize(auth);
    if (request.schema !== 'ue-codebase-mcp/agent-register' || request.version !== 2 || request.ue_version !== '5.6' || request.vcs.length !== 1 || request.vcs[0] !== 'svn') {
      throw new Error('agent registration contract rejected');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(request.agent_id) || !/^\d+\.\d+\.\d+$/.test(request.agent_version)) throw new Error('agent identity rejected');
    const capabilities = new Set(request.capabilities);
    if (capabilities.size !== request.capabilities.length || [...capabilities].some((value) => !['svn-sync', 'clang-index', 'module-index'].includes(value))) {
      throw new Error('agent capabilities rejected');
    }
    this.#agents.set(request.agent_id, structuredClone(request));
    return { accepted: true, registered_at: this.#clock.now().toISOString() };
  }

  async claim(request: ClaimJobsRequest, auth: AgentAuth): Promise<ClaimedJob | null> {
    this.#authorize(auth);
    if (!this.#agents.has(request.agent_id)) throw new Error('agent must register before claiming work');
    if (request.schema !== 'ue-codebase-mcp/job-claim' || request.version !== 2 || request.supported_kinds.length !== 1 || request.supported_kinds[0] !== 'reindex') {
      throw new Error('claim contract rejected');
    }
    this.recoverExpiredLeases();
    const now = this.#clock.now().getTime();
    const job = [...this.#jobs.values()].find((candidate) => candidate.status === 'queued' && candidate.availableAt <= now);
    if (!job) return null;
    job.status = 'running';
    job.attempt += 1;
    job.leaseAgentId = request.agent_id;
    job.leaseToken = randomUUID();
    job.leaseExpiresAt = now + this.#leaseDurationMs;
    return structuredClone({
      lease: {
        job_id: job.id,
        agent_id: request.agent_id,
        attempt: job.attempt,
        lease_token: job.leaseToken,
        lease_expires_at: new Date(job.leaseExpiresAt).toISOString(),
      },
      payload: job.payload,
      next_event_sequence: job.nextEventSequence,
    });
  }

  #activeLease(request: { job_id: string; agent_id: string; attempt: number; lease_token: string }): ReferenceJob | undefined {
    const job = this.#jobs.get(request.job_id);
    if (!job || job.status !== 'running' || job.leaseAgentId !== request.agent_id || job.attempt !== request.attempt
        || job.leaseToken !== request.lease_token) return undefined;
    if (job.leaseExpiresAt === undefined || job.leaseExpiresAt <= this.#clock.now().getTime()) return undefined;
    return job;
  }

  async heartbeat(request: HeartbeatRequest, auth: AgentAuth): Promise<FencedOperationResponse> {
    this.#authorize(auth);
    const job = this.#activeLease(request);
    if (!job) return { accepted: false, disposition: 'lease_lost' };
    if (!Number.isInteger(request.progress_percent) || request.progress_percent < 0 || request.progress_percent > 100) throw new Error('heartbeat progress rejected');
    if (!Number.isInteger(request.resources.memory_mb) || !Number.isInteger(request.resources.cpu_percent)) throw new Error('heartbeat resources rejected');
    job.leaseExpiresAt = this.#clock.now().getTime() + this.#leaseDurationMs;
    return { accepted: true, disposition: 'accepted', lease_expires_at: new Date(job.leaseExpiresAt).toISOString() };
  }

  async event(request: AgentEventRequest, auth: AgentAuth): Promise<FencedOperationResponse> {
    this.#authorize(auth);
    const job = this.#activeLease(request);
    if (!job) return { accepted: false, disposition: 'lease_lost' };
    if (request.sequence < job.nextEventSequence) {
      const existing = job.events.find((event) => event.sequence === request.sequence);
      return existing !== undefined && JSON.stringify(existing) === JSON.stringify(request)
        ? { accepted: true, disposition: 'already_applied' }
        : { accepted: false, disposition: 'sequence_conflict' };
    }
    if (request.sequence !== job.nextEventSequence || !/^[a-z][a-z0-9_.]{0,127}$/.test(request.event_type)) {
      return { accepted: false, disposition: 'sequence_conflict' };
    }
    const fieldKeys = Object.keys(request.fields);
    if (fieldKeys.some((key) => !['phase', 'progress_percent', 'item_count'].includes(key))) throw new Error('event payload field rejected');
    job.events.push(structuredClone(request));
    job.nextEventSequence += 1;
    return { accepted: true, disposition: 'accepted' };
  }

  async complete(request: CompleteJobRequest, auth: AgentAuth): Promise<FencedOperationResponse> {
    this.#authorize(auth);
    const job = this.#jobs.get(request.job_id);
    const result = validateCompletionManifest(request.result);
    if (job?.status === 'succeeded' && job.completedBy?.agentId === request.agent_id && job.completedBy.attempt === request.attempt) {
      return JSON.stringify(job.completion) === JSON.stringify(result)
        ? { accepted: true, disposition: 'already_applied' }
        : { accepted: false, disposition: 'lease_lost' };
    }
    const active = this.#activeLease(request);
    if (!active || result.revision_set_hash !== active.payload.revision_set.hash) return { accepted: false, disposition: 'lease_lost' };
    active.status = 'succeeded';
    active.completion = result;
    active.completedBy = { agentId: request.agent_id, attempt: request.attempt };
    active.leaseAgentId = undefined;
    active.leaseExpiresAt = undefined;
    active.leaseToken = undefined;
    return { accepted: true, disposition: 'accepted' };
  }

  async fail(request: FailJobRequest, auth: AgentAuth): Promise<FencedOperationResponse> {
    this.#authorize(auth);
    const job = this.#activeLease(request);
    if (!job) return { accepted: false, disposition: 'lease_lost' };
    if (!['DEPENDENCY_UNAVAILABLE', 'INVALID_SOURCE_INPUT', 'RESOURCE_LIMIT', 'UNHANDLED_AGENT_FAILURE'].includes(request.error_code)) throw new Error('failure code rejected');
    job.leaseAgentId = undefined;
    job.leaseExpiresAt = undefined;
    job.leaseToken = undefined;
    if (request.retryable && job.attempt < job.maxAttempts) {
      job.status = 'queued';
      job.availableAt = this.#clock.now().getTime() + this.#retryDelayMs;
    } else {
      job.status = 'failed';
    }
    return { accepted: true, disposition: 'accepted' };
  }
}
