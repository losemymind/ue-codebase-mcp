import type { IncomingMessage, ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import {
  createObservationContext,
  traceparent,
  type ObservationContext,
  type ObservabilityRecorder,
} from '../../../packages/observability/src/index.ts';

export interface OperationsHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: string | Uint8Array;
}

export interface OperationsHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface ReadinessProbe {
  check(): Promise<boolean>;
}

export interface MetricsAuthorizer {
  authorize(authorizationHeader: string): Promise<boolean>;
}

export interface OperationsHttpOptions {
  readonly allowed_hosts: readonly string[];
  readonly readiness: ReadinessProbe;
  readonly metrics_authorizer: MetricsAuthorizer;
  readonly observability: ObservabilityRecorder;
  readonly readiness_timeout_ms?: number;
}

const HOST = /^(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::[0-9]{1,5})?$/;
const PATHS = new Set(['/health/live', '/health/ready', '/metrics']);

function validHost(value: unknown): value is string {
  if (typeof value !== 'string' || !HOST.test(value)) return false;
  const port = /:(\d{1,5})$/.exec(value)?.[1];
  return port === undefined || Number(port) <= 65_535;
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

function response(status: number, contentType: string, body?: string,
  extra: Readonly<Record<string, string>> = {}): OperationsHttpResponse {
  return Object.freeze({ status, headers: Object.freeze({
    'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff', ...(body === undefined ? {} : { 'Content-Type': contentType }), ...extra,
  }), ...(body === undefined ? {} : { body }) });
}

function json(status: number, state: string): OperationsHttpResponse {
  return response(status, 'application/json; charset=utf-8', JSON.stringify(Object.freeze({ status: state })));
}

function timeout<Result>(operation: Promise<Result>, milliseconds: number): Promise<Result> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('readiness timeout')), milliseconds);
    timer.unref?.();
    operation.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function operation(path: unknown): 'health-live' | 'health-ready' | 'metrics' | 'unknown' {
  if (path === '/health/live') return 'health-live';
  if (path === '/health/ready') return 'health-ready';
  if (path === '/metrics') return 'metrics';
  return 'unknown';
}

function attachContext(result: OperationsHttpResponse, context: ObservationContext): OperationsHttpResponse {
  return Object.freeze({ ...result, headers: Object.freeze({ ...result.headers,
    'X-Correlation-ID': context.correlation_id, traceparent: traceparent(context) }) });
}

export class OperationsHttpEndpoint {
  readonly #allowedHosts: ReadonlySet<string>;
  readonly #readiness: ReadinessProbe;
  readonly #metricsAuthorizer: MetricsAuthorizer;
  readonly #observability: ObservabilityRecorder;
  readonly #readinessTimeoutMs: number;

  constructor(options: OperationsHttpOptions) {
    if (typeof options !== 'object' || options === null || !Array.isArray(options.allowed_hosts)
        || options.allowed_hosts.length < 1 || options.allowed_hosts.length > 32
        || typeof options.readiness !== 'object' || options.readiness === null || typeof options.readiness.check !== 'function'
        || typeof options.metrics_authorizer !== 'object' || options.metrics_authorizer === null
        || typeof options.metrics_authorizer.authorize !== 'function'
        || typeof options.observability !== 'object' || options.observability === null
        || typeof options.observability.record !== 'function') throw new TypeError('invalid operations HTTP configuration');
    const hosts = options.allowed_hosts.map((host) => {
      if (!validHost(host)) throw new TypeError('invalid operations host');
      return host.toLowerCase();
    });
    if (new Set(hosts).size !== hosts.length) throw new TypeError('duplicate operations host');
    this.#readinessTimeoutMs = options.readiness_timeout_ms ?? 2_000;
    if (!Number.isSafeInteger(this.#readinessTimeoutMs) || this.#readinessTimeoutMs < 100
        || this.#readinessTimeoutMs > 10_000) throw new TypeError('invalid readiness timeout');
    this.#allowedHosts = new Set(hosts);
    this.#readiness = options.readiness;
    this.#metricsAuthorizer = options.metrics_authorizer;
    this.#observability = options.observability;
  }

  async #handle(request: OperationsHttpRequest, headers: Readonly<Record<string, string | undefined>>): Promise<OperationsHttpResponse> {
    if (typeof request !== 'object' || request === null || typeof request.method !== 'string'
        || typeof request.path !== 'string' || !PATHS.has(request.path)) return response(404, 'text/plain; charset=utf-8');
    if (headers.host === undefined || !this.#allowedHosts.has(headers.host.toLowerCase()) || headers.origin !== undefined) {
      return json(403, 'forbidden');
    }
    if (request.method.toUpperCase() !== 'GET') return response(405, 'text/plain; charset=utf-8', undefined, { Allow: 'GET' });
    if (request.body !== undefined && (typeof request.body === 'string' ? request.body.length : request.body.byteLength) > 0) {
      return json(400, 'invalid_request');
    }
    if (request.path === '/health/live') return json(200, 'live');
    if (request.path === '/health/ready') {
      try {
        return await timeout(this.#readiness.check(), this.#readinessTimeoutMs) ? json(200, 'ready') : json(503, 'not_ready');
      } catch { return json(503, 'not_ready'); }
    }
    const authorization = headers.authorization;
    if (authorization === undefined || authorization.length > 4096) {
      return response(401, 'text/plain; charset=utf-8', undefined, { 'WWW-Authenticate': 'Bearer scope="metrics:read"' });
    }
    try {
      if (!await timeout(this.#metricsAuthorizer.authorize(authorization), this.#readinessTimeoutMs)) {
        return response(403, 'text/plain; charset=utf-8');
      }
    } catch { return response(503, 'text/plain; charset=utf-8'); }
    return response(200, 'text/plain; version=0.0.4; charset=utf-8', this.#observability.metrics());
  }

  async handle(request: OperationsHttpRequest): Promise<OperationsHttpResponse> {
    const started = performance.now();
    let context = createObservationContext();
    let result: OperationsHttpResponse;
    try {
      const headers = normalizedHeaders(request?.headers ?? {});
      context = createObservationContext(headers);
      result = await this.#handle(request, headers);
    } catch { result = json(400, 'invalid_request'); }
    const outcome = result.status < 400 ? 'succeeded' : result.status === 401 || result.status === 403 ? 'denied' : 'failed';
    this.#observability.record(Object.freeze({ context, component: 'mcp-http', operation: operation(request?.path), outcome,
      duration_ms: performance.now() - started, attributes: Object.freeze({ status_code: result.status }) }));
    return attachContext(result, context);
  }
}

export function createNodeOperationsRequestListener(endpoint: OperationsHttpEndpoint):
  (request: IncomingMessage, responseValue: ServerResponse) => void {
  if (!(endpoint instanceof OperationsHttpEndpoint)) throw new TypeError('invalid operations endpoint');
  return (request, responseValue) => {
    let bodyPresent = false;
    request.on('data', (chunk: Buffer | string) => {
      if ((Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk)) > 0) bodyPresent = true;
    });
    request.on('end', () => {
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) headers[name] = value.join(', ');
        else headers[name] = value;
      }
      let requestPath = '';
      try {
        const url = new URL(request.url ?? '/', 'http://localhost');
        requestPath = url.search.length === 0 && url.hash.length === 0 ? url.pathname : '';
      } catch { requestPath = ''; }
      endpoint.handle(Object.freeze({ method: request.method ?? '', path: requestPath,
        headers: Object.freeze(headers), ...(bodyPresent ? { body: new Uint8Array([1]) } : {}) })).then((result) => {
        responseValue.writeHead(result.status, result.headers);
        responseValue.end(result.body);
      }, () => {
        responseValue.writeHead(500, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' });
        responseValue.end('{"status":"internal_error"}');
      });
    });
    request.on('error', () => {
      if (!responseValue.headersSent) {
        responseValue.writeHead(400, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' });
        responseValue.end('{"status":"invalid_request"}');
      }
    });
  };
}
