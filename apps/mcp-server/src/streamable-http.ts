import type { IncomingMessage, ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { BearerIdentity } from '../../../packages/auth/src/bearer.ts';
import {
  createObservationContext,
  traceparent,
  type ObservationContext,
  type ObservabilityRecorder,
} from '../../../packages/observability/src/index.ts';
import {
  MCP_PROTOCOL_VERSIONS,
  type McpPrincipal,
  type McpProtocolContext,
  type ReadOnlyMcpServer,
} from './server.ts';

export interface McpHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: string | Uint8Array;
}

export interface McpHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface McpRequestAuthenticator {
  authenticate(authorizationHeader: string): Promise<McpPrincipal>;
}

export interface McpRequestRateLimiter {
  allow(principal: McpPrincipal): Promise<boolean>;
}

export interface BearerAuthenticationService {
  authenticate(authorizationHeader: string): Promise<BearerIdentity>;
}

export interface StreamableHttpMcpOptions {
  readonly mcp_path?: string;
  readonly metadata_path?: string;
  readonly resource_uri: string;
  readonly authorization_servers: readonly string[];
  readonly allowed_origins: readonly string[];
  readonly allowed_hosts: readonly string[];
  readonly max_body_bytes?: number;
  readonly request_timeout_ms?: number;
  readonly rate_limiter: McpRequestRateLimiter;
  readonly observability: ObservabilityRecorder;
}

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 60_000;
const PATH = /^\/[A-Za-z0-9._~/-]{0,255}$/;
const HOST = /^(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::[0-9]{1,5})?$/;

function validHost(value: unknown): value is string {
  if (typeof value !== 'string' || !HOST.test(value)) return false;
  const port = /:(\d{1,5})$/.exec(value)?.[1];
  return port === undefined || Number(port) <= 65_535;
}

function response(status: number, body?: Readonly<Record<string, unknown>>, extra: Readonly<Record<string, string>> = {}): McpHttpResponse {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  return Object.freeze({
    status,
    headers: Object.freeze({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(encoded === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
      ...extra,
    }),
    ...(encoded === undefined ? {} : { body: encoded }),
  });
}

function transportError(status: number, code: number, message: string): McpHttpResponse {
  return response(status, Object.freeze({ jsonrpc: '2.0', id: null, error: Object.freeze({ code, message }) }));
}

function safeUrl(value: unknown, protocols: readonly string[]): URL {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048 || /[\r\n\0]/.test(value)) throw new TypeError('invalid URL');
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError('invalid URL'); }
  if (!protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('invalid URL');
  return url;
}

function canonicalOrigin(value: string): string {
  const url = safeUrl(value, ['https:', 'http:']);
  if (url.pathname !== '/') throw new TypeError('invalid origin');
  return url.origin;
}

function normalizedHeaders(headers: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string | undefined>> {
  const result: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!/^[a-z0-9-]{1,64}$/.test(lower) || lower in result || (value !== undefined && (typeof value !== 'string' || /[\r\n\0]/.test(value)))) {
      throw new TypeError('invalid headers');
    }
    result[lower] = value;
  }
  return Object.freeze(result);
}

function accepted(header: string | undefined, mediaType: string): boolean {
  if (header === undefined) return false;
  return header.split(',').some((entry) => entry.trim().split(';', 1)[0].trim().toLowerCase() === mediaType);
}

function jsonContentType(header: string | undefined): boolean {
  if (header === undefined) return false;
  const parts = header.split(';').map((part) => part.trim().toLowerCase());
  return parts[0] === 'application/json' && parts.slice(1).every((part) => part === 'charset=utf-8');
}

function strictBody(body: string | Uint8Array | undefined, maximum: number): string {
  if (body === undefined) throw new TypeError('missing body');
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
  if (bytes.byteLength < 1 || bytes.byteLength > maximum) throw new TypeError('invalid body');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (Buffer.byteLength(text, 'utf8') !== bytes.byteLength) throw new TypeError('invalid body');
  return text;
}

function withTimeout<Result>(operation: Promise<Result>, milliseconds: number): Promise<Result> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('request timeout')), milliseconds);
    timer.unref?.();
    operation.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

export function createBearerAuthenticator(service: BearerAuthenticationService): McpRequestAuthenticator {
  if (typeof service !== 'object' || service === null || typeof service.authenticate !== 'function') throw new TypeError('invalid bearer service');
  return Object.freeze({
    async authenticate(authorizationHeader: string): Promise<McpPrincipal> {
      const identity = await service.authenticate(authorizationHeader);
      if (typeof identity !== 'object' || identity === null || identity.kind !== 'bearer'
          || !Array.isArray(identity.scopes) || !identity.scopes.includes('mcp:read')) throw new Error('authentication failed');
      return Object.freeze({ type: identity.ownerType, id: identity.ownerId, credential_id: identity.tokenId,
        scopes: Object.freeze([...identity.scopes]) });
    },
  });
}

export class StreamableHttpMcpEndpoint {
  readonly #server: ReadOnlyMcpServer;
  readonly #authenticator: McpRequestAuthenticator;
  readonly #mcpPath: string;
  readonly #metadataPath: string;
  readonly #resourceUri: string;
  readonly #authorizationServers: readonly string[];
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #allowedHosts: ReadonlySet<string>;
  readonly #maximumBodyBytes: number;
  readonly #timeoutMs: number;
  readonly #rateLimiter: McpRequestRateLimiter;
  readonly #observability: ObservabilityRecorder;
  readonly #challenge: string;

  constructor(server: ReadOnlyMcpServer, authenticator: McpRequestAuthenticator, options: StreamableHttpMcpOptions) {
    if (typeof server !== 'object' || server === null || typeof server.handle !== 'function'
        || typeof authenticator !== 'object' || authenticator === null || typeof authenticator.authenticate !== 'function'
        || typeof options !== 'object' || options === null || typeof options.rate_limiter !== 'object'
        || options.rate_limiter === null || typeof options.rate_limiter.allow !== 'function'
        || typeof options.observability !== 'object' || options.observability === null
        || typeof options.observability.record !== 'function') throw new TypeError('invalid HTTP MCP configuration');
    const mcpPath = options.mcp_path ?? '/mcp';
    const metadataPath = options.metadata_path ?? '/.well-known/oauth-protected-resource';
    if (!PATH.test(mcpPath) || !PATH.test(metadataPath) || mcpPath === metadataPath) throw new TypeError('invalid HTTP MCP path');
    const resource = safeUrl(options.resource_uri, ['https:']);
    if (resource.pathname !== mcpPath) throw new TypeError('resource URI must identify MCP path');
    if (!Array.isArray(options.authorization_servers) || options.authorization_servers.length < 1 || options.authorization_servers.length > 8) {
      throw new TypeError('invalid authorization servers');
    }
    const authorizationServers = options.authorization_servers.map((value) => safeUrl(value, ['https:']).href.replace(/\/$/, ''));
    if (new Set(authorizationServers).size !== authorizationServers.length || !Array.isArray(options.allowed_origins)
        || options.allowed_origins.length < 1 || options.allowed_origins.length > 64 || !Array.isArray(options.allowed_hosts)
        || options.allowed_hosts.length < 1 || options.allowed_hosts.length > 64) throw new TypeError('invalid HTTP MCP allowlist');
    const origins = options.allowed_origins.map(canonicalOrigin);
    const hosts = options.allowed_hosts.map((host) => {
      if (!validHost(host)) throw new TypeError('invalid host');
      return host.toLowerCase();
    });
    if (new Set(origins).size !== origins.length || new Set(hosts).size !== hosts.length) throw new TypeError('duplicate HTTP MCP allowlist');
    const maximumBodyBytes = options.max_body_bytes ?? MAX_BODY_BYTES;
    const timeoutMs = options.request_timeout_ms ?? 30_000;
    if (!Number.isSafeInteger(maximumBodyBytes) || maximumBodyBytes < 1024 || maximumBodyBytes > MAX_BODY_BYTES
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) throw new TypeError('invalid HTTP MCP limits');
    this.#server = server;
    this.#authenticator = authenticator;
    this.#mcpPath = mcpPath;
    this.#metadataPath = metadataPath;
    this.#resourceUri = resource.href;
    this.#authorizationServers = Object.freeze(authorizationServers);
    this.#allowedOrigins = new Set(origins);
    this.#allowedHosts = new Set(hosts);
    this.#maximumBodyBytes = maximumBodyBytes;
    this.#timeoutMs = timeoutMs;
    this.#rateLimiter = options.rate_limiter;
    this.#observability = options.observability;
    this.#challenge = `Bearer resource_metadata="${new URL(metadataPath, resource.origin).href}", scope="mcp:read"`;
  }

  #metadata(): McpHttpResponse {
    return response(200, Object.freeze({
      resource: this.#resourceUri,
      authorization_servers: this.#authorizationServers,
      scopes_supported: Object.freeze(['mcp:read']),
      bearer_methods_supported: Object.freeze(['header']),
    }));
  }

  async #handle(request: McpHttpRequest, headers: Readonly<Record<string, string | undefined>>,
    observation: ObservationContext): Promise<McpHttpResponse> {
    try {
      if (typeof request !== 'object' || request === null || typeof request.method !== 'string'
          || typeof request.path !== 'string' || !PATH.test(request.path)) return transportError(400, -32600, 'Invalid Request');
      const host = headers.host?.toLowerCase();
      if (host === undefined || !this.#allowedHosts.has(host)) return transportError(403, -32000, 'Forbidden');
      if (headers.origin !== undefined) {
        let origin: string;
        try { origin = canonicalOrigin(headers.origin); } catch { return transportError(403, -32000, 'Forbidden'); }
        if (!this.#allowedOrigins.has(origin)) return transportError(403, -32000, 'Forbidden');
      }
      const method = request.method.toUpperCase();
      if (request.path === this.#metadataPath) {
        if (method !== 'GET') return response(405, undefined, { Allow: 'GET' });
        return this.#metadata();
      }
      if (request.path !== this.#mcpPath) return response(404);
      let principal: McpPrincipal;
      const deadline = Date.now() + this.#timeoutMs;
      const remaining = (): number => Math.max(1, deadline - Date.now());
      try {
        if (headers.authorization === undefined || headers.authorization.length > 4096) throw new Error('missing authentication');
        principal = await withTimeout(this.#authenticator.authenticate(headers.authorization), remaining());
        if (typeof principal !== 'object' || principal === null || !Array.isArray(principal.scopes)
            || !principal.scopes.includes('mcp:read')) throw new Error('insufficient scope');
      } catch {
        return response(401, undefined, { 'WWW-Authenticate': this.#challenge });
      }
      if (method !== 'POST') return response(405, undefined, { Allow: 'POST' });
      try {
        if (!await withTimeout(this.#rateLimiter.allow(principal), remaining())) {
          return response(429, undefined, { 'Retry-After': '1' });
        }
      } catch {
        return transportError(503, -32603, 'Service unavailable');
      }
      if (!jsonContentType(headers['content-type'])) return transportError(415, -32600, 'Content-Type must be application/json');
      if (!accepted(headers.accept, 'application/json') || !accepted(headers.accept, 'text/event-stream')) {
        return transportError(406, -32600, 'Accept must include application/json and text/event-stream');
      }
      let message: unknown;
      try { message = JSON.parse(strictBody(request.body, this.#maximumBodyBytes)); } catch { return transportError(400, -32700, 'Parse error'); }
      if (Array.isArray(message)) return transportError(400, -32600, 'Batch requests are not supported');
      const object = typeof message === 'object' && message !== null ? message as Record<string, unknown> : undefined;
      const initializing = object?.method === 'initialize';
      const protocolVersion = headers['mcp-protocol-version'] ?? (initializing ? undefined : '2025-03-26');
      if (protocolVersion !== undefined && !MCP_PROTOCOL_VERSIONS.includes(protocolVersion as typeof MCP_PROTOCOL_VERSIONS[number])) {
        return transportError(400, -32602, 'Unsupported MCP protocol version');
      }
      const context: McpProtocolContext = Object.freeze({ principal, observation,
        ...(protocolVersion === undefined ? {} : { protocol_version: protocolVersion }) });
      const reply = await withTimeout(this.#server.handle(message, context), remaining());
      if (reply.kind === 'accepted') return response(202);
      return response(200, reply.body);
    } catch {
      return transportError(500, -32603, 'Internal error');
    }
  }

  async handle(request: McpHttpRequest): Promise<McpHttpResponse> {
    const started = performance.now();
    let observation = createObservationContext();
    let result: McpHttpResponse;
    try {
      const headers = normalizedHeaders(request?.headers ?? {});
      observation = createObservationContext(headers);
      result = await this.#handle(request, headers, observation);
    } catch {
      result = transportError(400, -32600, 'Invalid Request');
    }
    const method = typeof request?.method === 'string' && ['GET', 'POST', 'DELETE'].includes(request.method.toUpperCase())
      ? request.method.toLowerCase() : 'other';
    const outcome = result.status < 400 ? 'succeeded' : result.status === 401 || result.status === 403 || result.status === 429 ? 'denied' : 'failed';
    this.#observability.record(Object.freeze({ context: observation, component: 'mcp-http', operation: 'request', outcome,
      duration_ms: performance.now() - started, attributes: Object.freeze({ method, status_code: result.status }) }));
    return Object.freeze({ ...result, headers: Object.freeze({ ...result.headers,
      'X-Correlation-ID': observation.correlation_id, traceparent: traceparent(observation) }) });
  }
}

export function createNodeMcpRequestListener(endpoint: StreamableHttpMcpEndpoint): (request: IncomingMessage, responseValue: ServerResponse) => void {
  if (!(endpoint instanceof StreamableHttpMcpEndpoint)) throw new TypeError('invalid endpoint');
  return (request, responseValue) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let oversized = false;
    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_BODY_BYTES) oversized = true;
      else chunks.push(buffer);
    });
    request.on('end', () => {
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) headers[name] = value.join(', ');
        else headers[name] = value;
      }
      let path = '/';
      try {
        const url = new URL(request.url ?? '/', 'http://localhost');
        path = url.search.length === 0 && url.hash.length === 0 ? url.pathname : '';
      } catch { path = ''; }
      const operation = oversized
        ? Promise.resolve(transportError(413, -32600, 'Request body too large'))
        : endpoint.handle(Object.freeze({ method: request.method ?? '', path, headers: Object.freeze(headers), body: Buffer.concat(chunks) }));
      operation.then((result) => {
        responseValue.writeHead(result.status, result.headers);
        responseValue.end(result.body);
      }, () => {
        const result = transportError(500, -32603, 'Internal error');
        responseValue.writeHead(result.status, result.headers);
        responseValue.end(result.body);
      });
    });
    request.on('error', () => {
      if (!responseValue.headersSent) {
        const result = transportError(400, -32700, 'Parse error');
        responseValue.writeHead(result.status, result.headers);
        responseValue.end(result.body);
      }
    });
  };
}
