import { createHash } from 'node:crypto';

export type ClangSymbolKind = 'namespace' | 'class' | 'struct' | 'union' | 'function' | 'method' | 'constructor' | 'destructor';

export interface ClangSymbolLocationHint {
  kind: 'declaration' | 'definition';
  file: string;
  line: number;
}

export interface ClangMemberHint {
  name: string;
  type: string;
  access?: string;
}

export interface ClangSymbolRecord {
  stable_usr: string;
  clang_symbol_id: string;
  qualified_name: string;
  kind: ClangSymbolKind;
  owner_usr?: string;
  signature: string;
  signature_hash: string;
  documentation?: string;
  template_parameters: readonly string[];
  locations: readonly ClangSymbolLocationHint[];
  member_hints: readonly ClangMemberHint[];
}

interface YamlLine {
  indent: number;
  text: string;
  line: number;
}

interface ParseResult {
  value: unknown;
  next: number;
}

const CLANG_ID = /^[A-F0-9]{40}$/;
const MAX_YAML_BYTES = 16 * 1024 * 1024;
const MAX_YAML_LINES = 500_000;

function invalid(message = 'clang-doc YAML is invalid'): never {
  throw new TypeError(message);
}

function mappingPair(text: string): [string, string] {
  let single = false;
  let double = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "'" && !double) single = !single;
    else if (character === '"' && !single && text[index - 1] !== '\\') double = !double;
    else if (character === ':' && !single && !double) {
      const key = text.slice(0, index).trim();
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) invalid();
      return [key, text.slice(index + 1).trim()];
    }
  }
  return invalid();
}

function scalar(text: string): unknown {
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) invalid();
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (text.startsWith('"')) {
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value !== 'string') invalid();
      return value;
    } catch { return invalid(); }
  }
  if (/^-?(?:0|[1-9][0-9]*)$/.test(text)) return Number(text);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (!text || /^[&*!>|@`{}\[\]]/.test(text) || /[\0\r\n]/.test(text)) invalid('clang-doc YAML uses unsupported scalar syntax');
  return text;
}

function parseNode(lines: readonly YamlLine[], start: number, indent: number, depth = 0): ParseResult {
  if (depth > 32 || start >= lines.length || lines[start].indent !== indent) invalid();
  return lines[start].text.startsWith('-') ? parseSequence(lines, start, indent, depth) : parseMapping(lines, start, indent, depth);
}

function parseMapping(lines: readonly YamlLine[], start: number, indent: number, depth: number): ParseResult {
  const value: Record<string, unknown> = {};
  let index = start;
  while (index < lines.length && lines[index].indent === indent && !lines[index].text.startsWith('-')) {
    const [key, encoded] = mappingPair(lines[index].text);
    if (Object.hasOwn(value, key)) invalid('clang-doc YAML contains a duplicate field');
    index += 1;
    if (encoded) value[key] = scalar(encoded);
    else if (index < lines.length && lines[index].indent > indent) {
      const nested = parseNode(lines, index, lines[index].indent, depth + 1);
      value[key] = nested.value;
      index = nested.next;
    } else value[key] = null;
  }
  return { value, next: index };
}

function parseSequence(lines: readonly YamlLine[], start: number, indent: number, depth: number): ParseResult {
  const value: unknown[] = [];
  let index = start;
  while (index < lines.length && lines[index].indent === indent && lines[index].text.startsWith('-')) {
    const item = lines[index].text.slice(1).trim();
    index += 1;
    if (!item) {
      if (index >= lines.length || lines[index].indent <= indent) invalid();
      const nested = parseNode(lines, index, lines[index].indent, depth + 1);
      value.push(nested.value);
      index = nested.next;
      continue;
    }
    if (!item.includes(':')) { value.push(scalar(item)); continue; }
    const object: Record<string, unknown> = {};
    const [firstKey, encoded] = mappingPair(item);
    if (encoded) object[firstKey] = scalar(encoded);
    else {
      if (index >= lines.length || lines[index].indent <= indent + 2) invalid();
      const nested = parseNode(lines, index, lines[index].indent, depth + 1);
      object[firstKey] = nested.value;
      index = nested.next;
    }
    if (index < lines.length && lines[index].indent === indent + 2 && !lines[index].text.startsWith('-')) {
      const continuation = parseMapping(lines, index, indent + 2, depth + 1);
      for (const [key, nestedValue] of Object.entries(continuation.value as Record<string, unknown>)) {
        if (Object.hasOwn(object, key)) invalid('clang-doc YAML contains a duplicate field');
        object[key] = nestedValue;
      }
      index = continuation.next;
    }
    value.push(object);
  }
  return { value, next: index };
}

export function parseClangDocYaml(text: string): unknown {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_YAML_BYTES || text.includes('\0') || text.includes('\t')) invalid();
  const lines: YamlLine[] = [];
  const rawLines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  if (rawLines.length > MAX_YAML_LINES) invalid('clang-doc YAML has too many lines');
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index];
    if (!raw.trim() || raw.trim() === '---' || raw.trim() === '...') continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent % 2 !== 0) invalid();
    lines.push({ indent, text: raw.trimStart(), line: index + 1 });
  }
  if (lines.length === 0 || lines[0].indent !== 0) invalid();
  const parsed = parseNode(lines, 0, 0);
  if (parsed.next !== lines.length) invalid();
  return parsed.value;
}

function record(value: unknown, name = 'clang-doc value'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${name} is invalid`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\r\n\0]/.test(value)) invalid(`${name} is invalid`);
  return value;
}

function symbolId(value: unknown): string {
  const id = text(value, 'clang symbol id');
  if (!CLANG_ID.test(id)) invalid('clang symbol id is invalid');
  return id;
}

function array(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100_000) invalid();
  return value;
}

function location(value: unknown, kind: ClangSymbolLocationHint['kind']): ClangSymbolLocationHint | undefined {
  if (value === undefined || value === null) return undefined;
  const item = record(value, 'clang location');
  const file = text(item.Filename, 'clang location filename');
  const line = item.LineNumber;
  if (!Number.isSafeInteger(line) || (line as number) < 1) invalid('clang location line is invalid');
  return Object.freeze({ kind, file, line: line as number });
}

function typeName(value: unknown): string {
  const item = record(value, 'clang type');
  return text(item.QualName ?? item.Name, 'clang type name');
}

function comments(value: unknown): string | undefined {
  const output: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 32) invalid();
    if (Array.isArray(node)) { for (const child of node) visit(child, depth + 1); return; }
    if (typeof node !== 'object' || node === null) return;
    const item = node as Record<string, unknown>;
    if (typeof item.Text === 'string') output.push(item.Text.trim());
    if (item.Children !== undefined) visit(item.Children, depth + 1);
  };
  visit(value, 0);
  const result = output.filter(Boolean).join('\n').trim();
  return result || undefined;
}

function stable(id: string): string {
  return `clang-doc-sha1:${id.toLowerCase()}`;
}

function makeSymbol(input: Omit<ClangSymbolRecord, 'signature_hash'>): ClangSymbolRecord {
  return Object.freeze({
    ...input,
    signature_hash: createHash('sha256').update(input.signature).digest('hex'),
    template_parameters: Object.freeze([...input.template_parameters]),
    locations: Object.freeze([...input.locations]),
    member_hints: Object.freeze([...input.member_hints]),
  });
}

function namespacePath(value: Record<string, unknown>): string[] {
  return array(value.Namespace).map((entry) => text(record(entry).Name, 'namespace name')).reverse();
}

export function normalizeClangDocYaml(yaml: string): readonly ClangSymbolRecord[] {
  const root = record(parseClangDocYaml(yaml), 'clang-doc document');
  const rootId = symbolId(root.USR);
  const rootName = text(root.Name, 'clang symbol name');
  const ownerPath = namespacePath(root);
  const qualifiedName = [...ownerPath, rootName].join('::');
  const symbols: ClangSymbolRecord[] = [];
  const tag = root.TagType;
  const rootKind: ClangSymbolKind = tag === 'Class' ? 'class' : tag === 'Struct' ? 'struct' : tag === 'Union' ? 'union' : 'namespace';
  const templateParameters = array(record(root.Template ?? {}).Params).map((entry) => text(record(entry).Contents, 'template parameter'));
  const locations = [location(root.DefLocation, 'definition')].filter((value): value is ClangSymbolLocationHint => value !== undefined);
  const members = array(root.Members).map((entry) => {
    const item = record(entry, 'clang member');
    return Object.freeze({ name: text(item.Name, 'member name'), type: typeName(item.Type), ...(item.Access === undefined ? {} : { access: text(item.Access, 'member access').toLowerCase() }) });
  });
  symbols.push(makeSymbol({
    stable_usr: stable(rootId), clang_symbol_id: rootId, qualified_name: qualifiedName, kind: rootKind,
    signature: `${rootKind} ${qualifiedName}${templateParameters.length ? `<${templateParameters.join(',')}>` : ''}`,
    ...(comments(root.Description) === undefined ? {} : { documentation: comments(root.Description) }),
    template_parameters: templateParameters, locations, member_hints: members,
  }));

  for (const entry of array(root.ChildFunctions)) {
    const item = record(entry, 'clang function');
    const id = symbolId(item.USR);
    const name = text(item.Name, 'function name');
    const owner = item.Parent === undefined ? undefined : record(item.Parent, 'function parent');
    const parentId = owner === undefined ? undefined : symbolId(owner.USR);
    const parentName = owner === undefined ? undefined : text(owner.QualName ?? owner.Name, 'function parent name');
    const functionQualifiedName = parentName === undefined ? [...namespacePath(item), name].join('::') : `${parentName}::${name}`;
    const parameters = array(item.Params).map((parameter) => typeName(record(parameter).Type));
    const returnType = item.ReturnType === undefined ? '' : typeName(record(item.ReturnType).Type);
    const kind: ClangSymbolKind = name === rootName ? 'constructor' : name === `~${rootName}` ? 'destructor' : item.IsMethod === true ? 'method' : 'function';
    const functionLocations = [
      ...array(item.Location).map((value) => location(value, 'declaration')),
      location(item.DefLocation, 'definition'),
    ].filter((value): value is ClangSymbolLocationHint => value !== undefined);
    const signature = `${returnType ? `${returnType} ` : ''}${functionQualifiedName}(${parameters.join(',')})`;
    symbols.push(makeSymbol({
      stable_usr: stable(id), clang_symbol_id: id, qualified_name: functionQualifiedName, kind,
      ...(parentId === undefined ? {} : { owner_usr: stable(parentId) }), signature,
      ...(comments(item.Description) === undefined ? {} : { documentation: comments(item.Description) }),
      template_parameters: [], locations: functionLocations, member_hints: [],
    }));
  }
  return Object.freeze(symbols);
}
