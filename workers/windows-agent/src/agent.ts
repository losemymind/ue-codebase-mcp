import {
  type AgentConfig,
  type AgentEventRequest,
  type AgentJobPayload,
  type AgentTransport,
  type Clock,
  type CompletionManifest,
  type CredentialProvider,
  type FailJobRequest,
  type HeartbeatRequest,
  type JobLease,
  type ReindexJobPayload,
  assertCredential,
  validateClaimedJob,
  validateCompletionManifest,
} from './contracts.ts';
import {
  createObservationContext,
  type ObservationContext,
  type ObservabilityRecorder,
} from '../../../packages/observability/src/index.ts';

export interface JobExecutionContext {
  heartbeat(progressPercent: number, resources?: { memory_mb: number; cpu_percent: number }): Promise<void>;
  event(event: {
    level: 'debug' | 'info' | 'warning' | 'error';
    event_type: string;
    fields?: { phase?: string; progress_percent?: number; item_count?: number };
  }): Promise<void>;
  now(): Date;
  readonly signal: AbortSignal;
}

export type ReindexJobHandler = (payload: ReindexJobPayload, context: JobExecutionContext) => Promise<CompletionManifest>;

export interface AgentJobHandlers {
  reindex: ReindexJobHandler;
}

export type AgentIterationResult = 'idle' | 'completed' | 'failed' | 'lease_lost';

export class LeaseLostError extends Error {
  constructor() {
    super('job lease was lost');
    this.name = 'LeaseLostError';
  }
}

export class AgentJobError extends Error {
  readonly errorCode: FailJobRequest['error_code'];
  readonly retryable: boolean;

  constructor(errorCode: FailJobRequest['error_code'], retryable: boolean) {
    super(errorCode);
    this.name = 'AgentJobError';
    this.errorCode = errorCode;
    this.retryable = retryable;
  }
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}

const diagnosticByCode: Readonly<Record<FailJobRequest['error_code'], FailJobRequest['diagnostic']>> = Object.freeze({
  DEPENDENCY_UNAVAILABLE: 'dependency unavailable',
  INVALID_SOURCE_INPUT: 'invalid source input',
  RESOURCE_LIMIT: 'resource limit exceeded',
  UNHANDLED_AGENT_FAILURE: 'job handler failed; inspect protected local diagnostics',
});

function validProgress(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new RangeError('progress must be an integer from 0 through 100');
  return value;
}

function validResources(value: { memory_mb: number; cpu_percent: number }): { memory_mb: number; cpu_percent: number } {
  if (!Number.isInteger(value.memory_mb) || value.memory_mb < 0 || value.memory_mb > 262_144) throw new RangeError('memory usage is out of bounds');
  if (!Number.isInteger(value.cpu_percent) || value.cpu_percent < 0 || value.cpu_percent > 100) throw new RangeError('CPU usage is out of bounds');
  return Object.freeze({ ...value });
}

function validEvent(value: Parameters<JobExecutionContext['event']>[0]): Parameters<JobExecutionContext['event']>[0] {
  if (!/^[a-z][a-z0-9_.]{0,127}$/.test(value.event_type)) throw new TypeError('event_type is invalid');
  const fields = value.fields ?? {};
  const keys = Object.keys(fields);
  if (keys.some((key) => !['phase', 'progress_percent', 'item_count'].includes(key))) throw new TypeError('event fields are not allowlisted');
  if (fields.phase !== undefined && !/^[a-z][a-z0-9_.-]{0,63}$/.test(fields.phase)) throw new TypeError('event phase is invalid');
  if (fields.progress_percent !== undefined) validProgress(fields.progress_percent);
  if (fields.item_count !== undefined && (!Number.isSafeInteger(fields.item_count) || fields.item_count < 0)) throw new TypeError('event item_count is invalid');
  return Object.freeze({ ...value, fields: Object.freeze({ ...fields }) });
}

export class WindowsAgent {
  readonly #config: AgentConfig;
  readonly #transport: AgentTransport;
  readonly #credentials: CredentialProvider;
  readonly #handlers: AgentJobHandlers;
  readonly #clock: Clock;
  readonly #observability: ObservabilityRecorder;
  #registered = false;

  constructor(options: {
    config: AgentConfig;
    transport: AgentTransport;
    credentials: CredentialProvider;
    handlers: AgentJobHandlers;
    observability: ObservabilityRecorder;
    clock?: Clock;
  }) {
    this.#config = options.config;
    this.#transport = options.transport;
    this.#credentials = options.credentials;
    this.#handlers = options.handlers;
    this.#clock = options.clock ?? new SystemClock();
    if (typeof options.observability !== 'object' || options.observability === null
        || typeof options.observability.record !== 'function') throw new TypeError('invalid Agent observability');
    this.#observability = options.observability;
  }

  async #auth() {
    const credential = await this.#credentials.resolve(this.#config.credential.secret_ref);
    return assertCredential(credential, this.#clock.now());
  }

  async register(observation: ObservationContext = createObservationContext()): Promise<void> {
    const response = await this.#transport.register({
      schema: 'ue-codebase-mcp/agent-register',
      version: 2,
      agent_id: this.#config.agent_id,
      agent_version: this.#config.agent_version,
      ue_version: '5.6',
      vcs: ['svn'],
      capabilities: [...this.#config.capabilities],
    }, await this.#auth(), observation);
    if (response.accepted !== true || Number.isNaN(Date.parse(response.registered_at))) throw new TypeError('coordinator returned an invalid registration response');
    this.#registered = true;
  }

  async runOnce(): Promise<AgentIterationResult> {
    const observation = createObservationContext();
    const started = this.#clock.now().getTime();
    try {
      if (!this.#registered) await this.register(observation);
      const claimedValue = await this.#transport.claim({
        schema: 'ue-codebase-mcp/job-claim',
        version: 2,
        agent_id: this.#config.agent_id,
        supported_kinds: ['reindex'],
        wait_ms: this.#config.claim_wait_ms,
      }, await this.#auth(), observation);
      if (claimedValue === null) {
        this.#recordIteration(observation, started, 'idle');
        return 'idle';
      }
      const claimed = validateClaimedJob(claimedValue);
      if (claimed.lease.agent_id !== this.#config.agent_id) throw new TypeError('coordinator assigned a lease to another agent');
      const result = await this.#execute(claimed.lease, claimed.payload, claimed.next_event_sequence, observation);
      this.#recordIteration(observation, started, result);
      return result;
    } catch (error) {
      this.#observability.record(Object.freeze({ context: observation, component: 'windows-agent', operation: 'iteration',
        outcome: 'failed', duration_ms: Math.max(0, this.#clock.now().getTime() - started),
        attributes: Object.freeze({ error_code: 'coordinator-unavailable', agent_status: 'offline' }) }));
      throw error;
    }
  }

  #recordIteration(observation: ObservationContext, started: number, result: AgentIterationResult): void {
    this.#observability.record(Object.freeze({ context: observation, component: 'windows-agent', operation: 'iteration',
      outcome: result === 'completed' || result === 'idle' ? 'succeeded' : 'failed',
      duration_ms: Math.max(0, this.#clock.now().getTime() - started),
      attributes: Object.freeze({ disposition: result, agent_status: result === 'lease_lost' ? 'degraded' : 'online' }) }));
  }

  async #execute(initialLease: JobLease, payload: AgentJobPayload, initialSequence: number,
    observation: ObservationContext): Promise<AgentIterationResult> {
    let lease = initialLease;
    let sequence = initialSequence;
    let latestProgress = 0;
    let latestResources = Object.freeze({ memory_mb: 0, cpu_percent: 0 });

    const heartbeat = async (progressPercent: number, resources = { memory_mb: 0, cpu_percent: 0 }): Promise<void> => {
      latestProgress = validProgress(progressPercent);
      latestResources = validResources(resources);
      const request: HeartbeatRequest = {
        ...lease,
        progress_percent: latestProgress,
        resources: latestResources,
      };
      const response = await this.#transport.heartbeat(request, await this.#auth(), observation);
      if (!response.accepted) throw new LeaseLostError();
      if (response.lease_expires_at !== undefined) lease = { ...lease, lease_expires_at: response.lease_expires_at };
    };

    const event = async (eventValue: Parameters<JobExecutionContext['event']>[0]): Promise<void> => {
      const safeEvent = validEvent(eventValue);
      const request: AgentEventRequest = {
        ...lease,
        sequence,
        level: safeEvent.level,
        event_type: safeEvent.event_type,
        fields: safeEvent.fields ?? {},
      };
      const response = await this.#transport.event(request, await this.#auth(), observation);
      if (!response.accepted) {
        if (response.disposition === 'lease_lost') throw new LeaseLostError();
        throw new Error('coordinator rejected the event sequence');
      }
      sequence += 1;
    };

    try {
      await heartbeat(0);
      const handler = this.#handlers[payload.kind];
      const controller = new AbortController();
      const watchdog = (async (): Promise<never> => {
        while (!controller.signal.aborted) {
          await this.#clock.sleep(this.#config.heartbeat_interval_ms, controller.signal);
          if (controller.signal.aborted) break;
          await heartbeat(latestProgress, latestResources);
        }
        throw new LeaseLostError();
      })();
      let resultValue: CompletionManifest;
      try {
        resultValue = await Promise.race([
          handler(payload, { heartbeat, event, now: () => this.#clock.now(), signal: controller.signal }),
          watchdog,
        ]);
      } finally {
        controller.abort();
        await watchdog.catch(() => undefined);
      }
      const result = validateCompletionManifest(resultValue);
      if (result.revision_set_hash !== payload.revision_set.hash) throw new AgentJobError('INVALID_SOURCE_INPUT', false);
      await heartbeat(100);
      const completion = await this.#transport.complete({ ...lease, result }, await this.#auth(), observation);
      return completion.accepted ? 'completed' : 'lease_lost';
    } catch (error) {
      if (error instanceof LeaseLostError) return 'lease_lost';
      const classified = error instanceof AgentJobError
        ? error
        : new AgentJobError('UNHANDLED_AGENT_FAILURE', true);
      const failure = await this.#transport.fail({
        ...lease,
        error_code: classified.errorCode,
        retryable: classified.retryable,
        diagnostic: diagnosticByCode[classified.errorCode],
      }, await this.#auth(), observation).catch(() => undefined);
      return failure?.accepted ? 'failed' : 'lease_lost';
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let result: AgentIterationResult = 'idle';
      try { result = await this.runOnce(); } catch { this.#registered = false; }
      if (result === 'idle' && !signal.aborted) await this.#clock.sleep(this.#config.idle_delay_ms, signal);
    }
  }
}
