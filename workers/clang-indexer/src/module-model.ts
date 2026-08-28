export type ModuleDependencyVisibility = 'public' | 'private' | 'dynamic';

export interface SourceLocation {
  path: string;
  line: number;
  column: number;
}

export interface ModuleDependencyModel {
  name: string;
  visibility: ModuleDependencyVisibility;
  condition: string | null;
  source: SourceLocation;
}

export interface BuildModuleModel {
  name: string;
  source_path: string;
  dependencies: ModuleDependencyModel[];
  diagnostics: Array<{ code: string; line: number }>;
}

export interface DescriptorModuleModel {
  name: string;
  type: string;
  loading_phase: string;
  platform_allow_list: string[];
  platform_deny_list: string[];
}

export interface ProjectDescriptorModel {
  kind: 'project' | 'plugin';
  name: string;
  engine_version?: string;
  modules: DescriptorModuleModel[];
  plugins: Array<{ name: string; enabled: boolean }>;
}

export interface TargetModel {
  name: string;
  target_type: 'Game' | 'Editor' | 'Client' | 'Server' | 'Program' | 'Unknown';
  extra_modules: Array<{ name: string; condition: string | null; source: SourceLocation }>;
  source_path: string;
}

interface ConditionalRange { start: number; end: number; expression: string }

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const PLATFORM = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function sourcePosition(source: string, offset: number, path: string): SourceLocation {
  const prefix = source.slice(0, offset);
  const line = prefix.split('\n').length;
  const lastNewline = prefix.lastIndexOf('\n');
  return { path, line, column: offset - lastNewline };
}

function sanitizeCsharp(source: string): string {
  if (Buffer.byteLength(source, 'utf8') > 2 * 1024 * 1024) throw new TypeError('rules source exceeds 2 MiB');
  let output = '';
  let index = 0;
  let mode: 'code' | 'line-comment' | 'block-comment' | 'string' | 'verbatim-string' | 'char' = 'code';
  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (mode === 'code') {
      if (current === '/' && next === '/') { output += '  '; index += 2; mode = 'line-comment'; continue; }
      if (current === '/' && next === '*') { output += '  '; index += 2; mode = 'block-comment'; continue; }
      if (current === '@' && next === '"') { output += '@"'; index += 2; mode = 'verbatim-string'; continue; }
      if (current === '"') { output += current; index += 1; mode = 'string'; continue; }
      if (current === "'") { output += current; index += 1; mode = 'char'; continue; }
      output += current; index += 1; continue;
    }
    if (mode === 'line-comment') {
      if (current === '\n') { output += '\n'; mode = 'code'; } else output += ' ';
      index += 1; continue;
    }
    if (mode === 'block-comment') {
      if (current === '*' && next === '/') { output += '  '; index += 2; mode = 'code'; } else { output += current === '\n' ? '\n' : ' '; index += 1; }
      continue;
    }
    if (mode === 'string') {
      output += current;
      if (current === '\\' && next !== undefined) { output += next; index += 2; continue; }
      if (current === '"') mode = 'code';
      index += 1; continue;
    }
    if (mode === 'verbatim-string') {
      output += current;
      if (current === '"' && next === '"') { output += next; index += 2; continue; }
      if (current === '"') mode = 'code';
      index += 1; continue;
    }
    output += current;
    if (current === '\\' && next !== undefined) { output += next; index += 2; continue; }
    if (current === "'") mode = 'code';
    index += 1;
  }
  if (mode === 'block-comment' || mode === 'string' || mode === 'verbatim-string' || mode === 'char') throw new TypeError('unterminated C# token');
  return output;
}

function matching(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  let inString = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"' && source[index - 1] !== '\\') inString = !inString;
    if (inString) continue;
    if (character === open) depth += 1;
    if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function normalizeCondition(expression: string): string {
  const compact = expression.replace(/\s+/g, ' ').trim();
  if (compact.length === 0 || compact.length > 512 || /[;{}"']/.test(compact)) throw new TypeError('unsupported Build.cs condition');
  return compact
    .replaceAll(/Target\.Platform\s*==\s*UnrealTargetPlatform\.([A-Za-z][A-Za-z0-9_]*)/g, 'platform == $1')
    .replaceAll(/Target\.Platform\s*!=\s*UnrealTargetPlatform\.([A-Za-z][A-Za-z0-9_]*)/g, 'platform != $1')
    .replaceAll(/Target\.Configuration\s*==\s*UnrealTargetConfiguration\.([A-Za-z][A-Za-z0-9_]*)/g, 'configuration == $1')
    .replaceAll(/Target\.Configuration\s*!=\s*UnrealTargetConfiguration\.([A-Za-z][A-Za-z0-9_]*)/g, 'configuration != $1');
}

function conditionalRanges(source: string): ConditionalRange[] {
  const ranges: ConditionalRange[] = [];
  const pattern = /\bif\s*\(/g;
  for (const match of source.matchAll(pattern)) {
    const openParen = (match.index ?? 0) + match[0].lastIndexOf('(');
    const closeParen = matching(source, openParen, '(', ')');
    if (closeParen < 0) throw new TypeError('unbalanced Build.cs if condition');
    let brace = closeParen + 1;
    while (/\s/.test(source[brace] ?? '')) brace += 1;
    if (source[brace] !== '{') continue;
    const end = matching(source, brace, '{', '}');
    if (end < 0) throw new TypeError('unbalanced Build.cs conditional block');
    ranges.push({ start: brace + 1, end, expression: normalizeCondition(source.slice(openParen + 1, closeParen)) });
  }
  return ranges;
}

function conditionAt(offset: number, ranges: ConditionalRange[]): string | null {
  const containing = ranges.filter((range) => offset >= range.start && offset < range.end).sort((a, b) => a.start - b.start);
  return containing.length === 0 ? null : containing.map(({ expression }) => `(${expression})`).join(' && ');
}

function decodeStringLiteral(value: string): string {
  if (value.startsWith('@"')) return value.slice(2, -1).replaceAll('""', '"');
  return JSON.parse(value);
}

function strings(value: string): string[] {
  const result: string[] = [];
  for (const match of value.matchAll(/@"(?:[^"]|"")*"|"(?:\\.|[^"\\])*"/g)) {
    const decoded = decodeStringLiteral(match[0]);
    if (!IDENTIFIER.test(decoded)) throw new TypeError('module name is invalid');
    result.push(decoded);
  }
  return result;
}

function calls(source: string, receiverPattern: string): Array<{ offset: number; receiver: string; arguments: string }> {
  const pattern = new RegExp(`\\b(${receiverPattern})\\s*\\.\\s*(?:Add|AddRange)\\s*\\(`, 'g');
  const result = [];
  for (const match of source.matchAll(pattern)) {
    const offset = match.index ?? 0;
    const open = offset + match[0].lastIndexOf('(');
    const close = matching(source, open, '(', ')');
    if (close < 0) throw new TypeError('unbalanced rules method call');
    result.push({ offset, receiver: match[1], arguments: source.slice(open + 1, close) });
  }
  return result;
}

export function parseBuildCs(sourceText: string, sourcePath: string): BuildModuleModel {
  const source = sanitizeCsharp(sourceText.replaceAll('\r\n', '\n'));
  const classMatch = /\bclass\s+([A-Za-z][A-Za-z0-9_]*)\s*:\s*ModuleRules\b/.exec(source);
  if (!classMatch) throw new TypeError('Build.cs must declare one ModuleRules class');
  const ranges = conditionalRanges(source);
  const dependencies: ModuleDependencyModel[] = [];
  const diagnostics: BuildModuleModel['diagnostics'] = [];
  const visibility: Record<string, ModuleDependencyVisibility> = {
    PublicDependencyModuleNames: 'public', PrivateDependencyModuleNames: 'private', DynamicallyLoadedModuleNames: 'dynamic',
  };
  for (const call of calls(source, 'PublicDependencyModuleNames|PrivateDependencyModuleNames|DynamicallyLoadedModuleNames')) {
    const names = strings(call.arguments);
    if (names.length === 0) diagnostics.push({ code: 'DYNAMIC_DEPENDENCY_EXPRESSION', line: sourcePosition(source, call.offset, sourcePath).line });
    for (const name of names) {
      dependencies.push(Object.freeze({ name, visibility: visibility[call.receiver], condition: conditionAt(call.offset, ranges), source: sourcePosition(source, call.offset, sourcePath) }));
    }
  }
  dependencies.sort((left, right) => left.source.line - right.source.line || left.name.localeCompare(right.name));
  return Object.freeze({ name: classMatch[1], source_path: sourcePath, dependencies: Object.freeze(dependencies) as ModuleDependencyModel[], diagnostics: Object.freeze(diagnostics) as BuildModuleModel['diagnostics'] });
}

function descriptorString(value: unknown, field: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) throw new TypeError(`descriptor ${field} is invalid`);
  return value;
}

function descriptorPlatforms(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32 || value.some((item) => typeof item !== 'string' || !PLATFORM.test(item))) throw new TypeError(`descriptor ${field} is invalid`);
  return [...new Set(value)].sort();
}

export function parseDescriptor(json: string, sourcePath: string): ProjectDescriptorModel {
  if (Buffer.byteLength(json, 'utf8') > 1024 * 1024) throw new TypeError('descriptor exceeds 1 MiB');
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new TypeError('descriptor JSON is invalid'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('descriptor must be an object');
  const object = value as Record<string, unknown>;
  const modulesValue = object.Modules ?? [];
  if (!Array.isArray(modulesValue) || modulesValue.length > 512) throw new TypeError('descriptor Modules is invalid');
  const modules = modulesValue.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new TypeError('descriptor module is invalid');
    const module = entry as Record<string, unknown>;
    return Object.freeze({
      name: descriptorString(module.Name, 'module Name'),
      type: descriptorString(module.Type, 'module Type', 'Runtime'),
      loading_phase: descriptorString(module.LoadingPhase, 'module LoadingPhase', 'Default'),
      platform_allow_list: descriptorPlatforms(module.PlatformAllowList ?? module.WhitelistPlatforms, 'PlatformAllowList'),
      platform_deny_list: descriptorPlatforms(module.PlatformDenyList ?? module.BlacklistPlatforms, 'PlatformDenyList'),
    });
  });
  if (new Set(modules.map(({ name }) => name)).size !== modules.length) throw new TypeError('descriptor module names must be unique');
  const pluginsValue = object.Plugins ?? [];
  if (!Array.isArray(pluginsValue) || pluginsValue.length > 512) throw new TypeError('descriptor Plugins is invalid');
  const plugins = pluginsValue.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new TypeError('descriptor plugin is invalid');
    const plugin = entry as Record<string, unknown>;
    if (typeof plugin.Enabled !== 'boolean') throw new TypeError('descriptor plugin Enabled is invalid');
    return Object.freeze({ name: descriptorString(plugin.Name, 'plugin Name'), enabled: plugin.Enabled });
  });
  const extension = sourcePath.toLowerCase().endsWith('.uplugin') ? 'plugin' : sourcePath.toLowerCase().endsWith('.uproject') ? 'project' : undefined;
  if (!extension) throw new TypeError('descriptor path must end with .uproject or .uplugin');
  const filename = sourcePath.replaceAll('\\', '/').split('/').at(-1)!;
  const model: ProjectDescriptorModel = {
    kind: extension,
    name: filename.replace(/\.(?:uproject|uplugin)$/i, ''),
    modules: Object.freeze(modules) as DescriptorModuleModel[],
    plugins: Object.freeze(plugins) as Array<{ name: string; enabled: boolean }>,
  };
  if (object.EngineAssociation !== undefined) model.engine_version = descriptorString(object.EngineAssociation, 'EngineAssociation');
  return Object.freeze(model);
}

export function parseTargetCs(sourceText: string, sourcePath: string): TargetModel {
  const source = sanitizeCsharp(sourceText.replaceAll('\r\n', '\n'));
  const classMatch = /\bclass\s+([A-Za-z][A-Za-z0-9_]*)Target\s*:\s*TargetRules\b/.exec(source);
  if (!classMatch) throw new TypeError('Target.cs must declare one TargetRules class ending in Target');
  const typeMatch = /\bType\s*=\s*TargetType\.([A-Za-z][A-Za-z0-9_]*)\s*;/.exec(source);
  const targetType = typeMatch && ['Game', 'Editor', 'Client', 'Server', 'Program'].includes(typeMatch[1]) ? typeMatch[1] as TargetModel['target_type'] : 'Unknown';
  const ranges = conditionalRanges(source);
  const extraModules = [];
  for (const call of calls(source, 'ExtraModuleNames')) {
    for (const name of strings(call.arguments)) extraModules.push(Object.freeze({ name, condition: conditionAt(call.offset, ranges), source: sourcePosition(source, call.offset, sourcePath) }));
  }
  return Object.freeze({ name: classMatch[1], target_type: targetType, extra_modules: Object.freeze(extraModules), source_path: sourcePath });
}

