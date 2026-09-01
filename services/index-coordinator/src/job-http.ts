import type { BearerIdentity } from '../../../packages/auth/src/bearer.ts';
import type {
  AgentEventRequest,
  ClaimJobsRequest,
  CompleteJobRequest,
  FailJobRequest,
  HeartbeatRequest,
  RegisterAgentRequest,
} from '../../../workers/windows-agent/src/contracts.ts';
import {
  type AuthenticatedAgent,
  DurableJobLeaseError,
  type DurableJobLeaseService,
} from './job-lease.ts';

export interface InternalJobHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: string | Uint8Array;
}
export interface InternalJobHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}
export interface AgentHttpAuthenticator {
  authenticate(authorizationHeader: string): Promise<AuthenticatedAgent>;
}
export interface AgentBearerAuthenticationService {
  authenticate(authorizationHeader: string): Promise<BearerIdentity>;
}
export interface InternalJobHttpOptions {
  readonly allowed_hosts: readonly string[];
  readonly max_body_bytes?: number;
  readonly request_timeout_ms?: number;
}

const MAX_BODY_BYTES = 256 * 1024;
const MAX_TIMEOUT_MS = 70_000;
const HOST = /^(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::[0-9]{1,5})?$/;
const UUID = '[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-5][a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}';
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const JOB_ROUTE = new RegExp(`^/internal/v1/jobs/(${UUID})/(heartbeat|events|complete|fail)$`);

function response(status: number, body?: unknown, extra: Readonly<Record<string, string>> = {}): InternalJobHttpResponse {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  return Object.freeze({ status, headers: Object.freeze({
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    ...(encoded === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }), ...extra,
  }), ...(encoded === undefined ? {} : { body: encoded }) });
}

function normalizedHeaders(headers: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string | undefined>> {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) throw new TypeError('invalid headers');
  const output: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!/^[a-z0-9-]{1,64}$/.test(lower) || lower in output
        || (value !== undefined && (typeof value !== 'string' || /[\r\n\0]/.test(value)))) throw new TypeError('invalid headers');
    output[lower] = value;
  }
  return Object.freeze(output);
}

function contentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const parts = value.split(';').map((part) => part.trim().toLowerCase());
  return parts[0] === 'application/json' && parts.slice(1).every((part) => part === 'charset=utf-8');
}

function acceptsJson(value: string | undefined): boolean {
  return value !== undefined && value.split(',').some((item) => item.trim().split(';', 1)[0].trim().toLowerCase() === 'application/json');
}

function parseBody(body: string | Uint8Array | undefined, maximum: number): unknown {
  if (body === undefined) throw new TypeError('missing body');
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
  if (bytes.byteLength < 1 || bytes.byteLength > maximum) throw new TypeError('invalid body');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (Buffer.byteLength(text, 'utf8') !== bytes.byteLength) throw new TypeError('invalid body');
  return JSON.parse(text);
}

function timeout<Result>(operation: Promise<Result>, milliseconds: number): Promise<Result> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('request timeout')), milliseconds);
    timer.unref?.();
    operation.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function validHost(value: unknown): value is string {
  if (typeof value !== 'string' || !HOST.test(value)) return false;
  const port = /:(\d{1,5})$/.exec(value)?.[1];
  return port === undefined || Number(port) <= 65_535;
}

export function createAgentBearerAuthenticator(service: AgentBearerAuthenticationService): AgentHttpAuthenticator {
  if (typeof service !== 'object' || service === null || typeof service.authenticate !== 'function') throw new TypeError('invalid bearer service');
  return Object.freeze({
    async authenticate(header: string): Promise<AuthenticatedAgent> {
      const identity = await service.authenticate(header);
      if (typeof identity !== 'object' || identity === null || identity.kind !== 'bearer' || identity.ownerType !== 'service'
          || !Array.isArray(identity.scopes) || !identity.scopes.includes('agent:work')) throw new Error('authentication failed');
      return Object.freeze({ agent_id: identity.ownerId });
    },
  });
}

export class InternalJobHttpEndpoint {
  readonly #service: DurableJobLeaseService;
  readonly #authenticator: AgentHttpAuthenticator;
  readonly #allowedHosts: ReadonlySet<string>;
  readonly #maxBodyBytes: number;
  readonly #timeoutMs: number;

  constructor(service: DurableJobLeaseService, authenticator: AgentHttpAuthenticator, options: InternalJobHttpOptions) {
    if (typeof service !== 'object' || service === null || typeof service.claim !== 'function'
        || typeof authenticator !== 'object' || authenticator === null || typeof authenticator.authenticate !== 'function'
        || typeof options !== 'object' || options === null || !Array.isArray(options.allowed_hosts)
        || options.allowed_hosts.length < 1 || options.allowed_hosts.length > 64) throw new TypeError('invalid internal job HTTP configuration');
    const hosts = options.allowed_hosts.map((host) => {
      if (!validHost(host)) throw new TypeError('invalid internal job host');
      return host.toLowerCase();
    });
    if (new Set(hosts).size !== hosts.length) throw new TypeError('duplicate internal job host');
    this.#maxBodyBytes = options.max_body_bytes ?? MAX_BODY_BYTES;
    this.#timeoutMs = options.request_timeout_ms ?? 65_000;
    if (!Number.isSafeInteger(this.#maxBodyBytes) || this.#maxBodyBytes < 1024 || this.#maxBodyBytes > MAX_BODY_BYTES
        || !Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1_000 || this.#timeoutMs > MAX_TIMEOUT_MS) {
      throw new TypeError('invalid internal job HTTP limits');
    }
    this.#service = service;
    this.#authenticator = authenticator;
    this.#allowedHosts = new Set(hosts);
  }

  async handle(request: InternalJobHttpRequest): Promise<InternalJobHttpResponse> {
    try {
      if (typeof request !== 'object' || request === null || typeof request.method !== 'string'
          || typeof request.path !== 'string' || !/^\/[A-Za-z0-9._~/-]{1,255}$/.test(request.path)) return response(400, { error: 'invalid_request' });
      const headers = normalizedHeaders(request.headers);
      if (headers.host === undefined || !this.#allowedHosts.has(headers.host.toLowerCase()) || headers.origin !== undefined) {
        return response(403, { error: 'forbidden' });
      }
      const deadline = Date.now() + this.#timeoutMs;
      const remaining = (): number => Math.max(1, deadline - Date.now());
      let identity: AuthenticatedAgent;
      try {
        if (headers.authorization === undefined || headers.authorization.length > 8192) throw new Error('missing authentication');
        identity = await timeout(this.#authenticator.authenticate(headers.authorization), remaining());
        if (typeof identity !== 'object' || identity === null || !AGENT_ID.test(identity.agent_id)) throw new Error('invalid identity');
      } catch { return response(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer scope="agent:work"' }); }
      if (request.method.toUpperCase() !== 'POST') return response(405, undefined, { Allow: 'POST' });
      if (!contentType(headers['content-type'])) return response(415, { error: 'invalid_content_type' });
      if (!acceptsJson(headers.accept)) return response(406, { error: 'not_acceptable' });
      let body: unknown;
      try { body = parseBody(request.body, this.#maxBodyBytes); } catch { return response(400, { error: 'invalid_json' }); }
      let result: unknown;
      if (request.path === '/internal/v1/agents/register') {
        result = await timeout(this.#service.register(body as RegisterAgentRequest, identity), remaining());
      } else if (request.path === '/internal/v1/jobs/claim') {
        result = await timeout(this.#service.claim(body as ClaimJobsRequest, identity), remaining());
      } else {
        const route = JOB_ROUTE.exec(request.path);
        if (route === null) return response(404, { error: 'not_found' });
        if (typeof body !== 'object' || body === null || Array.isArray(body)
            || (body as Record<string, unknown>).job_id !== route[1]) return response(400, { error: 'invalid_request' });
        if (route[2] === 'heartbeat') result = await timeout(this.#service.heartbeat(body as HeartbeatRequest, identity), remaining());
        else if (route[2] === 'events') result = await timeout(this.#service.event(body as AgentEventRequest, identity), remaining());
        else if (route[2] === 'complete') result = await timeout(this.#service.complete(body as CompleteJobRequest, identity), remaining());
        else result = await timeout(this.#service.fail(body as FailJobRequest, identity), remaining());
      }
      return response(200, result);
    } catch (error) {
      if (error instanceof DurableJobLeaseError) {
        if (error.code === 'invalid-request') return response(400, { error: error.code });
        if (error.code === 'agent-disabled') return response(403, { error: error.code });
        return response(503, { error: error.code });
      }
      return response(503, { error: 'service_unavailable' });
    }
  }
}
