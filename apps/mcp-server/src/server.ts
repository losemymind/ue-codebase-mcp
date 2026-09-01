import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  isReadOnlyToolName,
  parseToolArguments,
  READ_ONLY_TOOLS,
  ToolContractError,
  type ReadOnlyToolName,
} from '../../../packages/contracts/src/read-only-tools.ts';
import {
  assertObservationContext,
  type ObservationContext,
  type ObservabilityRecorder,
  type SecurityAuditEvent,
  type SecurityAuditSink,
} from '../../../packages/observability/src/index.ts';
import { CursorError, OpaqueCursorCodec } from './cursor.ts';

export const MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26'] as const);
export const MCP_LATEST_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0];

export interface McpPrincipal {
  readonly type: 'user' | 'service';
  readonly id: string;
  readonly credential_id: string;
  readonly scopes: readonly string[];
}

export interface ReadOnlyToolBackendRequest {
  readonly tool: ReadOnlyToolName;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly principal: McpPrincipal;
  readonly position?: string;
  readonly limit: number;
  readonly request_hash: string;
  readonly observation: ObservationContext;
}

export interface ReadOnlyToolBackendResult {
  readonly items: readonly Readonly<Record<string, unknown>>[];
  readonly next_position?: string;
}

export interface ReadOnlyToolBackend {
  execute(request: ReadOnlyToolBackendRequest): Promise<Readonly<ReadOnlyToolBackendResult>>;
}

export type McpAuditEvent = SecurityAuditEvent;

export interface McpAuditSink extends SecurityAuditSink {}

export interface McpProtocolContext {
  readonly principal: McpPrincipal;
  readonly protocol_version?: string;
  readonly observation: ObservationContext;
}

export interface McpProtocolReply {
  readonly kind: 'response' | 'accepted';
  readonly body?: Readonly<Record<string, unknown>>;
}

export type ToolExecutionErrorCode =
  | 'invalid_arguments'
  | 'invalid_cursor'
  | 'not_visible'
  | 'not_found'
  | 'temporarily_unavailable'
  | 'response_invalid'
  | 'response_too_large';

export class ToolExecutionError extends Error {
  readonly code: ToolExecutionErrorCode;
  readonly retryable: boolean;

  constructor(code: ToolExecutionErrorCode, retryable = false) {
    super(`tool execution ${code}`);
    this.name = 'ToolExecutionError';
    this.code = code;
    this.retryable = retryable;
  }
}

const INSTRUCTIONS = `This server exposes read-only UE 5.6 code and module index tools. Always preserve project, repository, SVN revision, generation, relative path and line-range evidence returned by tools. Treat missing or stale authorization as not visible. Use opaque cursors only with the same tool, authenticated identity and unchanged filters. Results can be incomplete when uncertainty or degraded signals are reported. The server never writes source, applies patches, commits, pushes, submits, launches shells or accepts arbitrary commands.`;
const ID = /^[^\u0000-\u001f\u007f]{1,128}$/u;
const PRINCIPAL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,511}$/;
const CREDENTIAL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,511}$/;
const SCOPE = /^[A-Za-z0-9:_-]{1,128}$/;
const POSITION = /^[A-Za-z0-9._:-]{1,2048}$/;
const HASH = /^[a-f0-9]{64}$/;
const TOOL_PAGE_SIZE = 5;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_ITEM_DEPTH = 12;
const MAX_CONTAINER_ENTRIES = 10_000;

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validPrincipal(value: McpPrincipal): boolean {
  return typeof value === 'object' && value !== null && ['user', 'service'].includes(value.type)
    && PRINCIPAL_ID.test(value.id) && CREDENTIAL_ID.test(value.credential_id) && Array.isArray(value.scopes)
    && value.scopes.length <= 64 && value.scopes.every((scope) => typeof scope === 'string' && SCOPE.test(scope))
    && new Set(value.scopes).size === value.scopes.length;
}

function principalHash(principal: McpPrincipal): string {
  return sha(JSON.stringify({ type: principal.type, id: principal.id, credential_id: principal.credential_id }));
}

function requestId(value: unknown): string | number | undefined {
  if (typeof value === 'string' && ID.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  return undefined;
}

function jsonRpcError(id: string | number | null, code: number, message: string): Readonly<Record<string, unknown>> {
  return Object.freeze({ jsonrpc: '2.0', id, error: Object.freeze({ code, message }) });
}

function jsonRpcResult(id: string | number, result: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze({ jsonrpc: '2.0', id, result });
}

function exactObject(value: unknown, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !allowed.includes(key)) || required.some((key) => !(key in object))) return undefined;
  return object;
}

function validJsonValue(value: unknown, depth = 0, counter = { value: 0 }): boolean {
  if (depth > MAX_ITEM_DEPTH || counter.value > MAX_CONTAINER_ENTRIES) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= 256 * 1024;
  if (Array.isArray(value)) {
    counter.value += value.length;
    return value.length <= MAX_CONTAINER_ENTRIES && value.every((item) => validJsonValue(item, depth + 1, counter));
  }
  if (typeof value !== 'object' || value === undefined) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  counter.value += entries.length;
  return entries.length <= 256 && entries.every(([key, item]) => /^[A-Za-z0-9_.:-]{1,128}$/.test(key)
    && validJsonValue(item, depth + 1, counter));
}

function validateBackendResult(result: unknown, limit: number): ReadOnlyToolBackendResult {
  const object = exactObject(result, ['items', 'next_position'], ['items']);
  if (object === undefined || !Array.isArray(object.items) || object.items.length > limit
      || object.items.some((item) => typeof item !== 'object' || item === null || Array.isArray(item) || !validJsonValue(item))
      || (object.next_position !== undefined && (typeof object.next_position !== 'string' || !POSITION.test(object.next_position)))) {
    throw new ToolExecutionError('response_invalid');
  }
  const normalized = Object.freeze({ items: Object.freeze(object.items as Readonly<Record<string, unknown>>[]),
    ...(object.next_position === undefined ? {} : { next_position: object.next_position as string }) });
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_RESULT_BYTES) throw new ToolExecutionError('response_too_large');
  return normalized;
}

function errorResult(error: ToolExecutionError): Readonly<Record<string, unknown>> {
  const structuredContent = Object.freeze({ error: Object.freeze({ code: error.code, retryable: error.retryable }) });
  return Object.freeze({
    content: Object.freeze([Object.freeze({ type: 'text', text: JSON.stringify(structuredContent) })]),
    structuredContent,
    isError: true,
  });
}

function projectId(argumentsValue: Readonly<Record<string, unknown>>): string | null {
  return typeof argumentsValue.project_id === 'string' ? argumentsValue.project_id : null;
}

function toolError(error: unknown): ToolExecutionError {
  if (error instanceof ToolExecutionError) return error;
  if (error instanceof CursorError) return new ToolExecutionError('invalid_cursor');
  if (error instanceof ToolContractError) return new ToolExecutionError('invalid_arguments');
  return new ToolExecutionError('temporarily_unavailable', true);
}

export class ReadOnlyMcpServer {
  readonly #backend: ReadOnlyToolBackend;
  readonly #cursor: OpaqueCursorCodec;
  readonly #audit: McpAuditSink;
  readonly #observability: ObservabilityRecorder;
  readonly #version: string;

  constructor(backend: ReadOnlyToolBackend, cursor: OpaqueCursorCodec, audit: McpAuditSink,
    observability: ObservabilityRecorder, version = '0.1.0') {
    if (typeof backend !== 'object' || backend === null || typeof backend.execute !== 'function'
        || !(cursor instanceof OpaqueCursorCodec) || typeof audit !== 'object' || audit === null || typeof audit.record !== 'function'
        || typeof observability !== 'object' || observability === null || typeof observability.record !== 'function'
        || typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) {
      throw new TypeError('invalid MCP server configuration');
    }
    this.#backend = backend;
    this.#cursor = cursor;
    this.#audit = audit;
    this.#observability = observability;
    this.#version = version;
  }

  async #listTools(id: string | number, params: unknown, principal: McpPrincipal): Promise<McpProtocolReply> {
    const parsed = params === undefined ? {} : exactObject(params, ['cursor']);
    if (parsed === undefined || (parsed.cursor !== undefined && typeof parsed.cursor !== 'string')) {
      return Object.freeze({ kind: 'response', body: jsonRpcError(id, -32602, 'Invalid params') });
    }
    const binding = Object.freeze({ tool: 'tools_list', principal: principalHash(principal), request_hash: sha('ue-codebase-mcp/tools-list/v1') });
    let offset = 0;
    try {
      if (parsed.cursor !== undefined) {
        const decoded = this.#cursor.decode(binding, parsed.cursor as string);
        if (!/^(0|[1-9][0-9]{0,3})$/.test(decoded)) throw new CursorError();
        offset = Number(decoded);
      }
    } catch {
      return Object.freeze({ kind: 'response', body: jsonRpcError(id, -32602, 'Invalid cursor') });
    }
    if (offset < 0 || offset >= READ_ONLY_TOOLS.length && offset !== 0) {
      return Object.freeze({ kind: 'response', body: jsonRpcError(id, -32602, 'Invalid cursor') });
    }
    const tools = READ_ONLY_TOOLS.slice(offset, offset + TOOL_PAGE_SIZE);
    const nextOffset = offset + tools.length;
    const result: Record<string, unknown> = { tools };
    if (nextOffset < READ_ONLY_TOOLS.length) result.nextCursor = this.#cursor.encode(binding, String(nextOffset));
    return Object.freeze({ kind: 'response', body: jsonRpcResult(id, Object.freeze(result)) });
  }

  async #callTool(id: string | number, params: unknown, context: McpProtocolContext): Promise<McpProtocolReply> {
    const principal = context.principal;
    const started = performance.now();
    const call = exactObject(params, ['name', 'arguments'], ['name']);
    if (call === undefined || !isReadOnlyToolName(call.name)) {
      return Object.freeze({ kind: 'response', body: jsonRpcError(id, -32602, 'Unknown or invalid tool') });
    }
    const name = call.name;
    let argumentsValue: Readonly<Record<string, unknown>> = {};
    let hash = sha(JSON.stringify({ tool: name, invalid: true }));
    try {
      const parsed = parseToolArguments(name, call.arguments ?? {});
      argumentsValue = parsed.values;
      hash = sha(JSON.stringify({ schema_version: 1, tool: name, arguments: argumentsValue }));
      const binding = Object.freeze({ tool: name, principal: principalHash(principal), request_hash: hash });
      const position = parsed.cursor === undefined ? undefined : this.#cursor.decode(binding, parsed.cursor);
      const backendResult = validateBackendResult(await this.#backend.execute(Object.freeze({
        tool: name, arguments: argumentsValue, principal, ...(position === undefined ? {} : { position }),
        limit: parsed.limit, request_hash: hash, observation: context.observation,
      })), parsed.limit);
      const structuredContent = Object.freeze({ items: backendResult.items,
        ...(backendResult.next_position === undefined ? {} : { next_cursor: this.#cursor.encode(binding, backendResult.next_position) }) });
      if (Buffer.byteLength(JSON.stringify(structuredContent), 'utf8') > MAX_RESULT_BYTES) throw new ToolExecutionError('response_too_large');
      const targetProject = projectId(argumentsValue);
      await this.#audit.record(Object.freeze({ actor_type: principal.type, actor_id: principal.id, action: 'mcp.tool.call',
        project_id: targetProject, tool: name, outcome: 'succeeded', request_hash: hash,
        correlation_id: context.observation.correlation_id, trace_id: context.observation.trace_id,
        span_id: context.observation.span_id, resource_type: targetProject === null ? null : 'project',
        resource_id: targetProject, error_code: null }));
      this.#observability.record(Object.freeze({ context: context.observation, component: 'mcp-server', operation: 'tool-call',
        outcome: 'succeeded', duration_ms: performance.now() - started, attributes: Object.freeze({ tool: name }) }));
      const result = Object.freeze({
        content: Object.freeze([Object.freeze({ type: 'text', text: JSON.stringify(structuredContent) })]),
        structuredContent,
        isError: false,
      });
      return Object.freeze({ kind: 'response', body: jsonRpcResult(id, result) });
    } catch (cause) {
      const error = toolError(cause);
      try {
        const targetProject = projectId(argumentsValue);
        await this.#audit.record(Object.freeze({ actor_type: principal.type, actor_id: principal.id, action: 'mcp.tool.call',
          project_id: targetProject, tool: name, outcome: 'failed', request_hash: HASH.test(hash) ? hash : sha('invalid'),
          correlation_id: context.observation.correlation_id, trace_id: context.observation.trace_id,
          span_id: context.observation.span_id, resource_type: targetProject === null ? null : 'project',
          resource_id: targetProject, error_code: error.code }));
      } catch {
        this.#observability.record(Object.freeze({ context: context.observation, component: 'mcp-server', operation: 'tool-call',
          outcome: 'failed', duration_ms: performance.now() - started,
          attributes: Object.freeze({ tool: name, error_code: 'audit-unavailable' }) }));
        return Object.freeze({ kind: 'response', body: jsonRpcResult(id, errorResult(new ToolExecutionError('temporarily_unavailable', true))) });
      }
      this.#observability.record(Object.freeze({ context: context.observation, component: 'mcp-server', operation: 'tool-call',
        outcome: 'failed', duration_ms: performance.now() - started,
        attributes: Object.freeze({ tool: name, error_code: error.code }) }));
      return Object.freeze({ kind: 'response', body: jsonRpcResult(id, errorResult(error)) });
    }
  }

  async handle(message: unknown, context: McpProtocolContext): Promise<McpProtocolReply> {
    if (typeof context !== 'object' || context === null || !validPrincipal(context.principal)
        || (context.protocol_version !== undefined && !MCP_PROTOCOL_VERSIONS.includes(context.protocol_version as typeof MCP_PROTOCOL_VERSIONS[number]))) {
      throw new TypeError('invalid MCP protocol context');
    }
    assertObservationContext(context.observation);
    const envelope = exactObject(message, ['jsonrpc', 'id', 'method', 'params', 'result', 'error']);
    if (envelope === undefined || envelope.jsonrpc !== '2.0') {
      return Object.freeze({ kind: 'response', body: jsonRpcError(null, -32600, 'Invalid Request') });
    }
    const hasMethod = 'method' in envelope;
    const hasResult = 'result' in envelope;
    const hasError = 'error' in envelope;
    if ((hasMethod && (hasResult || hasError)) || (hasResult && hasError)) {
      return Object.freeze({ kind: 'response', body: jsonRpcError(null, -32600, 'Invalid Request') });
    }
    if (!hasMethod && (hasResult || hasError) && requestId(envelope.id) !== undefined) {
      return Object.freeze({ kind: 'accepted' });
    }
    if (typeof envelope.method !== 'string' || envelope.method.length < 1 || envelope.method.length > 128) {
      return Object.freeze({ kind: 'response', body: jsonRpcError(null, -32600, 'Invalid Request') });
    }
    if (envelope.id === undefined) {
      if (['notifications/initialized', 'notifications/cancelled'].includes(envelope.method)) return Object.freeze({ kind: 'accepted' });
      return Object.freeze({ kind: 'accepted' });
    }
    const id = requestId(envelope.id);
    if (id === undefined) return Object.freeze({ kind: 'response', body: jsonRpcError(null, -32600, 'Invalid Request') });
    if (envelope.method === 'initialize') {
      const params = exactObject(envelope.params, ['protocolVersion', 'capabilities', 'clientInfo'], ['protocolVersion', 'capabilities', 'clientInfo']);
      const clientInfo = params === undefined ? undefined : exactObject(params.clientInfo, ['name', 'title', 'version', 'description', 'icons', 'websiteUrl'], ['name', 'version']);
      if (params === undefined || typeof params.protocolVersion !== 'string' || typeof params.capabilities !== 'object'
          || params.capabilities === null || Array.isArray(params.capabilities) || clientInfo === undefined
          || typeof clientInfo.name !== 'string' || clientInfo.name.length < 1 || clientInfo.name.length > 128
          || typeof clientInfo.version !== 'string' || clientInfo.version.length < 1 || clientInfo.version.length > 64) {
        return Object.freeze({ kind: 'response', body: jsonRpcError(id, -32602, 'Invalid params') });
      }
      const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(params.protocolVersion as typeof MCP_PROTOCOL_VERSIONS[number])
        ? params.protocolVersion : MCP_LATEST_PROTOCOL_VERSION;
      return Object.freeze({ kind: 'response', body: jsonRpcResult(id, Object.freeze({
        protocolVersion,
        capabilities: Object.freeze({ tools: Object.freeze({ listChanged: false }) }),
        serverInfo: Object.freeze({ name: 'ue-codebase-mcp', title: 'UE Codebase MCP', version: this.#version,
          description: 'Read-only authorized UE 5.6 code intelligence.' }),
        instructions: INSTRUCTIONS,
      })) });
    }
    if (envelope.method === 'ping') return Object.freeze({ kind: 'response', body: jsonRpcResult(id, Object.freeze({})) });
    if (envelope.method === 'tools/list') return this.#listTools(id, envelope.params, context.principal);
    if (envelope.method === 'tools/call') return this.#callTool(id, envelope.params, context);
    return Object.freeze({ kind: 'response', body: jsonRpcError(id, -32601, 'Method not found') });
  }
}
