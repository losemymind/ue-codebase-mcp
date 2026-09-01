import type { ObservationContext } from '../../../packages/observability/src/index.ts';

export const AGENT_PROTOCOL_VERSION = 2 as const;
export const AGENT_CONFIG_VERSION = 1 as const;
export const JOB_SCHEMA_VERSION = 1 as const;

export type AgentCapabilityName = 'svn-sync' | 'clang-index' | 'module-index';
export type JobKind = 'reindex';

export interface AgentConfig {
  schema: 'ue-codebase-mcp/windows-agent';
  version: 1;
  agent_id: string;
  agent_version: string;
  coordinator_endpoint: string;
  credential: { secret_ref: string };
  capabilities: AgentCapabilityName[];
  claim_wait_ms: number;
  idle_delay_ms: number;
  heartbeat_interval_ms: number;
}

export interface ShortLivedCredential {
  token: string;
  expires_at: string;
}

export interface CredentialProvider {
  resolve(secretRef: string): Promise<ShortLivedCredential>;
}

export interface AgentAuth {
  token: string;
}

export interface RegisterAgentRequest {
  schema: 'ue-codebase-mcp/agent-register';
  version: 2;
  agent_id: string;
  agent_version: string;
  ue_version: '5.6';
  vcs: readonly ['svn'];
  capabilities: AgentCapabilityName[];
}

export interface RegisterAgentResponse {
  accepted: true;
  registered_at: string;
}

export interface RevisionPin {
  repository_id: string;
  repository_kind: 'svn';
  branch: string;
  revision: string;
}

export interface ReindexJobPayload {
  schema: 'ue-codebase-mcp/reindex-job';
  version: 1;
  kind: 'reindex';
  project_id: string;
  revision_set: {
    hash: string;
    repositories: RevisionPin[];
  };
  scopes: Array<'engine' | 'game' | 'plugin'>;
  resource_policy: {
    timeout_seconds: number;
    max_memory_mb: number;
    max_cpu_percent: number;
  };
}

export type AgentJobPayload = ReindexJobPayload;

export interface ClaimJobsRequest {
  schema: 'ue-codebase-mcp/job-claim';
  version: 2;
  agent_id: string;
  supported_kinds: readonly ['reindex'];
  wait_ms: number;
}

export interface JobLease {
  job_id: string;
  agent_id: string;
  attempt: number;
  lease_token: string;
  lease_expires_at: string;
}

export interface ClaimedJob {
  lease: JobLease;
  payload: AgentJobPayload;
  next_event_sequence: number;
}

export interface HeartbeatRequest extends JobLease {
  progress_percent: number;
  resources: {
    memory_mb: number;
    cpu_percent: number;
  };
}

export interface AgentEventRequest extends JobLease {
  sequence: number;
  level: 'debug' | 'info' | 'warning' | 'error';
  event_type: string;
  fields: {
    phase?: string;
    progress_percent?: number;
    item_count?: number;
  };
}

export interface CompletionManifest {
  schema: 'ue-codebase-mcp/reindex-result';
  version: 1;
  generation_id: string;
  revision_set_hash: string;
  manifest_uri: string;
  manifest_sha256: string;
}

export interface CompleteJobRequest extends JobLease {
  result: CompletionManifest;
}

export interface FailJobRequest extends JobLease {
  error_code: 'DEPENDENCY_UNAVAILABLE' | 'INVALID_SOURCE_INPUT' | 'RESOURCE_LIMIT' | 'UNHANDLED_AGENT_FAILURE';
  retryable: boolean;
  diagnostic: 'dependency unavailable' | 'invalid source input' | 'resource limit exceeded' | 'job handler failed; inspect protected local diagnostics';
}

export interface FencedOperationResponse {
  accepted: boolean;
  disposition: 'accepted' | 'already_applied' | 'lease_lost' | 'sequence_conflict';
  lease_expires_at?: string;
}

export interface AgentTransport {
  register(request: RegisterAgentRequest, auth: AgentAuth, observation: ObservationContext): Promise<RegisterAgentResponse>;
  claim(request: ClaimJobsRequest, auth: AgentAuth, observation: ObservationContext): Promise<ClaimedJob | null>;
  heartbeat(request: HeartbeatRequest, auth: AgentAuth, observation: ObservationContext): Promise<FencedOperationResponse>;
  event(request: AgentEventRequest, auth: AgentAuth, observation: ObservationContext): Promise<FencedOperationResponse>;
  complete(request: CompleteJobRequest, auth: AgentAuth, observation: ObservationContext): Promise<FencedOperationResponse>;
  fail(request: FailJobRequest, auth: AgentAuth, observation: ObservationContext): Promise<FencedOperationResponse>;
}

export interface Clock {
  now(): Date;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export class AgentContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AgentContractError';
    this.code = code;
  }
}

const IDENTIFIER = /^[a-z][a-z0-9-]{1,62}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SECRET_REF = /^secret:\/\/[a-z][a-z0-9._-]{1,62}\/[A-Za-z0-9][A-Za-z0-9._/-]{0,253}$/;

function reject(code: string, message: string): never {
  throw new AgentContractError(code, message);
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) reject('AGENT_CONTRACT_INVALID', `${path} must be an object`);
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, required: string[], optional: string[], path: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) reject('AGENT_CONTRACT_UNKNOWN_FIELD', `${path} contains unknown field '${field}'`);
  }
  for (const field of required) {
    if (!Object.hasOwn(value, field)) reject('AGENT_CONTRACT_REQUIRED_FIELD', `${path} is missing required field '${field}'`);
  }
}

function stringValue(value: unknown, path: string, pattern: RegExp, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || !pattern.test(value)) {
    reject('AGENT_CONTRACT_INVALID', `${path} is invalid`);
  }
  return value;
}

function integerValue(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    reject('AGENT_CONTRACT_INVALID', `${path} must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function literal<T extends string | number>(value: unknown, allowed: readonly T[], path: string): T {
  if (!allowed.includes(value as T)) reject('AGENT_CONTRACT_INVALID', `${path} is not allowed`);
  return value as T;
}

function uniqueValues<T extends string>(value: unknown, path: string, allowed: readonly T[], maximum: number): T[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) reject('AGENT_CONTRACT_INVALID', `${path} must be a non-empty bounded array`);
  const output = value.map((item) => literal(item, allowed, path));
  if (new Set(output).size !== output.length) reject('AGENT_CONTRACT_INVALID', `${path} must not contain duplicates`);
  return output;
}

function parseDate(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    reject('AGENT_CONTRACT_INVALID', `${path} must be an RFC3339 UTC timestamp`);
  }
  return value;
}

function parseLease(value: unknown, path: string): JobLease {
  const object = objectValue(value, path);
  exactFields(object, ['job_id', 'agent_id', 'attempt', 'lease_token', 'lease_expires_at'], [], path);
  return {
    job_id: stringValue(object.job_id, `${path}.job_id`, AGENT_ID),
    agent_id: stringValue(object.agent_id, `${path}.agent_id`, AGENT_ID),
    attempt: integerValue(object.attempt, `${path}.attempt`, 1, 100),
    lease_token: stringValue(object.lease_token, `${path}.lease_token`, UUID, 36),
    lease_expires_at: parseDate(object.lease_expires_at, `${path}.lease_expires_at`),
  };
}

export function validateAgentConfig(value: unknown): AgentConfig {
  const object = objectValue(value, 'agent configuration');
  exactFields(object, ['schema', 'version', 'agent_id', 'agent_version', 'coordinator_endpoint', 'credential', 'capabilities', 'claim_wait_ms', 'idle_delay_ms'], ['heartbeat_interval_ms'], 'agent configuration');
  literal(object.schema, ['ue-codebase-mcp/windows-agent'], 'agent configuration.schema');
  literal(object.version, [AGENT_CONFIG_VERSION], 'agent configuration.version');
  const endpoint = stringValue(object.coordinator_endpoint, 'agent configuration.coordinator_endpoint', /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[^?#]*)?$/);
  const parsedEndpoint = new URL(endpoint);
  if (parsedEndpoint.username || parsedEndpoint.password || parsedEndpoint.search || parsedEndpoint.hash) reject('AGENT_CONTRACT_INVALID', 'coordinator endpoint must not contain credentials, query, or fragment');
  const credential = objectValue(object.credential, 'agent configuration.credential');
  exactFields(credential, ['secret_ref'], [], 'agent configuration.credential');
  const secretRef = stringValue(credential.secret_ref, 'agent configuration.credential.secret_ref', SECRET_REF);
  if (secretRef.slice('secret://'.length).split('/').some((segment) => segment === '.' || segment === '..')) reject('AGENT_CONTRACT_INVALID', 'credential secret_ref is invalid');
  return Object.freeze({
    schema: 'ue-codebase-mcp/windows-agent',
    version: 1,
    agent_id: stringValue(object.agent_id, 'agent configuration.agent_id', AGENT_ID),
    agent_version: stringValue(object.agent_version, 'agent configuration.agent_version', VERSION, 64),
    coordinator_endpoint: endpoint,
    credential: Object.freeze({ secret_ref: secretRef }),
    capabilities: Object.freeze(uniqueValues(object.capabilities, 'agent configuration.capabilities', ['svn-sync', 'clang-index', 'module-index'], 3)) as AgentCapabilityName[],
    claim_wait_ms: integerValue(object.claim_wait_ms, 'agent configuration.claim_wait_ms', 0, 60_000),
    idle_delay_ms: integerValue(object.idle_delay_ms, 'agent configuration.idle_delay_ms', 10, 60_000),
    heartbeat_interval_ms: integerValue(object.heartbeat_interval_ms ?? 10_000, 'agent configuration.heartbeat_interval_ms', 1_000, 60_000),
  });
}

export function validateJobPayload(value: unknown): AgentJobPayload {
  const object = objectValue(value, 'job payload');
  exactFields(object, ['schema', 'version', 'kind', 'project_id', 'revision_set', 'scopes', 'resource_policy'], [], 'job payload');
  literal(object.schema, ['ue-codebase-mcp/reindex-job'], 'job payload.schema');
  literal(object.version, [JOB_SCHEMA_VERSION], 'job payload.version');
  literal(object.kind, ['reindex'], 'job payload.kind');
  const revisionSet = objectValue(object.revision_set, 'job payload.revision_set');
  exactFields(revisionSet, ['hash', 'repositories'], [], 'job payload.revision_set');
  if (!Array.isArray(revisionSet.repositories) || revisionSet.repositories.length === 0 || revisionSet.repositories.length > 64) {
    reject('AGENT_CONTRACT_INVALID', 'job payload.revision_set.repositories must be a non-empty bounded array');
  }
  const repositories = revisionSet.repositories.map((entry, index) => {
    const path = `job payload.revision_set.repositories[${index}]`;
    const repository = objectValue(entry, path);
    exactFields(repository, ['repository_id', 'repository_kind', 'branch', 'revision'], [], path);
    return Object.freeze({
      repository_id: stringValue(repository.repository_id, `${path}.repository_id`, IDENTIFIER),
      repository_kind: literal(repository.repository_kind, ['svn'], `${path}.repository_kind`),
      branch: stringValue(repository.branch, `${path}.branch`, IDENTIFIER),
      revision: stringValue(repository.revision, `${path}.revision`, /^[1-9][0-9]{0,19}$/),
    });
  });
  if (new Set(repositories.map((repository) => repository.repository_id)).size !== repositories.length) reject('AGENT_CONTRACT_INVALID', 'revision set repository IDs must be unique');
  const policy = objectValue(object.resource_policy, 'job payload.resource_policy');
  exactFields(policy, ['timeout_seconds', 'max_memory_mb', 'max_cpu_percent'], [], 'job payload.resource_policy');
  return Object.freeze({
    schema: 'ue-codebase-mcp/reindex-job',
    version: 1,
    kind: 'reindex',
    project_id: stringValue(object.project_id, 'job payload.project_id', IDENTIFIER),
    revision_set: Object.freeze({
      hash: stringValue(revisionSet.hash, 'job payload.revision_set.hash', SHA256, 64),
      repositories: Object.freeze(repositories) as RevisionPin[],
    }),
    scopes: Object.freeze(uniqueValues(object.scopes, 'job payload.scopes', ['engine', 'game', 'plugin'], 3)) as ReindexJobPayload['scopes'],
    resource_policy: Object.freeze({
      timeout_seconds: integerValue(policy.timeout_seconds, 'job payload.resource_policy.timeout_seconds', 30, 86_400),
      max_memory_mb: integerValue(policy.max_memory_mb, 'job payload.resource_policy.max_memory_mb', 512, 262_144),
      max_cpu_percent: integerValue(policy.max_cpu_percent, 'job payload.resource_policy.max_cpu_percent', 1, 100),
    }),
  });
}

export function validateClaimedJob(value: unknown): ClaimedJob {
  const object = objectValue(value, 'claimed job');
  exactFields(object, ['lease', 'payload', 'next_event_sequence'], [], 'claimed job');
  return Object.freeze({
    lease: Object.freeze(parseLease(object.lease, 'claimed job.lease')),
    payload: validateJobPayload(object.payload),
    next_event_sequence: integerValue(object.next_event_sequence, 'claimed job.next_event_sequence', 0, Number.MAX_SAFE_INTEGER),
  });
}

export function validateCompletionManifest(value: unknown): CompletionManifest {
  const object = objectValue(value, 'completion manifest');
  exactFields(object, ['schema', 'version', 'generation_id', 'revision_set_hash', 'manifest_uri', 'manifest_sha256'], [], 'completion manifest');
  literal(object.schema, ['ue-codebase-mcp/reindex-result'], 'completion manifest.schema');
  literal(object.version, [JOB_SCHEMA_VERSION], 'completion manifest.version');
  const manifestUri = stringValue(object.manifest_uri, 'completion manifest.manifest_uri', /^artifact:\/\/[a-z][a-z0-9-]{1,62}\/[A-Za-z0-9._/-]{1,512}$/);
  const artifactSegments = manifestUri.slice('artifact://'.length).split('/');
  if (artifactSegments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    reject('AGENT_CONTRACT_INVALID', 'completion manifest.manifest_uri is invalid');
  }
  return Object.freeze({
    schema: 'ue-codebase-mcp/reindex-result',
    version: 1,
    generation_id: stringValue(object.generation_id, 'completion manifest.generation_id', UUID, 36),
    revision_set_hash: stringValue(object.revision_set_hash, 'completion manifest.revision_set_hash', SHA256, 64),
    manifest_uri: manifestUri,
    manifest_sha256: stringValue(object.manifest_sha256, 'completion manifest.manifest_sha256', SHA256, 64),
  });
}

export function assertCredential(credential: ShortLivedCredential, now: Date): AgentAuth {
  if (typeof credential.token !== 'string' || credential.token.length < 16 || credential.token.length > 8192
      || !/^[A-Za-z0-9._~-]+$/.test(credential.token)) reject('AGENT_CREDENTIAL_INVALID', 'short-lived agent credential is invalid');
  const expiry = parseDate(credential.expires_at, 'short-lived agent credential.expires_at');
  if (Date.parse(expiry) <= now.getTime()) reject('AGENT_CREDENTIAL_EXPIRED', 'short-lived agent credential is expired');
  return Object.freeze({ token: credential.token });
}
