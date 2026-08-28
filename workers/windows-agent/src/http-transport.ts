import {
  type AgentAuth,
  type AgentEventRequest,
  type AgentTransport,
  type ClaimJobsRequest,
  type ClaimedJob,
  type CompleteJobRequest,
  type FailJobRequest,
  type FencedOperationResponse,
  type HeartbeatRequest,
  type RegisterAgentRequest,
  type RegisterAgentResponse,
  validateClaimedJob,
} from './contracts.ts';

const MAX_RESPONSE_BYTES = 262_144;

function responseObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${name} response is invalid`);
  return value as Record<string, unknown>;
}

function fencedResponse(value: unknown): FencedOperationResponse {
  const object = responseObject(value, 'fenced operation');
  const keys = Object.keys(object);
  if (keys.some((key) => !['accepted', 'disposition', 'lease_expires_at'].includes(key))) throw new TypeError('fenced operation response contains an unknown field');
  if (typeof object.accepted !== 'boolean' || !['accepted', 'already_applied', 'lease_lost', 'sequence_conflict'].includes(object.disposition as string)) {
    throw new TypeError('fenced operation response is invalid');
  }
  if (object.lease_expires_at !== undefined && (typeof object.lease_expires_at !== 'string' || Number.isNaN(Date.parse(object.lease_expires_at)))) {
    throw new TypeError('fenced operation lease expiry is invalid');
  }
  return Object.freeze({
    accepted: object.accepted,
    disposition: object.disposition,
    ...(object.lease_expires_at === undefined ? {} : { lease_expires_at: object.lease_expires_at }),
  }) as FencedOperationResponse;
}

export class HttpAgentTransport implements AgentTransport {
  readonly #endpoint: URL;
  readonly #timeoutMs: number;

  constructor(coordinatorEndpoint: string, options: { timeout_ms?: number } = {}) {
    this.#endpoint = new URL(coordinatorEndpoint);
    if (this.#endpoint.protocol !== 'https:' || this.#endpoint.username || this.#endpoint.password || this.#endpoint.search || this.#endpoint.hash) {
      throw new TypeError('coordinator endpoint must be an administrator-configured HTTPS URL');
    }
    this.#timeoutMs = options.timeout_ms ?? 65_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1_000 || this.#timeoutMs > 120_000) throw new RangeError('HTTP timeout is out of bounds');
  }

  async #post(pathname: string, body: unknown, auth: AgentAuth): Promise<unknown> {
    if (typeof auth.token !== 'string' || auth.token.length < 16 || auth.token.length > 8192) throw new TypeError('agent authentication is invalid');
    const url = new URL(pathname, this.#endpoint);
    if (url.origin !== this.#endpoint.origin) throw new TypeError('internal API path escaped the configured coordinator origin');
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(this.#timeoutMs),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${auth.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`coordinator request failed with HTTP ${response.status}`);
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) throw new Error('coordinator response exceeded the configured limit');
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('coordinator response exceeded the configured limit');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('coordinator returned invalid JSON');
    }
  }

  async register(request: RegisterAgentRequest, auth: AgentAuth): Promise<RegisterAgentResponse> {
    const object = responseObject(await this.#post('/internal/v1/agents/register', request, auth), 'register');
    if (Object.keys(object).some((key) => !['accepted', 'registered_at'].includes(key)) || object.accepted !== true || typeof object.registered_at !== 'string' || Number.isNaN(Date.parse(object.registered_at))) {
      throw new TypeError('register response is invalid');
    }
    return { accepted: true, registered_at: object.registered_at };
  }

  async claim(request: ClaimJobsRequest, auth: AgentAuth): Promise<ClaimedJob | null> {
    const response = await this.#post('/internal/v1/jobs/claim', request, auth);
    return response === null ? null : validateClaimedJob(response);
  }

  heartbeat(request: HeartbeatRequest, auth: AgentAuth): Promise<FencedOperationResponse> {
    return this.#post(`/internal/v1/jobs/${encodeURIComponent(request.job_id)}/heartbeat`, request, auth).then(fencedResponse);
  }

  event(request: AgentEventRequest, auth: AgentAuth): Promise<FencedOperationResponse> {
    return this.#post(`/internal/v1/jobs/${encodeURIComponent(request.job_id)}/events`, request, auth).then(fencedResponse);
  }

  complete(request: CompleteJobRequest, auth: AgentAuth): Promise<FencedOperationResponse> {
    return this.#post(`/internal/v1/jobs/${encodeURIComponent(request.job_id)}/complete`, request, auth).then(fencedResponse);
  }

  fail(request: FailJobRequest, auth: AgentAuth): Promise<FencedOperationResponse> {
    return this.#post(`/internal/v1/jobs/${encodeURIComponent(request.job_id)}/fail`, request, auth).then(fencedResponse);
  }
}
