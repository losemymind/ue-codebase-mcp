export type UhtMacroKind = 'UCLASS' | 'UFUNCTION' | 'UPROPERTY';
export type BlueprintExposure = 'none' | 'callable' | 'pure' | 'event' | 'type' | 'property';

export interface UhtAnnotation {
  macro: UhtMacroKind;
  macro_line: number;
  declaration_line: number;
  symbol_name: string;
  specifiers: readonly string[];
  metadata: Readonly<Record<string, string>>;
  blueprint_exposure: BlueprintExposure;
}

export interface UhtSymbolMetadata {
  stable_usr: string;
  uht_specifiers: readonly string[];
  uht_metadata: Readonly<Record<string, string>>;
  blueprint_exposure: BlueprintExposure;
}

export interface UhtAttachmentReport {
  metadata: readonly UhtSymbolMetadata[];
  unmatched: readonly UhtAnnotation[];
  ambiguous: readonly UhtAnnotation[];
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MACROS = new Set<UhtMacroKind>(['UCLASS', 'UFUNCTION', 'UPROPERTY']);

function sourceLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) if (source.charCodeAt(index) === 10) starts.push(index + 1);
  return starts;
}

function lineAt(starts: readonly number[], index: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= index) low = middle + 1; else high = middle;
  }
  return low;
}

function closingParenthesis(source: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 ? source.length : newline;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2);
      if (close < 0) throw new TypeError('UHT annotation has an unterminated comment');
      index = close + 1;
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')' && --depth === 0) return index;
  }
  throw new TypeError('UHT annotation has unbalanced parentheses');
}

function splitArguments(source: string): string[] {
  const values: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let index = 0; index <= source.length; index += 1) {
    const character = source[index] ?? ',';
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ',' && depth === 0) {
      const value = source.slice(start, index).trim();
      if (value) values.push(value);
      start = index + 1;
    }
  }
  if (quote || depth !== 0 || values.length > 1024) throw new TypeError('UHT annotation arguments are invalid');
  return values;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch { /* fixed error below */ }
    throw new TypeError('UHT metadata string is invalid');
  }
  if (!/^[A-Za-z0-9_.:/ +-]{1,4096}$/.test(trimmed)) throw new TypeError('UHT metadata value is invalid');
  return trimmed;
}

function parsedArguments(source: string): { specifiers: string[]; metadata: Record<string, string> } {
  const specifiers: string[] = [];
  const metadata: Record<string, string> = {};
  const add = (encoded: string): void => {
    const equals = encoded.indexOf('=');
    const key = (equals < 0 ? encoded : encoded.slice(0, equals)).trim();
    if (!IDENTIFIER.test(key)) throw new TypeError('UHT specifier is invalid');
    if (!specifiers.includes(key)) specifiers.push(key);
    if (equals >= 0) {
      if (Object.hasOwn(metadata, key)) throw new TypeError('UHT metadata contains a duplicate key');
      metadata[key] = unquote(encoded.slice(equals + 1));
    }
  };
  for (const argument of splitArguments(source)) {
    const meta = /^meta\s*=\s*\((.*)\)$/s.exec(argument);
    if (meta) { for (const value of splitArguments(meta[1])) add(value); }
    else add(argument);
  }
  return { specifiers, metadata };
}

function exposure(macro: UhtMacroKind, specifiers: readonly string[]): BlueprintExposure {
  const values = new Set(specifiers);
  if (macro === 'UCLASS' && (values.has('BlueprintType') || values.has('Blueprintable'))) return 'type';
  if (macro === 'UPROPERTY' && (values.has('BlueprintReadOnly') || values.has('BlueprintReadWrite'))) return 'property';
  if (macro === 'UFUNCTION') {
    if (values.has('BlueprintPure')) return 'pure';
    if (values.has('BlueprintImplementableEvent') || values.has('BlueprintNativeEvent')) return 'event';
    if (values.has('BlueprintCallable')) return 'callable';
  }
  return 'none';
}

function declaration(source: string, start: number, macro: UhtMacroKind): { name: string; index: number } {
  const limit = Math.min(source.length, start + 16_384);
  const terminator = macro === 'UCLASS'
    ? Math.min(...['{', ':', ';'].map((value) => { const found = source.indexOf(value, start); return found < 0 ? limit : found; }))
    : Math.min(...[';', '{'].map((value) => { const found = source.indexOf(value, start); return found < 0 ? limit : found; }));
  const fragment = source.slice(start, Math.min(terminator, limit));
  if (macro === 'UCLASS') {
    const match = /\b(?:class|struct)\s+((?:[A-Za-z_][A-Za-z0-9_]*\s+)+)/.exec(fragment);
    const names = match?.[1].trim().split(/\s+/) ?? [];
    const name = names.at(-1);
    if (name === undefined) throw new TypeError('UHT class declaration is unavailable');
    return { name, index: start + match!.index + match![0].lastIndexOf(name) };
  }
  if (macro === 'UFUNCTION') {
    const matches = [...fragment.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)];
    const match = matches.at(-1);
    if (match === undefined) throw new TypeError('UHT function declaration is unavailable');
    return { name: match[1], index: start + match.index! };
  }
  const beforeInitializer = fragment.split('=')[0];
  const matches = [...beforeInitializer.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)];
  const match = matches.at(-1);
  if (match === undefined) throw new TypeError('UHT property declaration is unavailable');
  return { name: match[0], index: start + match.index! };
}

export function extractUhtAnnotations(source: string): readonly UhtAnnotation[] {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES || source.includes('\0')) throw new TypeError('UHT source is invalid');
  const output: UhtAnnotation[] = [];
  const lineStarts = sourceLineStarts(source);
  let state: 'code' | 'line-comment' | 'block-comment' | 'string' | 'character' = 'code';
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (state === 'line-comment') { if (character === '\n') state = 'code'; index += 1; continue; }
    if (state === 'block-comment') { if (character === '*' && source[index + 1] === '/') { state = 'code'; index += 2; } else index += 1; continue; }
    if (state === 'string' || state === 'character') {
      if (character === '\\') index += 2;
      else { if ((state === 'string' && character === '"') || (state === 'character' && character === "'")) state = 'code'; index += 1; }
      continue;
    }
    if (character === '/' && source[index + 1] === '/') { state = 'line-comment'; index += 2; continue; }
    if (character === '/' && source[index + 1] === '*') { state = 'block-comment'; index += 2; continue; }
    if (character === '"') { state = 'string'; index += 1; continue; }
    if (character === "'") { state = 'character'; index += 1; continue; }
    if (!/[A-Za-z_]/.test(character)) { index += 1; continue; }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index))!;
    const token = match[0];
    if (!MACROS.has(token as UhtMacroKind)) { index += token.length; continue; }
    const lineStart = source.lastIndexOf('\n', index - 1) + 1;
    if (source.slice(lineStart, index).trimStart().startsWith('#')) { index += token.length; continue; }
    let open = index + token.length;
    while (/\s/.test(source[open] ?? '')) open += 1;
    if (source[open] !== '(') { index += token.length; continue; }
    const close = closingParenthesis(source, open);
    const macro = token as UhtMacroKind;
    const values = parsedArguments(source.slice(open + 1, close));
    const target = declaration(source, close + 1, macro);
    output.push(Object.freeze({
      macro, macro_line: lineAt(lineStarts, index), declaration_line: lineAt(lineStarts, target.index), symbol_name: target.name,
      specifiers: Object.freeze(values.specifiers), metadata: Object.freeze(values.metadata),
      blueprint_exposure: exposure(macro, values.specifiers),
    }));
    if (output.length > 100_000) throw new TypeError('UHT annotation count exceeds the limit');
    index = close + 1;
  }
  return Object.freeze(output);
}

export function attachUhtAnnotations(
  symbols: readonly { stable_usr: string; qualified_name: string; kind: string; locations: readonly { kind: string; line: number }[] }[],
  annotations: readonly UhtAnnotation[],
): UhtAttachmentReport {
  const metadata: UhtSymbolMetadata[] = [];
  const unmatched: UhtAnnotation[] = [];
  const ambiguous: UhtAnnotation[] = [];
  for (const annotation of annotations) {
    const acceptedKinds = annotation.macro === 'UCLASS'
      ? new Set(['class', 'struct'])
      : annotation.macro === 'UFUNCTION'
        ? new Set(['function', 'method'])
        : new Set(['field']);
    const candidates = symbols.filter((symbol) =>
      acceptedKinds.has(symbol.kind)
      && symbol.qualified_name.split('::').at(-1) === annotation.symbol_name
      && symbol.locations.some((location) => location.kind === 'declaration' || location.kind === 'definition' ? location.line === annotation.declaration_line : false));
    if (candidates.length === 0) { unmatched.push(annotation); continue; }
    if (candidates.length > 1) { ambiguous.push(annotation); continue; }
    metadata.push(Object.freeze({
      stable_usr: candidates[0].stable_usr,
      uht_specifiers: Object.freeze([...annotation.specifiers]),
      uht_metadata: Object.freeze({ ...annotation.metadata }),
      blueprint_exposure: annotation.blueprint_exposure,
    }));
  }
  return Object.freeze({ metadata: Object.freeze(metadata), unmatched: Object.freeze(unmatched), ambiguous: Object.freeze(ambiguous) });
}
