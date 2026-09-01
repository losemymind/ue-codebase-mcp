export type ReadOnlyToolName =
  | 'list_projects'
  | 'index_status'
  | 'search_code'
  | 'read_file_excerpt'
  | 'get_symbol'
  | 'find_references'
  | 'trace_calls'
  | 'find_derived_types'
  | 'get_module_dependencies';

export interface McpToolDefinition {
  readonly name: ReadOnlyToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: Readonly<{
    readOnlyHint: true;
    destructiveHint: false;
    idempotentHint: true;
    openWorldHint: false;
  }>;
}

export interface ParsedToolArguments {
  readonly values: Readonly<Record<string, unknown>>;
  readonly cursor?: string;
  readonly limit: number;
}

export class ToolContractError extends Error {
  readonly code = 'invalid-arguments';

  constructor() {
    super('tool contract invalid-arguments');
    this.name = 'ToolContractError';
  }
}

const UUID_PATTERN = '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-5][a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$';
const REVISION_PATTERN = '^(0|[1-9][0-9]{0,18})$';
const PATH_PATTERN = '^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\)[^\\u0000-\\u001f\\u007f]{1,2048}$';
const UUID = new RegExp(UUID_PATTERN);
const REVISION = new RegExp(REVISION_PATTERN);
const CURSOR = /^[A-Za-z0-9_-]{8,3072}\.[A-Za-z0-9_-]{43}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const SYMBOL_KEY = /^[^\u0000-\u001f\u007f]{1,4096}$/u;
const PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\u0000-\u001f\u007f]{1,2048}$/u;
const QUERY_KINDS = Object.freeze(['namespace', 'module', 'class', 'struct', 'union', 'enum', 'enumerator', 'function',
  'method', 'constructor', 'destructor', 'variable', 'field', 'parameter', 'typedef', 'type_alias', 'macro', 'concept']);
const EDGE_TYPES = Object.freeze(['aliases', 'calls', 'inherits', 'instantiates', 'overrides', 'owns', 'references']);
const DIRECTIONS = Object.freeze(['incoming', 'outgoing', 'both']);
const annotation = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

const cursorProperty = Object.freeze({ type: 'string', minLength: 52, maxLength: 4096, pattern: '^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}$',
  description: 'Opaque continuation cursor returned by the same tool and caller scope.' });
const limitProperty = Object.freeze({ type: 'integer', minimum: 1, maximum: 100, default: 20 });
const projectProperty = Object.freeze({ type: 'string', pattern: UUID_PATTERN });
const symbolProperty = Object.freeze({ type: 'string', minLength: 1, maxLength: 4096 });
const directionProperty = Object.freeze({ type: 'string', enum: DIRECTIONS });
const commonOutput = Object.freeze({
  type: 'object',
  additionalProperties: false,
  oneOf: Object.freeze([
    Object.freeze({ required: Object.freeze(['items']) }),
    Object.freeze({ required: Object.freeze(['error']) }),
  ]),
  properties: Object.freeze({
    items: Object.freeze({ type: 'array', maxItems: 100, items: Object.freeze({ type: 'object' }) }),
    next_cursor: cursorProperty,
    error: Object.freeze({
      type: 'object', additionalProperties: false, required: Object.freeze(['code', 'retryable']),
      properties: Object.freeze({
        code: Object.freeze({ type: 'string', enum: Object.freeze([
          'invalid_arguments', 'invalid_cursor', 'not_visible', 'not_found', 'temporarily_unavailable',
          'response_invalid', 'response_too_large',
        ]) }),
        retryable: Object.freeze({ type: 'boolean' }),
      }),
    }),
  }),
});

function schema(properties: Record<string, unknown>, required: readonly string[]): Readonly<Record<string, unknown>> {
  return Object.freeze({ type: 'object', additionalProperties: false, properties: Object.freeze(properties), required: Object.freeze([...required]) });
}

function definition(name: ReadOnlyToolName, title: string, description: string, inputSchema: Readonly<Record<string, unknown>>): McpToolDefinition {
  return Object.freeze({ name, title, description, inputSchema, outputSchema: commonOutput, annotations: annotation });
}

export const READ_ONLY_TOOLS: readonly McpToolDefinition[] = Object.freeze([
  definition('list_projects', 'List visible UE projects', 'List only projects visible to the authenticated caller. Results use an opaque cursor.', schema({
    status: Object.freeze({ type: 'string', enum: Object.freeze(['active', 'disabled', 'archived']) }),
    limit: limitProperty,
    cursor: cursorProperty,
  }, [])),
  definition('index_status', 'Get index status', 'Return the active generation, pinned SVN revisions, freshness and bounded failure summary for one visible project.', schema({
    project_id: projectProperty,
  }, ['project_id'])),
  definition('search_code', 'Search UE C++ code', 'Search authorized UE 5.6 code with exact, lexical, semantic and graph evidence. Results never include unauthorized paths.', schema({
    project_id: projectProperty,
    query: Object.freeze({ type: 'string', minLength: 1, maxLength: 4096 }),
    repository_ids: Object.freeze({ type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: Object.freeze({ type: 'string', pattern: UUID_PATTERN }) }),
    revision: Object.freeze({ type: 'string', pattern: REVISION_PATTERN }),
    module: Object.freeze({ type: 'string', minLength: 1, maxLength: 256 }),
    kind: Object.freeze({ type: 'string', enum: QUERY_KINDS }),
    limit: limitProperty,
    cursor: cursorProperty,
  }, ['project_id', 'query'])),
  definition('read_file_excerpt', 'Read a source excerpt', 'Read a bounded authorized excerpt from one pinned SVN file. This tool cannot write or modify files.', schema({
    project_id: projectProperty,
    repository_id: Object.freeze({ type: 'string', pattern: UUID_PATTERN }),
    revision: Object.freeze({ type: 'string', pattern: REVISION_PATTERN }),
    path: Object.freeze({ type: 'string', minLength: 1, maxLength: 2048, pattern: PATH_PATTERN }),
    start_line: Object.freeze({ type: 'integer', minimum: 1, maximum: 100000000 }),
    end_line: Object.freeze({ type: 'integer', minimum: 1, maximum: 100000000 }),
  }, ['project_id', 'repository_id', 'revision', 'path', 'start_line', 'end_line'])),
  definition('get_symbol', 'Get a C++ symbol', 'Get one authorized symbol with declarations, definitions, documentation and UE metadata.', schema({
    project_id: projectProperty,
    symbol: symbolProperty,
  }, ['project_id', 'symbol'])),
  definition('find_references', 'Find symbol references', 'Find bounded authorized references or semantic edges for one symbol.', schema({
    project_id: projectProperty,
    symbol: symbolProperty,
    direction: directionProperty,
    edge_types: Object.freeze({ type: 'array', minItems: 1, maxItems: 7, uniqueItems: true, items: Object.freeze({ type: 'string', enum: EDGE_TYPES }) }),
    limit: limitProperty,
    cursor: cursorProperty,
  }, ['project_id', 'symbol'])),
  definition('trace_calls', 'Trace the C++ call graph', 'Trace a bounded call graph from one authorized symbol. Depth and node count are strictly capped.', schema({
    project_id: projectProperty,
    symbol: symbolProperty,
    direction: directionProperty,
    max_depth: Object.freeze({ type: 'integer', minimum: 1, maximum: 8, default: 3 }),
    max_nodes: Object.freeze({ type: 'integer', minimum: 1, maximum: 500, default: 100 }),
    cursor: cursorProperty,
  }, ['project_id', 'symbol'])),
  definition('find_derived_types', 'Find derived C++ types', 'Find a bounded authorized inheritance tree for one class or struct.', schema({
    project_id: projectProperty,
    symbol: symbolProperty,
    max_depth: Object.freeze({ type: 'integer', minimum: 1, maximum: 16, default: 8 }),
    limit: limitProperty,
    cursor: cursorProperty,
  }, ['project_id', 'symbol'])),
  definition('get_module_dependencies', 'Get UE module dependencies', 'Return bounded Build.cs, plugin and target dependency evidence for one UE module.', schema({
    project_id: projectProperty,
    module: Object.freeze({ type: 'string', minLength: 1, maxLength: 256 }),
    direction: directionProperty,
    max_depth: Object.freeze({ type: 'integer', minimum: 1, maximum: 8, default: 3 }),
    limit: limitProperty,
    cursor: cursorProperty,
  }, ['project_id', 'module'])),
]);

const names = new Set(READ_ONLY_TOOLS.map(({ name }) => name));
export function isReadOnlyToolName(value: unknown): value is ReadOnlyToolName {
  return typeof value === 'string' && names.has(value as ReadOnlyToolName);
}

function invalid(): never {
  throw new ToolContractError();
}

function exact(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !allowed.includes(key)) || required.some((key) => !(key in object))) invalid();
  return object;
}

function boundedString(value: unknown, maximum: number, pattern?: RegExp): string {
  if (typeof value !== 'string') invalid();
  const normalized = value.normalize('NFC');
  if (normalized !== value || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)
      || (pattern !== undefined && !pattern.test(value))) invalid();
  return value;
}

function optionalString(value: unknown, maximum: number, pattern?: RegExp): string | undefined {
  return value === undefined ? undefined : boundedString(value, maximum, pattern);
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || (candidate as number) < minimum || (candidate as number) > maximum) invalid();
  return candidate as number;
}

function optionalEnum(value: unknown, allowed: readonly string[], fallback?: string): string | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value)) invalid();
  return value;
}

function uniqueStrings(value: unknown, maximum: number, pattern: RegExp): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) invalid();
  const result = value.map((item) => boundedString(item, 4096, pattern));
  if (new Set(result).size !== result.length) invalid();
  return Object.freeze(result);
}

function finish(values: Record<string, unknown>, limit: number): ParsedToolArguments {
  const cursor = optionalString(values.cursor, 4096, CURSOR);
  const output = Object.fromEntries(Object.entries(values).filter(([key, value]) => key !== 'cursor' && value !== undefined));
  return Object.freeze({ values: Object.freeze(output), ...(cursor === undefined ? {} : { cursor }), limit });
}

export function parseToolArguments(name: ReadOnlyToolName, input: unknown): ParsedToolArguments {
  if (name === 'list_projects') {
    const value = exact(input ?? {}, ['status', 'limit', 'cursor'], []);
    const limit = boundedInteger(value.limit, 20, 1, 100);
    return finish({ status: optionalEnum(value.status, ['active', 'disabled', 'archived']), limit, cursor: value.cursor }, limit);
  }
  if (name === 'index_status') {
    const value = exact(input, ['project_id'], ['project_id']);
    return finish({ project_id: boundedString(value.project_id, 36, UUID) }, 1);
  }
  if (name === 'search_code') {
    const value = exact(input, ['project_id', 'query', 'repository_ids', 'revision', 'module', 'kind', 'limit', 'cursor'], ['project_id', 'query']);
    const limit = boundedInteger(value.limit, 20, 1, 100);
    return finish({
      project_id: boundedString(value.project_id, 36, UUID),
      query: boundedString(value.query, 4096),
      repository_ids: uniqueStrings(value.repository_ids, 64, UUID),
      revision: optionalString(value.revision, 19, REVISION),
      module: optionalString(value.module, 256, IDENTIFIER),
      kind: optionalEnum(value.kind, QUERY_KINDS),
      limit,
      cursor: value.cursor,
    }, limit);
  }
  if (name === 'read_file_excerpt') {
    const value = exact(input, ['project_id', 'repository_id', 'revision', 'path', 'start_line', 'end_line'],
      ['project_id', 'repository_id', 'revision', 'path', 'start_line', 'end_line']);
    const start = boundedInteger(value.start_line, 0, 1, 100_000_000);
    const end = boundedInteger(value.end_line, 0, start, Math.min(100_000_000, start + 499));
    return finish({ project_id: boundedString(value.project_id, 36, UUID), repository_id: boundedString(value.repository_id, 36, UUID),
      revision: boundedString(value.revision, 19, REVISION), path: boundedString(value.path, 2048, PATH), start_line: start, end_line: end }, 1);
  }
  if (name === 'get_symbol') {
    const value = exact(input, ['project_id', 'symbol'], ['project_id', 'symbol']);
    return finish({ project_id: boundedString(value.project_id, 36, UUID), symbol: boundedString(value.symbol, 4096, SYMBOL_KEY) }, 1);
  }
  if (name === 'find_references') {
    const value = exact(input, ['project_id', 'symbol', 'direction', 'edge_types', 'limit', 'cursor'], ['project_id', 'symbol']);
    const limit = boundedInteger(value.limit, 50, 1, 100);
    return finish({ project_id: boundedString(value.project_id, 36, UUID), symbol: boundedString(value.symbol, 4096, SYMBOL_KEY),
      direction: optionalEnum(value.direction, DIRECTIONS, 'both'), edge_types: uniqueStrings(value.edge_types, 7, new RegExp(`^(?:${EDGE_TYPES.join('|')})$`)),
      limit, cursor: value.cursor }, limit);
  }
  if (name === 'trace_calls') {
    const value = exact(input, ['project_id', 'symbol', 'direction', 'max_depth', 'max_nodes', 'cursor'], ['project_id', 'symbol']);
    const maxNodes = boundedInteger(value.max_nodes, 100, 1, 500);
    return finish({ project_id: boundedString(value.project_id, 36, UUID), symbol: boundedString(value.symbol, 4096, SYMBOL_KEY),
      direction: optionalEnum(value.direction, DIRECTIONS, 'both'), max_depth: boundedInteger(value.max_depth, 3, 1, 8),
      max_nodes: maxNodes, cursor: value.cursor }, maxNodes);
  }
  if (name === 'find_derived_types') {
    const value = exact(input, ['project_id', 'symbol', 'max_depth', 'limit', 'cursor'], ['project_id', 'symbol']);
    const limit = boundedInteger(value.limit, 50, 1, 100);
    return finish({ project_id: boundedString(value.project_id, 36, UUID), symbol: boundedString(value.symbol, 4096, SYMBOL_KEY),
      max_depth: boundedInteger(value.max_depth, 8, 1, 16), limit, cursor: value.cursor }, limit);
  }
  const value = exact(input, ['project_id', 'module', 'direction', 'max_depth', 'limit', 'cursor'], ['project_id', 'module']);
  const limit = boundedInteger(value.limit, 50, 1, 100);
  return finish({ project_id: boundedString(value.project_id, 36, UUID), module: boundedString(value.module, 256, IDENTIFIER),
    direction: optionalEnum(value.direction, DIRECTIONS, 'both'), max_depth: boundedInteger(value.max_depth, 3, 1, 8),
    limit, cursor: value.cursor }, limit);
}
