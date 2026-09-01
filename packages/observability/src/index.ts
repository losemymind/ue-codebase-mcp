import { createHash, randomBytes, randomUUID } from 'node:crypto';

export interface ObservationContext {
  readonly correlation_id: string;
  readonly trace_id: string;
  readonly span_id: string;
}

export type TelemetryOutcome = 'succeeded' | 'failed' | 'denied';
export type TelemetrySeverity = 'info' | 'warn' | 'error';
export type TelemetryAttributeValue = string | number | boolean;

export interface TelemetryRecord {
  readonly schema: 'ue-codebase-mcp/telemetry';
  readonly version: 1;
  readonly kind: 'log' | 'span';
  readonly timestamp: string;
  readonly component: string;
  readonly operation: string;
  readonly outcome: TelemetryOutcome;
  readonly severity: TelemetrySeverity;
  readonly correlation_id: string;
  readonly trace_id: string;
  readonly span_id: string;
  readonly duration_ms: number;
  readonly attributes: Readonly<Record<string, TelemetryAttributeValue>>;
}

export interface TelemetrySink {
  emit(record: TelemetryRecord): void;
}

export interface RecordOperationInput {
  readonly context: ObservationContext;
  readonly component: string;
  readonly operation: string;
  readonly outcome: TelemetryOutcome;
  readonly duration_ms: number;
  readonly severity?: TelemetrySeverity;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export type AuditActorType = 'user' | 'service' | 'agent' | 'system';
export type AuditOutcome = 'allowed' | 'denied' | 'succeeded' | 'failed';

export interface SecurityAuditEvent {
  readonly actor_type: AuditActorType;
  readonly actor_id: string;
  readonly action: string;
  readonly project_id: string | null;
  readonly tool: string | null;
  readonly outcome: AuditOutcome;
  readonly request_hash: string;
  readonly correlation_id: string;
  readonly trace_id: string;
  readonly span_id: string;
  readonly resource_type: string | null;
  readonly resource_id: string | null;
  readonly error_code: string | null;
}

export interface SecurityAuditSink {
  record(event: SecurityAuditEvent): Promise<void>;
}

export interface AuditStatement { readonly name: string; readonly text: string }
export interface AuditResult { readonly row_count: number }
export interface AuditDatabase {
  execute(statement: AuditStatement, values: readonly (string | null)[]): Promise<AuditResult>;
}

export class ObservationContextError extends Error {
  constructor() {
    super('invalid observation context');
    this.name = 'ObservationContextError';
  }
}

export class AuditPersistenceError extends Error {
  constructor() {
    super('audit persistence failed');
    this.name = 'AuditPersistenceError';
  }
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TRACE_ID = /^[a-f0-9]{32}$/;
const SPAN_ID = /^[a-f0-9]{16}$/;
const TRACEPARENT = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/;
const ZERO_TRACE = '00000000000000000000000000000000';
const ZERO_SPAN = '0000000000000000';
const TELEMETRY_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;
const TELEMETRY_COMPONENTS = new Set(['index-coordinator', 'mcp-http', 'mcp-server', 'windows-agent']);
const TELEMETRY_OPERATIONS = new Set([
  'agent-register', 'iteration', 'job-claim', 'job-complete', 'job-events', 'job-fail', 'job-heartbeat',
  'request', 'tool-call', 'unknown',
]);
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const HEX_HASH = /^[a-f0-9]{64}$/;
const AUDIT_ACTION = /^[a-z][a-z0-9_.-]{0,127}$/;
const AUDIT_RESOURCE = /^[a-z][a-z0-9_.-]{0,63}$/;
const PROJECT_ID = UUID;
const SAFE_ATTRIBUTE_KEYS = new Set([
  'agent_status',
  'attempt',
  'disposition',
  'error_code',
  'job_kind',
  'lease_recovered',
  'method',
  'protocol_version',
  'retryable',
  'status_code',
  'tool',
]);
const HISTOGRAM_BUCKETS = Object.freeze([5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000]);

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function exactHeaders(headers: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string | undefined>> {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) throw new ObservationContextError();
  const normalized: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!/^[a-z0-9-]{1,64}$/.test(lower) || lower in normalized
        || (value !== undefined && (typeof value !== 'string' || /[\r\n\0]/.test(value)))) throw new ObservationContextError();
    normalized[lower] = value;
  }
  return normalized;
}

export function createObservationContext(headers: Readonly<Record<string, string | undefined>> = {}): ObservationContext {
  const normalized = exactHeaders(headers);
  const suppliedCorrelation = normalized['x-correlation-id'];
  if (suppliedCorrelation !== undefined && !UUID.test(suppliedCorrelation)) throw new ObservationContextError();
  const suppliedTraceparent = normalized.traceparent;
  let traceId = randomHex(16);
  if (suppliedTraceparent !== undefined) {
    const match = TRACEPARENT.exec(suppliedTraceparent);
    if (match === null || match[1] === ZERO_TRACE || match[2] === ZERO_SPAN) throw new ObservationContextError();
    traceId = match[1];
  }
  return Object.freeze({
    correlation_id: suppliedCorrelation?.toLowerCase() ?? randomUUID(),
    trace_id: traceId,
    span_id: randomHex(8),
  });
}

export function childObservationContext(parent: ObservationContext): ObservationContext {
  assertObservationContext(parent);
  return Object.freeze({ correlation_id: parent.correlation_id, trace_id: parent.trace_id, span_id: randomHex(8) });
}

export function assertObservationContext(value: unknown): asserts value is ObservationContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ObservationContextError();
  const context = value as Partial<ObservationContext>;
  if (!UUID.test(context.correlation_id ?? '') || !TRACE_ID.test(context.trace_id ?? '') || context.trace_id === ZERO_TRACE
      || !SPAN_ID.test(context.span_id ?? '') || context.span_id === ZERO_SPAN
      || Object.keys(value).some((key) => !['correlation_id', 'trace_id', 'span_id'].includes(key))) throw new ObservationContextError();
}

export function traceparent(context: ObservationContext): string {
  assertObservationContext(context);
  return `00-${context.trace_id}-${context.span_id}-01`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sanitizeTelemetryAttributes(input: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, TelemetryAttributeValue>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.keys(input).length > SAFE_ATTRIBUTE_KEYS.size) {
    throw new TypeError('invalid telemetry attributes');
  }
  const output: Record<string, TelemetryAttributeValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_ATTRIBUTE_KEYS.has(key)) throw new TypeError('telemetry attribute is not allowlisted');
    if (typeof value === 'string') {
      if (!SAFE_TOKEN.test(value)) throw new TypeError('invalid telemetry attribute value');
      output[key] = value;
    } else if (typeof value === 'boolean') output[key] = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) output[key] = value;
    else throw new TypeError('invalid telemetry attribute value');
  }
  return Object.freeze(output);
}

function labels(component: string, operation: string, outcome: TelemetryOutcome): string {
  return `component="${component}",operation="${operation}",outcome="${outcome}"`;
}

export class PrometheusMetricsRegistry {
  readonly #counts = new Map<string, number>();
  readonly #durations = new Map<string, { count: number; sum: number; buckets: number[] }>();
  #dropped = 0;

  observe(component: string, operation: string, outcome: TelemetryOutcome, durationMs: number): void {
    const key = labels(component, operation, outcome);
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1);
    const histogram = this.#durations.get(key) ?? { count: 0, sum: 0, buckets: HISTOGRAM_BUCKETS.map(() => 0) };
    histogram.count += 1;
    histogram.sum += durationMs;
    HISTOGRAM_BUCKETS.forEach((bucket, index) => {
      if (durationMs <= bucket) histogram.buckets[index] += 1;
    });
    this.#durations.set(key, histogram);
  }

  dropped(): void {
    this.#dropped += 1;
  }

  render(): string {
    const lines = [
      '# HELP ue_codebase_requests_total Completed service operations.',
      '# TYPE ue_codebase_requests_total counter',
    ];
    for (const key of [...this.#counts.keys()].sort()) lines.push(`ue_codebase_requests_total{${key}} ${this.#counts.get(key)}`);
    lines.push('# HELP ue_codebase_request_duration_ms Service operation duration in milliseconds.');
    lines.push('# TYPE ue_codebase_request_duration_ms histogram');
    for (const key of [...this.#durations.keys()].sort()) {
      const histogram = this.#durations.get(key);
      if (histogram === undefined) continue;
      for (const [index, bucket] of HISTOGRAM_BUCKETS.entries()) {
        lines.push(`ue_codebase_request_duration_ms_bucket{${key},le="${bucket}"} ${histogram.buckets[index]}`);
      }
      lines.push(`ue_codebase_request_duration_ms_bucket{${key},le="+Inf"} ${histogram.count}`);
      lines.push(`ue_codebase_request_duration_ms_sum{${key}} ${histogram.sum}`);
      lines.push(`ue_codebase_request_duration_ms_count{${key}} ${histogram.count}`);
    }
    lines.push('# HELP ue_codebase_telemetry_dropped_total Telemetry records dropped because a sink failed.');
    lines.push('# TYPE ue_codebase_telemetry_dropped_total counter');
    lines.push(`ue_codebase_telemetry_dropped_total ${this.#dropped}`);
    return `${lines.join('\n')}\n`;
  }
}

export class ObservabilityRecorder {
  readonly #sink: TelemetrySink;
  readonly #metrics: PrometheusMetricsRegistry;
  readonly #now: () => Date;

  constructor(sink: TelemetrySink, metrics = new PrometheusMetricsRegistry(), now: () => Date = () => new Date()) {
    if (typeof sink !== 'object' || sink === null || typeof sink.emit !== 'function'
        || !(metrics instanceof PrometheusMetricsRegistry) || typeof now !== 'function') throw new TypeError('invalid observability configuration');
    this.#sink = sink;
    this.#metrics = metrics;
    this.#now = now;
  }

  record(input: RecordOperationInput): void {
    assertObservationContext(input.context);
    if (!TELEMETRY_NAME.test(input.component) || !TELEMETRY_COMPONENTS.has(input.component)
        || !TELEMETRY_NAME.test(input.operation) || !TELEMETRY_OPERATIONS.has(input.operation)
        || !['succeeded', 'failed', 'denied'].includes(input.outcome)
        || !Number.isFinite(input.duration_ms) || input.duration_ms < 0 || input.duration_ms > 86_400_000) {
      throw new TypeError('invalid telemetry operation');
    }
    const durationMs = Math.round(input.duration_ms * 1000) / 1000;
    const severity = input.severity ?? (input.outcome === 'succeeded' ? 'info' : input.outcome === 'denied' ? 'warn' : 'error');
    if (!['info', 'warn', 'error'].includes(severity)) throw new TypeError('invalid telemetry severity');
    const attributes = sanitizeTelemetryAttributes(input.attributes);
    this.#metrics.observe(input.component, input.operation, input.outcome, durationMs);
    const common = Object.freeze({
      schema: 'ue-codebase-mcp/telemetry' as const,
      version: 1 as const,
      timestamp: this.#now().toISOString(),
      component: input.component,
      operation: input.operation,
      outcome: input.outcome,
      severity,
      correlation_id: input.context.correlation_id,
      trace_id: input.context.trace_id,
      span_id: input.context.span_id,
      duration_ms: durationMs,
      attributes,
    });
    for (const kind of ['log', 'span'] as const) {
      try { this.#sink.emit(Object.freeze({ ...common, kind })); } catch { this.#metrics.dropped(); }
    }
  }

  metrics(): string {
    return this.#metrics.render();
  }
}

export const INSERT_AUDIT_EVENT = Object.freeze({
  name: 'observability-insert-audit-event-v1',
  text: `INSERT INTO ue_mcp.audit_events
    (actor_type, actor_id, action, project_id, tool, outcome, request_hash, correlation_id, trace_id, span_id,
      resource_type, resource_id, error_code)
    VALUES ($1, $2, $3, $4::uuid, $5, $6, decode($7, 'hex'), $8::uuid, $9, $10, $11, $12, $13)`,
});

function validAuditEvent(event: SecurityAuditEvent): boolean {
  return typeof event === 'object' && event !== null && !Array.isArray(event)
    && Object.keys(event).length === 13
    && ['user', 'service', 'agent', 'system'].includes(event.actor_type)
    && typeof event.actor_id === 'string' && event.actor_id.length >= 1 && event.actor_id.length <= 512 && !/[\r\n\0]/.test(event.actor_id)
    && AUDIT_ACTION.test(event.action)
    && (event.project_id === null || PROJECT_ID.test(event.project_id))
    && (event.tool === null || SAFE_TOKEN.test(event.tool))
    && ['allowed', 'denied', 'succeeded', 'failed'].includes(event.outcome)
    && HEX_HASH.test(event.request_hash)
    && UUID.test(event.correlation_id) && TRACE_ID.test(event.trace_id) && event.trace_id !== ZERO_TRACE
    && SPAN_ID.test(event.span_id) && event.span_id !== ZERO_SPAN
    && (event.resource_type === null || AUDIT_RESOURCE.test(event.resource_type))
    && (event.resource_id === null || typeof event.resource_id === 'string' && event.resource_id.length >= 1
      && event.resource_id.length <= 512 && !/[\r\n\0]/.test(event.resource_id))
    && (event.error_code === null || SAFE_TOKEN.test(event.error_code));
}

export class PostgresAuditSink implements SecurityAuditSink {
  readonly #database: AuditDatabase;

  constructor(database: AuditDatabase) {
    if (typeof database !== 'object' || database === null || typeof database.execute !== 'function') {
      throw new TypeError('invalid audit database');
    }
    this.#database = database;
  }

  async record(event: SecurityAuditEvent): Promise<void> {
    if (!validAuditEvent(event)) throw new AuditPersistenceError();
    try {
      const result = await this.#database.execute(INSERT_AUDIT_EVENT, [
        event.actor_type, event.actor_id, event.action, event.project_id, event.tool, event.outcome, event.request_hash,
        event.correlation_id, event.trace_id, event.span_id, event.resource_type, event.resource_id, event.error_code,
      ]);
      if (result.row_count !== 1) throw new AuditPersistenceError();
    } catch (error) {
      if (error instanceof AuditPersistenceError) throw error;
      throw new AuditPersistenceError();
    }
  }
}
