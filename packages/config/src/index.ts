import { readFile } from 'node:fs/promises';

export const CONFIG_VERSION = 1 as const;

export type ConfigKind = 'project' | 'repository' | 'provider' | 'preset';
export type SecretRef = string & { readonly __secretRef: unique symbol };

export interface ProjectConfig {
  schema: 'ue-codebase-mcp/project';
  version: 1;
  id: string;
  slug: string;
  name: string;
  ue_version: '5.6';
  status: 'active' | 'disabled';
  repository_ids: string[];
}

export interface RepositoryBranchConfig {
  name: string;
  svn_url: string;
  tracking_policy: 'continuous';
}

export interface RepositoryConfig {
  schema: 'ue-codebase-mcp/repository';
  version: 1;
  id: string;
  project_id: string;
  kind: 'svn';
  role: 'engine' | 'game' | 'plugin';
  canonical_url: string;
  credential: { secret_ref: SecretRef };
  enabled: boolean;
  branches: RepositoryBranchConfig[];
}

export interface ProviderConfig {
  schema: 'ue-codebase-mcp/provider';
  version: 1;
  id: string;
  kind: 'openai-compatible';
  endpoint: string;
  allowed_hosts: string[];
  credential: { secret_ref: SecretRef };
  embedding: { model: string; dimensions: number };
  rerank?: { model: string };
  data_processing_approved: boolean;
  enabled: boolean;
}

export interface ResourcePolicy {
  timeout_seconds: number;
  max_memory_mb: number;
  max_cpu_percent: number;
}

export interface ReindexPresetConfig {
  schema: 'ue-codebase-mcp/preset';
  version: 1;
  id: string;
  project_id: string;
  kind: 'reindex';
  enabled: boolean;
  scopes: Array<'engine' | 'game' | 'plugin'>;
  resource_policy: ResourcePolicy;
}

export interface UbtPresetConfig {
  schema: 'ue-codebase-mcp/preset';
  version: 1;
  id: string;
  project_id: string;
  kind: 'ubt_build';
  enabled: boolean;
  target: string;
  platform: 'Win64';
  configuration: 'Debug' | 'DebugGame' | 'Development' | 'Shipping' | 'Test';
  clean: boolean;
  resource_policy: ResourcePolicy;
}

export interface UatPresetConfig {
  schema: 'ue-codebase-mcp/preset';
  version: 1;
  id: string;
  project_id: string;
  kind: 'uat_test';
  enabled: boolean;
  test_plan: string;
  platform: 'Win64';
  configuration: 'DebugGame' | 'Development' | 'Shipping' | 'Test';
  resource_policy: ResourcePolicy;
}

export type PresetConfig = ReindexPresetConfig | UbtPresetConfig | UatPresetConfig;
export type VersionedConfig = ProjectConfig | RepositoryConfig | ProviderConfig | PresetConfig;

export class ConfigError extends Error {
  readonly code: string;
  readonly source: string;
  readonly line?: number;

  constructor(code: string, message: string, source = '<configuration>', line?: number) {
    super(`${source}${line === undefined ? '' : `:${line}`}: ${message}`);
    this.name = 'ConfigError';
    this.code = code;
    this.source = source;
    this.line = line;
  }
}

interface YamlLine {
  indent: number;
  content: string;
  line: number;
}

interface ParseResult {
  value: unknown;
  next: number;
}

const SCHEMA_PREFIX = 'ue-codebase-mcp/';
const IDENTIFIER = /^[a-z][a-z0-9-]{1,62}$/;
const TARGET_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SECRET_REF = /^secret:\/\/[a-z][a-z0-9._-]{1,62}\/[A-Za-z0-9][A-Za-z0-9._/-]{0,253}$/;
const HOSTNAME = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const environmentOverrides: Readonly<Record<ConfigKind, Readonly<Record<string, string>>>> = {
  project: { UE_MCP_PROJECT_STATUS: 'status' },
  repository: { UE_MCP_REPOSITORY_ENABLED: 'enabled' },
  provider: { UE_MCP_PROVIDER_ENABLED: 'enabled' },
  preset: { UE_MCP_PRESET_ENABLED: 'enabled' },
};

function fail(code: string, message: string, source: string, line?: number): never {
  throw new ConfigError(code, message, source, line);
}

function stripComment(value: string): string {
  let single = false;
  let double = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'" && !double) single = !single;
    if (character === '"' && !single && value[index - 1] !== '\\') double = !double;
    if (character === '#' && !single && !double && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function findMappingColon(value: string): number {
  let single = false;
  let double = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'" && !double) single = !single;
    if (character === '"' && !single && value[index - 1] !== '\\') double = !double;
    if (character === ':' && !single && !double) return index;
  }
  return -1;
}

function parseScalar(value: string, source: string, line: number): unknown {
  if (/\$\{|\$\(|\{\{|%[A-Za-z_][A-Za-z0-9_]*%/.test(value)) {
    fail('CONFIG_INTERPOLATION_FORBIDDEN', 'environment or command interpolation is forbidden', source, line);
  }
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== 'string') fail('CONFIG_YAML_INVALID', 'quoted scalar must be a string', source, line);
      return parsed;
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      fail('CONFIG_YAML_INVALID', 'invalid double-quoted scalar', source, line);
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) fail('CONFIG_YAML_INVALID', 'invalid single-quoted scalar', source, line);
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?(?:0|[1-9][0-9]*)$/.test(value)) return Number(value);
  if (value.length === 0 || /^[&*!>|@`{}\[\]]/.test(value)) {
    fail('CONFIG_YAML_UNSUPPORTED', 'unsupported YAML scalar syntax', source, line);
  }
  return value;
}

function parsePair(value: string, source: string, line: number): [string, string] {
  const colon = findMappingColon(value);
  if (colon < 1) fail('CONFIG_YAML_INVALID', 'expected a mapping key and value', source, line);
  const key = value.slice(0, colon).trim();
  if (!/^[a-z][a-z0-9_]*$/.test(key) || key === '<<') {
    fail('CONFIG_YAML_INVALID', 'mapping keys must use lower snake_case', source, line);
  }
  return [key, value.slice(colon + 1).trim()];
}

function parseBlock(lines: YamlLine[], start: number, indent: number, source: string): ParseResult {
  if (start >= lines.length || lines[start].indent !== indent) {
    fail('CONFIG_YAML_INVALID', 'invalid indentation', source, lines[start]?.line);
  }
  if (lines[start].content.startsWith('-')) return parseSequence(lines, start, indent, source);
  return parseMapping(lines, start, indent, source);
}

function parseMapping(lines: YamlLine[], start: number, indent: number, source: string): ParseResult {
  const result: Record<string, unknown> = {};
  let index = start;
  while (index < lines.length && lines[index].indent === indent && !lines[index].content.startsWith('-')) {
    const current = lines[index];
    const [key, rawValue] = parsePair(current.content, source, current.line);
    if (Object.hasOwn(result, key)) fail('CONFIG_DUPLICATE_FIELD', `duplicate field '${key}'`, source, current.line);
    if (rawValue.length > 0) {
      result[key] = parseScalar(rawValue, source, current.line);
      index += 1;
      continue;
    }
    if (index + 1 >= lines.length || lines[index + 1].indent !== indent + 2) {
      fail('CONFIG_YAML_INVALID', `field '${key}' requires an indented value`, source, current.line);
    }
    const nested = parseBlock(lines, index + 1, indent + 2, source);
    result[key] = nested.value;
    index = nested.next;
  }
  return { value: result, next: index };
}

function parseSequence(lines: YamlLine[], start: number, indent: number, source: string): ParseResult {
  const result: unknown[] = [];
  let index = start;
  while (index < lines.length && lines[index].indent === indent && lines[index].content.startsWith('-')) {
    const current = lines[index];
    if (current.content !== '-' && !current.content.startsWith('- ')) {
      fail('CONFIG_YAML_INVALID', 'sequence marker must be followed by a space', source, current.line);
    }
    const item = current.content.slice(1).trim();
    if (item.length === 0) {
      if (index + 1 >= lines.length || lines[index + 1].indent !== indent + 2) {
        fail('CONFIG_YAML_INVALID', 'sequence item requires an indented value', source, current.line);
      }
      const nested = parseBlock(lines, index + 1, indent + 2, source);
      result.push(nested.value);
      index = nested.next;
      continue;
    }
    if (findMappingColon(item) >= 0) {
      const [key, rawValue] = parsePair(item, source, current.line);
      if (rawValue.length === 0) fail('CONFIG_YAML_UNSUPPORTED', 'inline sequence mappings require a scalar first field', source, current.line);
      const object: Record<string, unknown> = { [key]: parseScalar(rawValue, source, current.line) };
      index += 1;
      if (index < lines.length && lines[index].indent === indent + 2) {
        const continuation = parseMapping(lines, index, indent + 2, source);
        for (const [nestedKey, nestedValue] of Object.entries(continuation.value as Record<string, unknown>)) {
          if (Object.hasOwn(object, nestedKey)) fail('CONFIG_DUPLICATE_FIELD', `duplicate field '${nestedKey}'`, source, lines[index].line);
          object[nestedKey] = nestedValue;
        }
        index = continuation.next;
      }
      result.push(object);
      continue;
    }
    result.push(parseScalar(item, source, current.line));
    index += 1;
  }
  return { value: result, next: index };
}

export function parseYamlSubset(text: string, source = '<configuration>'): unknown {
  if (Buffer.byteLength(text, 'utf8') > 262_144) fail('CONFIG_TOO_LARGE', 'configuration exceeds 256 KiB', source);
  if (text.includes('\t')) fail('CONFIG_YAML_UNSUPPORTED', 'tabs are forbidden', source);
  const lines: YamlLine[] = [];
  let documentStarted = false;
  let documentEnded = false;
  for (const [offset, original] of text.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').split('\n').entries()) {
    const withoutComment = stripComment(original);
    const trimmed = withoutComment.trim();
    if (trimmed.length === 0) continue;
    if (trimmed === '---') {
      if (documentStarted || documentEnded) fail('CONFIG_YAML_UNSUPPORTED', 'multiple YAML documents are forbidden', source, offset + 1);
      documentStarted = true;
      continue;
    }
    if (trimmed === '...') {
      if (documentEnded) fail('CONFIG_YAML_UNSUPPORTED', 'multiple YAML documents are forbidden', source, offset + 1);
      documentEnded = true;
      continue;
    }
    if (documentEnded) fail('CONFIG_YAML_UNSUPPORTED', 'content after the YAML document is forbidden', source, offset + 1);
    documentStarted = true;
    const indent = withoutComment.length - withoutComment.trimStart().length;
    if (indent % 2 !== 0) fail('CONFIG_YAML_INVALID', 'indentation must use multiples of two spaces', source, offset + 1);
    const content = withoutComment.trimStart();
    if (/^(?:---|\.\.\.)\s/.test(content) || /(?:^|\s)(?:&|\*)[A-Za-z0-9_-]+/.test(content) || /!\S/.test(content)) {
      fail('CONFIG_YAML_UNSUPPORTED', 'YAML tags, anchors, aliases, and multiple documents are forbidden', source, offset + 1);
    }
    lines.push({ indent, content, line: offset + 1 });
  }
  if (lines.length === 0) fail('CONFIG_EMPTY', 'configuration is empty', source);
  if (lines[0].indent !== 0) fail('CONFIG_YAML_INVALID', 'top-level content must not be indented', source, lines[0].line);
  const parsed = parseBlock(lines, 0, 0, source);
  if (parsed.next !== lines.length) fail('CONFIG_YAML_INVALID', 'unexpected indentation or trailing content', source, lines[parsed.next].line);
  return parsed.value;
}

function objectValue(value: unknown, path: string, source: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('CONFIG_SCHEMA_INVALID', `${path} must be a mapping`, source);
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, required: string[], optional: string[], path: string, source: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('CONFIG_UNKNOWN_FIELD', `${path} contains unknown field '${key}'`, source);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail('CONFIG_REQUIRED_FIELD', `${path} is missing required field '${key}'`, source);
  }
}

function stringValue(value: unknown, path: string, source: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || (pattern && !pattern.test(value))) {
    fail('CONFIG_SCHEMA_INVALID', `${path} has an invalid string value`, source);
  }
  return value;
}

function booleanValue(value: unknown, path: string, source: string): boolean {
  if (typeof value !== 'boolean') fail('CONFIG_SCHEMA_INVALID', `${path} must be a boolean`, source);
  return value;
}

function integerValue(value: unknown, path: string, source: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail('CONFIG_SCHEMA_INVALID', `${path} must be an integer from ${minimum} through ${maximum}`, source);
  }
  return value as number;
}

function literal<T extends string | number>(value: unknown, expected: readonly T[], path: string, source: string): T {
  if (!expected.includes(value as T)) fail('CONFIG_SCHEMA_INVALID', `${path} is not an allowed value`, source);
  return value as T;
}

function uniqueStringArray(value: unknown, path: string, source: string, allowed?: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) fail('CONFIG_SCHEMA_INVALID', `${path} must be a non-empty bounded sequence`, source);
  const output = value.map((item, index) => stringValue(item, `${path}[${index}]`, source, IDENTIFIER));
  if (allowed && output.some((item) => !allowed.includes(item))) fail('CONFIG_SCHEMA_INVALID', `${path} contains a disallowed value`, source);
  if (new Set(output).size !== output.length) fail('CONFIG_SCHEMA_INVALID', `${path} must not contain duplicates`, source);
  return output;
}

function secretReference(value: unknown, path: string, source: string): { secret_ref: SecretRef } {
  const object = objectValue(value, path, source);
  exactFields(object, ['secret_ref'], [], path, source);
  const reference = stringValue(object.secret_ref, `${path}.secret_ref`, source, SECRET_REF);
  if (reference.slice('secret://'.length).split('/').some((segment) => segment === '.' || segment === '..')) {
    fail('CONFIG_SECRET_REF_INVALID', `${path}.secret_ref is not an allowed secret reference`, source);
  }
  const parsed = new URL(reference);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname.split('/').includes('..')) {
    fail('CONFIG_SECRET_REF_INVALID', `${path}.secret_ref is not an allowed secret reference`, source);
  }
  return { secret_ref: reference as SecretRef };
}

function resourcePolicy(value: unknown, path: string, source: string): ResourcePolicy {
  const object = objectValue(value, path, source);
  exactFields(object, ['timeout_seconds', 'max_memory_mb', 'max_cpu_percent'], [], path, source);
  return {
    timeout_seconds: integerValue(object.timeout_seconds, `${path}.timeout_seconds`, source, 30, 86_400),
    max_memory_mb: integerValue(object.max_memory_mb, `${path}.max_memory_mb`, source, 512, 262_144),
    max_cpu_percent: integerValue(object.max_cpu_percent, `${path}.max_cpu_percent`, source, 1, 100),
  };
}

function validateHeader(object: Record<string, unknown>, kind: ConfigKind, source: string): void {
  literal(object.schema, [`${SCHEMA_PREFIX}${kind}`], 'schema', source);
  literal(object.version, [CONFIG_VERSION], 'version', source);
}

function validateProject(value: unknown, source: string): ProjectConfig {
  const object = objectValue(value, 'project', source);
  exactFields(object, ['schema', 'version', 'id', 'slug', 'name', 'ue_version', 'status', 'repository_ids'], [], 'project', source);
  validateHeader(object, 'project', source);
  return {
    schema: 'ue-codebase-mcp/project', version: 1,
    id: stringValue(object.id, 'project.id', source, IDENTIFIER),
    slug: stringValue(object.slug, 'project.slug', source, IDENTIFIER),
    name: stringValue(object.name, 'project.name', source),
    ue_version: literal(object.ue_version, ['5.6'], 'project.ue_version', source),
    status: literal(object.status, ['active', 'disabled'], 'project.status', source),
    repository_ids: uniqueStringArray(object.repository_ids, 'project.repository_ids', source),
  };
}

function validateSvnUrl(value: unknown, path: string, source: string): string {
  const string = stringValue(value, path, source);
  let parsed: URL;
  try { parsed = new URL(string); } catch { fail('CONFIG_SCHEMA_INVALID', `${path} must be an absolute SVN URL`, source); }
  if (!['https:', 'svn+ssh:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail('CONFIG_SCHEMA_INVALID', `${path} must use https or svn+ssh without credentials, query, or fragment`, source);
  }
  return string;
}

function validateRepository(value: unknown, source: string): RepositoryConfig {
  const object = objectValue(value, 'repository', source);
  exactFields(object, ['schema', 'version', 'id', 'project_id', 'kind', 'role', 'canonical_url', 'credential', 'enabled', 'branches'], [], 'repository', source);
  validateHeader(object, 'repository', source);
  const branchesValue = object.branches;
  if (!Array.isArray(branchesValue) || branchesValue.length === 0 || branchesValue.length > 16) {
    fail('CONFIG_SCHEMA_INVALID', 'repository.branches must be a non-empty bounded sequence', source);
  }
  const branches = branchesValue.map((branch, index) => {
    const path = `repository.branches[${index}]`;
    const branchObject = objectValue(branch, path, source);
    exactFields(branchObject, ['name', 'svn_url', 'tracking_policy'], [], path, source);
    return {
      name: stringValue(branchObject.name, `${path}.name`, source, IDENTIFIER),
      svn_url: validateSvnUrl(branchObject.svn_url, `${path}.svn_url`, source),
      tracking_policy: literal(branchObject.tracking_policy, ['continuous'], `${path}.tracking_policy`, source),
    };
  });
  if (new Set(branches.map((branch) => branch.name)).size !== branches.length) fail('CONFIG_SCHEMA_INVALID', 'repository branch names must be unique', source);
  return {
    schema: 'ue-codebase-mcp/repository', version: 1,
    id: stringValue(object.id, 'repository.id', source, IDENTIFIER),
    project_id: stringValue(object.project_id, 'repository.project_id', source, IDENTIFIER),
    kind: literal(object.kind, ['svn'], 'repository.kind', source),
    role: literal(object.role, ['engine', 'game', 'plugin'], 'repository.role', source),
    canonical_url: validateSvnUrl(object.canonical_url, 'repository.canonical_url', source),
    credential: secretReference(object.credential, 'repository.credential', source),
    enabled: booleanValue(object.enabled, 'repository.enabled', source),
    branches,
  };
}

function validateProviderEndpoint(value: unknown, hosts: string[], source: string): string {
  const endpoint = stringValue(value, 'provider.endpoint', source);
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { fail('CONFIG_SCHEMA_INVALID', 'provider.endpoint must be an absolute URL', source); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail('CONFIG_SCHEMA_INVALID', 'provider.endpoint must use HTTPS without credentials, query, or fragment', source);
  }
  if (!hosts.includes(parsed.hostname.toLowerCase())) fail('CONFIG_PROVIDER_ENDPOINT_DENIED', 'provider.endpoint host is not administrator allowlisted', source);
  return endpoint;
}

function validateProvider(value: unknown, source: string): ProviderConfig {
  const object = objectValue(value, 'provider', source);
  exactFields(object, ['schema', 'version', 'id', 'kind', 'endpoint', 'allowed_hosts', 'credential', 'embedding', 'data_processing_approved', 'enabled'], ['rerank'], 'provider', source);
  validateHeader(object, 'provider', source);
  if (!Array.isArray(object.allowed_hosts) || object.allowed_hosts.length === 0 || object.allowed_hosts.length > 16) {
    fail('CONFIG_SCHEMA_INVALID', 'provider.allowed_hosts must be a non-empty bounded sequence', source);
  }
  const allowedHosts = object.allowed_hosts.map((host, index) => stringValue(host, `provider.allowed_hosts[${index}]`, source, HOSTNAME).toLowerCase());
  if (new Set(allowedHosts).size !== allowedHosts.length) fail('CONFIG_SCHEMA_INVALID', 'provider.allowed_hosts must not contain duplicates', source);
  const embeddingObject = objectValue(object.embedding, 'provider.embedding', source);
  exactFields(embeddingObject, ['model', 'dimensions'], [], 'provider.embedding', source);
  const approved = booleanValue(object.data_processing_approved, 'provider.data_processing_approved', source);
  const enabled = booleanValue(object.enabled, 'provider.enabled', source);
  if (enabled && !approved) fail('CONFIG_PROVIDER_APPROVAL_REQUIRED', 'an enabled provider requires recorded data-processing approval', source);
  const provider: ProviderConfig = {
    schema: 'ue-codebase-mcp/provider', version: 1,
    id: stringValue(object.id, 'provider.id', source, IDENTIFIER),
    kind: literal(object.kind, ['openai-compatible'], 'provider.kind', source),
    endpoint: validateProviderEndpoint(object.endpoint, allowedHosts, source),
    allowed_hosts: allowedHosts,
    credential: secretReference(object.credential, 'provider.credential', source),
    embedding: {
      model: stringValue(embeddingObject.model, 'provider.embedding.model', source, MODEL_IDENTIFIER),
      dimensions: integerValue(embeddingObject.dimensions, 'provider.embedding.dimensions', source, 1, 16_000),
    },
    data_processing_approved: approved,
    enabled,
  };
  if (object.rerank !== undefined) {
    const rerankObject = objectValue(object.rerank, 'provider.rerank', source);
    exactFields(rerankObject, ['model'], [], 'provider.rerank', source);
    provider.rerank = { model: stringValue(rerankObject.model, 'provider.rerank.model', source, MODEL_IDENTIFIER) };
  }
  return provider;
}

function validatePreset(value: unknown, source: string): PresetConfig {
  const object = objectValue(value, 'preset', source);
  validateHeader(object, 'preset', source);
  const kind = literal(object.kind, ['reindex', 'ubt_build', 'uat_test'], 'preset.kind', source);
  const common = {
    schema: 'ue-codebase-mcp/preset' as const,
    version: 1 as const,
    id: stringValue(object.id, 'preset.id', source, IDENTIFIER),
    project_id: stringValue(object.project_id, 'preset.project_id', source, IDENTIFIER),
    enabled: booleanValue(object.enabled, 'preset.enabled', source),
  };
  if (kind === 'reindex') {
    exactFields(object, ['schema', 'version', 'id', 'project_id', 'kind', 'enabled', 'scopes', 'resource_policy'], [], 'preset', source);
    return { ...common, kind, scopes: uniqueStringArray(object.scopes, 'preset.scopes', source, ['engine', 'game', 'plugin']) as ReindexPresetConfig['scopes'], resource_policy: resourcePolicy(object.resource_policy, 'preset.resource_policy', source) };
  }
  if (kind === 'ubt_build') {
    exactFields(object, ['schema', 'version', 'id', 'project_id', 'kind', 'enabled', 'target', 'platform', 'configuration', 'clean', 'resource_policy'], [], 'preset', source);
    return {
      ...common, kind,
      target: stringValue(object.target, 'preset.target', source, TARGET_IDENTIFIER),
      platform: literal(object.platform, ['Win64'], 'preset.platform', source),
      configuration: literal(object.configuration, ['Debug', 'DebugGame', 'Development', 'Shipping', 'Test'], 'preset.configuration', source),
      clean: booleanValue(object.clean, 'preset.clean', source),
      resource_policy: resourcePolicy(object.resource_policy, 'preset.resource_policy', source),
    };
  }
  exactFields(object, ['schema', 'version', 'id', 'project_id', 'kind', 'enabled', 'test_plan', 'platform', 'configuration', 'resource_policy'], [], 'preset', source);
  return {
    ...common, kind,
    test_plan: stringValue(object.test_plan, 'preset.test_plan', source, IDENTIFIER),
    platform: literal(object.platform, ['Win64'], 'preset.platform', source),
    configuration: literal(object.configuration, ['DebugGame', 'Development', 'Shipping', 'Test'], 'preset.configuration', source),
    resource_policy: resourcePolicy(object.resource_policy, 'preset.resource_policy', source),
  };
}

function configKind(value: unknown, source: string): ConfigKind {
  const object = objectValue(value, 'configuration', source);
  const schema = stringValue(object.schema, 'schema', source);
  if (!schema.startsWith(SCHEMA_PREFIX)) fail('CONFIG_SCHEMA_INVALID', 'schema is not supported', source);
  return literal(schema.slice(SCHEMA_PREFIX.length), ['project', 'repository', 'provider', 'preset'], 'schema', source);
}

function parseOverrideBoolean(value: string, name: string, source: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  fail('CONFIG_ENV_INVALID', `${name} must be exactly 'true' or 'false'`, source);
}

export function applyEnvironmentOverrides(value: unknown, env: NodeJS.ProcessEnv, source = '<configuration>'): unknown {
  const kind = configKind(value, source);
  const allowed = environmentOverrides[kind];
  for (const name of Object.keys(env)) {
    if (name.startsWith('UE_MCP_') && !Object.hasOwn(allowed, name)) {
      fail('CONFIG_ENV_FORBIDDEN', `environment override '${name}' is not allowlisted for ${kind} configuration`, source);
    }
  }
  const result = structuredClone(value) as Record<string, unknown>;
  for (const [name, field] of Object.entries(allowed)) {
    const override = env[name];
    if (override === undefined) continue;
    result[field] = field === 'enabled' ? parseOverrideBoolean(override, name, source) : override;
  }
  return result;
}

export function validateConfig(value: unknown, source = '<configuration>'): VersionedConfig {
  switch (configKind(value, source)) {
    case 'project': return validateProject(value, source);
    case 'repository': return validateRepository(value, source);
    case 'provider': return validateProvider(value, source);
    case 'preset': return validatePreset(value, source);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export function loadConfig(text: string, options: { source?: string; env?: NodeJS.ProcessEnv } = {}): VersionedConfig {
  const source = options.source ?? '<configuration>';
  const parsed = parseYamlSubset(text, source);
  const overridden = options.env === undefined ? parsed : applyEnvironmentOverrides(parsed, options.env, source);
  return deepFreeze(validateConfig(overridden, source));
}

export async function loadConfigFile(path: string, options: { env?: NodeJS.ProcessEnv } = {}): Promise<VersionedConfig> {
  const text = await readFile(path, 'utf8');
  return loadConfig(text, { source: path, env: options.env });
}

export function safeConfigForLog(config: VersionedConfig): Readonly<Record<string, unknown>> {
  const base: Record<string, unknown> = {
    schema: config.schema,
    version: config.version,
    id: config.id,
  };
  if ('project_id' in config) base.project_id = config.project_id;
  if ('kind' in config) base.kind = config.kind;
  if ('enabled' in config) base.enabled = config.enabled;
  if (config.schema === 'ue-codebase-mcp/provider') {
    base.endpoint_host = new URL(config.endpoint).hostname;
    base.credential = '[secret-ref-redacted]';
  }
  if (config.schema === 'ue-codebase-mcp/repository') {
    base.repository_kind = config.kind;
    base.credential = '[secret-ref-redacted]';
  }
  return Object.freeze(base);
}
