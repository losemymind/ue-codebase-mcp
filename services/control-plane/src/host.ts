import { createServer, type Server } from 'node:http';
import { isIP } from 'node:net';
import {
  createNodeOperationsRequestListener,
  OperationsHttpEndpoint,
} from '../../../apps/mcp-server/src/operations-http.ts';
import {
  createNodeMcpRequestListener,
  StreamableHttpMcpEndpoint,
} from '../../../apps/mcp-server/src/streamable-http.ts';

export interface ControlPlaneListenAddress {
  readonly host: string;
  readonly port: number;
}

export interface BoundControlPlaneAddress extends ControlPlaneListenAddress {
  readonly family: 'IPv4' | 'IPv6';
}

export interface ControlPlaneHostBindings {
  readonly public: BoundControlPlaneAddress;
  readonly operations: BoundControlPlaneAddress;
}

export interface ControlPlaneHttpHostOptions {
  readonly public_listen: ControlPlaneListenAddress;
  readonly operations_listen: ControlPlaneListenAddress;
  readonly max_connections?: number;
  readonly headers_timeout_ms?: number;
  readonly request_timeout_ms?: number;
  readonly keep_alive_timeout_ms?: number;
  readonly shutdown_timeout_ms?: number;
}

const DEFAULT_MAX_CONNECTIONS = 256;
const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 35_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_HEADERS = 64;
const MAX_REQUESTS_PER_SOCKET = 100;

function validPort(value: unknown, allowEphemeral: boolean): value is number {
  return Number.isSafeInteger(value) && (allowEphemeral ? (value as number) >= 0 : (value as number) >= 1)
    && (value as number) <= 65_535;
}

function validateAddress(value: ControlPlaneListenAddress): ControlPlaneListenAddress {
  if (typeof value !== 'object' || value === null || isIP(value.host) === 0 || !validPort(value.port, true)) {
    throw new TypeError('invalid control-plane listen address');
  }
  return Object.freeze({ host: value.host, port: value.port });
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || (result as number) < minimum || (result as number) > maximum) {
    throw new TypeError('invalid control-plane HTTP limit');
  }
  return result as number;
}

export function parseControlPlaneListen(value: string): ControlPlaneListenAddress {
  if (typeof value !== 'string' || value.length < 3 || value.length > 128 || /[\s\0]/u.test(value)) {
    throw new TypeError('invalid control-plane listen value');
  }
  const match = value.startsWith('[')
    ? /^\[([^\]]+)\]:(0|[1-9][0-9]{0,4})$/u.exec(value)
    : /^([^:]+):(0|[1-9][0-9]{0,4})$/u.exec(value);
  if (match === null || isIP(match[1]) === 0) throw new TypeError('invalid control-plane listen value');
  const port = Number(match[2]);
  if (!validPort(port, false)) throw new TypeError('invalid control-plane listen value');
  return Object.freeze({ host: match[1], port });
}

function addressOf(server: Server): BoundControlPlaneAddress {
  const address = server.address();
  if (address === null || typeof address === 'string' || (address.family !== 'IPv4' && address.family !== 'IPv6')) {
    throw new Error('control-plane listener address unavailable');
  }
  return Object.freeze({ host: address.address, port: address.port, family: address.family });
}

function listen(server: Server, address: ControlPlaneListenAddress): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: address.host, port: address.port, exclusive: true });
  });
}

function close(server: Server, timeoutMs: number): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      server.closeAllConnections();
      finish();
    }, timeoutMs);
    timer.unref?.();
    server.close(finish);
    server.closeIdleConnections();
  });
}

function configure(server: Server, options: Required<Pick<ControlPlaneHttpHostOptions,
  'max_connections' | 'headers_timeout_ms' | 'request_timeout_ms' | 'keep_alive_timeout_ms'>>): void {
  server.maxConnections = options.max_connections;
  server.maxHeadersCount = MAX_HEADERS;
  server.maxRequestsPerSocket = MAX_REQUESTS_PER_SOCKET;
  server.headersTimeout = options.headers_timeout_ms;
  server.requestTimeout = options.request_timeout_ms;
  server.keepAliveTimeout = options.keep_alive_timeout_ms;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
    socket.setTimeout(options.request_timeout_ms);
  });
}

export class ControlPlaneHttpHost {
  readonly #publicServer: Server;
  readonly #operationsServer: Server;
  readonly #publicListen: ControlPlaneListenAddress;
  readonly #operationsListen: ControlPlaneListenAddress;
  readonly #shutdownTimeoutMs: number;
  #state: 'created' | 'starting' | 'started' | 'closing' | 'closed' = 'created';

  constructor(publicEndpoint: StreamableHttpMcpEndpoint, operationsEndpoint: OperationsHttpEndpoint,
    options: ControlPlaneHttpHostOptions) {
    if (!(publicEndpoint instanceof StreamableHttpMcpEndpoint) || !(operationsEndpoint instanceof OperationsHttpEndpoint)
        || typeof options !== 'object' || options === null) throw new TypeError('invalid control-plane host configuration');
    this.#publicListen = validateAddress(options.public_listen);
    this.#operationsListen = validateAddress(options.operations_listen);
    if (this.#publicListen.host === this.#operationsListen.host && this.#publicListen.port !== 0
        && this.#publicListen.port === this.#operationsListen.port) throw new TypeError('control-plane listeners must be distinct');
    const limits = Object.freeze({
      max_connections: boundedInteger(options.max_connections, DEFAULT_MAX_CONNECTIONS, 1, 10_000),
      headers_timeout_ms: boundedInteger(options.headers_timeout_ms, DEFAULT_HEADERS_TIMEOUT_MS, 1_000, 30_000),
      request_timeout_ms: boundedInteger(options.request_timeout_ms, DEFAULT_REQUEST_TIMEOUT_MS, 1_000, 60_000),
      keep_alive_timeout_ms: boundedInteger(options.keep_alive_timeout_ms, DEFAULT_KEEP_ALIVE_TIMEOUT_MS, 500, 15_000),
    });
    if (limits.headers_timeout_ms > limits.request_timeout_ms || limits.keep_alive_timeout_ms >= limits.request_timeout_ms) {
      throw new TypeError('invalid control-plane HTTP timeout ordering');
    }
    this.#shutdownTimeoutMs = boundedInteger(options.shutdown_timeout_ms, DEFAULT_SHUTDOWN_TIMEOUT_MS, 1_000, 30_000);
    this.#publicServer = createServer({ maxHeaderSize: MAX_HEADER_BYTES, requireHostHeader: true,
      joinDuplicateHeaders: false, rejectNonStandardBodyWrites: true }, createNodeMcpRequestListener(publicEndpoint));
    this.#operationsServer = createServer({ maxHeaderSize: MAX_HEADER_BYTES, requireHostHeader: true,
      joinDuplicateHeaders: false, rejectNonStandardBodyWrites: true }, createNodeOperationsRequestListener(operationsEndpoint));
    configure(this.#publicServer, limits);
    configure(this.#operationsServer, limits);
  }

  async start(): Promise<ControlPlaneHostBindings> {
    if (this.#state !== 'created') throw new Error('control-plane host cannot be started');
    this.#state = 'starting';
    try {
      await listen(this.#publicServer, this.#publicListen);
      await listen(this.#operationsServer, this.#operationsListen);
      this.#state = 'started';
      return Object.freeze({ public: addressOf(this.#publicServer), operations: addressOf(this.#operationsServer) });
    } catch (error) {
      await Promise.all([close(this.#publicServer, this.#shutdownTimeoutMs), close(this.#operationsServer, this.#shutdownTimeoutMs)]);
      this.#state = 'closed';
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#state === 'closed') return;
    if (this.#state !== 'started') throw new Error('control-plane host is not started');
    this.#state = 'closing';
    await Promise.all([close(this.#publicServer, this.#shutdownTimeoutMs), close(this.#operationsServer, this.#shutdownTimeoutMs)]);
    this.#state = 'closed';
  }
}
