import { createHash } from 'node:crypto';
import path from 'node:path';
import type { IndexedSymbol } from './symbol-merge.ts';

export type CodeChunkKind = 'declaration' | 'definition' | 'documentation';

export interface ChunkSourceFile {
  absolute_path: string;
  text: string;
}

export interface CodeChunk {
  stable_key: string;
  content_hash: string;
  symbol_usr: string;
  file: string;
  chunk_kind: CodeChunkKind;
  text: string;
  token_count: number;
  start_line: number | null;
  start_column: number | null;
  end_line: number | null;
  end_column: number | null;
  part_index: number;
  part_count: number;
}

export interface CodeChunkingPolicy {
  max_chunk_utf8_bytes?: number;
  max_estimated_tokens?: number;
}

export interface CodeChunkingReport {
  chunks: readonly CodeChunk[];
  source_location_count: number;
  missing_source_location_count: number;
  empty_location_count: number;
  split_chunk_count: number;
}

const MAX_SYMBOLS = 2_000_000;
const MAX_SOURCES = 2_000_000;
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_TOKENS = 8_192;
const MIN_CHUNK_BYTES = 1_024;
const MAX_CHUNK_BYTES = 256 * 1024;
const MIN_TOKENS = 128;
const MAX_TOKENS = 32_768;

function integer(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value as number;
}

function boundedText(value: unknown, maximumBytes: number, name: string): string {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function normalizedAbsolute(value: string, name: string): string {
  if (!path.isAbsolute(value)) throw new TypeError(`${name} must be absolute`);
  return path.resolve(value);
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort((left, right) => left.localeCompare(right, 'en')).map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Conservative, provider-independent estimate used only for batching and database accounting. */
export function estimateCodeTokens(text: string): number {
  boundedText(text, MAX_SOURCE_BYTES, 'chunk text');
  if (text.length === 0) return 0;
  const words = text.match(/[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[^\s\x00-\x7F]|[^\sA-Za-z0-9_]/gu);
  return Math.max(1, words?.length ?? 1);
}

interface OffsetRange {
  start: number;
  end: number;
}

function lineStarts(text: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function offset(starts: readonly number[], textLength: number, line: number, column: number): number | undefined {
  if (line < 1 || line > starts.length || column < 1) return undefined;
  const lineStart = starts[line - 1];
  const nextLineStart = line === starts.length ? textLength : starts[line];
  const lineEnd = nextLineStart > lineStart && nextLineStart <= textLength ? nextLineStart - 1 : nextLineStart;
  const result = lineStart + column - 1;
  return result <= lineEnd ? result : undefined;
}

function locationRange(text: string, starts: readonly number[], location: IndexedSymbol['locations'][number]): OffsetRange | undefined {
  const start = offset(starts, text.length, location.start_line, location.start_column);
  const end = offset(starts, text.length, location.end_line, location.end_column);
  if (start === undefined || end === undefined || end <= start) return undefined;
  return { start, end };
}

function splitText(text: string, maxBytes: number, maxTokens: number): readonly string[] {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes && estimateCodeTokens(text) <= maxTokens) return [text];
  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  let currentTokens = 0;
  const flush = (): void => {
    if (current.length > 0) parts.push(current);
    current = '';
    currentBytes = 0;
    currentTokens = 0;
  };
  const segments = text.match(/\s+|[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[^\s\x00-\x7F]|[^\sA-Za-z0-9_]/gu) ?? [text];
  for (const segment of segments) {
    const segmentBytes = Buffer.byteLength(segment, 'utf8');
    const segmentTokens = /^\s+$/u.test(segment) ? 0 : 1;
    if (segmentBytes <= maxBytes) {
      if (current.length > 0 && (currentBytes + segmentBytes > maxBytes || currentTokens + segmentTokens > maxTokens)) flush();
      current += segment;
      currentBytes += segmentBytes;
      currentTokens += segmentTokens;
      continue;
    }
    if (current.length > 0) flush();
    for (const character of segment) {
      const characterBytes = Buffer.byteLength(character, 'utf8');
      if (current.length > 0 && currentBytes + characterBytes > maxBytes) flush();
      current += character;
      currentBytes += characterBytes;
      currentTokens = segmentTokens;
    }
  }
  flush();
  return parts;
}

interface ChunkSeed {
  symbol_usr: string;
  file: string;
  chunk_kind: CodeChunkKind;
  text: string;
  start_line: number | null;
  start_column: number | null;
  end_line: number | null;
  end_column: number | null;
}

export function codeChunkStableKey(chunk: Pick<CodeChunk,
  'symbol_usr' | 'file' | 'chunk_kind' | 'start_line' | 'start_column' | 'end_line' | 'end_column' | 'part_index' | 'part_count'>): string {
  return sha256(canonical({
    schema_version: 1,
    symbol_usr: chunk.symbol_usr,
    file: pathKey(chunk.file),
    chunk_kind: chunk.chunk_kind,
    start_line: chunk.start_line,
    start_column: chunk.start_column,
    end_line: chunk.end_line,
    end_column: chunk.end_column,
    part_index: chunk.part_index,
    part_count: chunk.part_count,
  }));
}

function materialize(seed: ChunkSeed, maxBytes: number, maxTokens: number): readonly CodeChunk[] {
  const parts = splitText(seed.text, maxBytes, maxTokens);
  return Object.freeze(parts.map((text, partIndex) => {
    const identity = {
      symbol_usr: seed.symbol_usr,
      file: seed.file,
      chunk_kind: seed.chunk_kind,
      start_line: seed.start_line,
      start_column: seed.start_column,
      end_line: seed.end_line,
      end_column: seed.end_column,
      part_index: partIndex,
      part_count: parts.length,
    };
    return Object.freeze({
      stable_key: codeChunkStableKey(identity),
      content_hash: sha256(text),
      symbol_usr: seed.symbol_usr,
      file: seed.file,
      chunk_kind: seed.chunk_kind,
      text,
      token_count: estimateCodeTokens(text),
      start_line: seed.start_line,
      start_column: seed.start_column,
      end_line: seed.end_line,
      end_column: seed.end_column,
      part_index: partIndex,
      part_count: parts.length,
    });
  }));
}

export function createAstAwareCodeChunks(
  symbols: readonly IndexedSymbol[],
  sources: readonly ChunkSourceFile[],
  policy: CodeChunkingPolicy = {},
): CodeChunkingReport {
  if (!Array.isArray(symbols) || symbols.length > MAX_SYMBOLS || !Array.isArray(sources) || sources.length > MAX_SOURCES) {
    throw new TypeError('chunking input is invalid');
  }
  const maxBytes = integer(policy.max_chunk_utf8_bytes ?? DEFAULT_MAX_CHUNK_BYTES, MIN_CHUNK_BYTES, MAX_CHUNK_BYTES, 'max_chunk_utf8_bytes');
  const maxTokens = integer(policy.max_estimated_tokens ?? DEFAULT_MAX_TOKENS, MIN_TOKENS, MAX_TOKENS, 'max_estimated_tokens');
  const sourceByPath = new Map<string, { absolute_path: string; text: string; starts: readonly number[] }>();
  for (const item of sources) {
    if (typeof item !== 'object' || item === null) throw new TypeError('chunk source is invalid');
    const absolutePath = normalizedAbsolute(boundedText(item.absolute_path, 32_768, 'chunk source path'), 'chunk source path');
    const text = boundedText(item.text, MAX_SOURCE_BYTES, 'chunk source text');
    const key = pathKey(absolutePath);
    if (sourceByPath.has(key)) throw new TypeError('chunk sources contain a duplicate path');
    sourceByPath.set(key, { absolute_path: absolutePath, text, starts: lineStarts(text) });
  }

  const seeds: ChunkSeed[] = [];
  let sourceLocations = 0;
  let missingSources = 0;
  let emptyLocations = 0;
  for (const symbol of symbols) {
    if (typeof symbol !== 'object' || symbol === null || typeof symbol.stable_usr !== 'string' || symbol.stable_usr.length === 0
        || symbol.stable_usr.length > 4_096 || /[\r\n\0]/.test(symbol.stable_usr) || !Array.isArray(symbol.locations)
        || typeof symbol.qualified_name !== 'string' || symbol.qualified_name.length === 0 || symbol.qualified_name.length > 32_768) {
      throw new TypeError('chunk symbol is invalid');
    }
    for (const location of symbol.locations) {
      if (typeof location !== 'object' || location === null || (location.kind !== 'declaration' && location.kind !== 'definition')
          || typeof location.file !== 'string' || !path.isAbsolute(location.file)) throw new TypeError('chunk location is invalid');
      for (const coordinate of [location.start_line, location.start_column, location.end_line, location.end_column]) {
        integer(coordinate, 1, 10_000_000, 'chunk location coordinate');
      }
    }
  }
  for (const symbol of [...symbols].sort((left, right) => left.stable_usr.localeCompare(right.stable_usr, 'en'))) {
    const orderedLocations = [...symbol.locations].sort((left, right) =>
      pathKey(left.file).localeCompare(pathKey(right.file), 'en')
      || left.start_line - right.start_line
      || left.start_column - right.start_column
      || left.kind.localeCompare(right.kind, 'en'));
    for (const location of orderedLocations) {
      sourceLocations += 1;
      if (sourceLocations > 10_000_000) throw new TypeError('chunk location count is invalid');
      const source = sourceByPath.get(pathKey(location.file));
      if (source === undefined) { missingSources += 1; continue; }
      const range = locationRange(source.text, source.starts, location);
      if (range === undefined) { emptyLocations += 1; continue; }
      const text = source.text.slice(range.start, range.end).trim();
      if (text.length === 0) { emptyLocations += 1; continue; }
      seeds.push({
        symbol_usr: symbol.stable_usr,
        file: source.absolute_path,
        chunk_kind: location.kind,
        text,
        start_line: location.start_line,
        start_column: location.start_column,
        end_line: location.end_line,
        end_column: location.end_column,
      });
    }
    const documentation = symbol.documentation === undefined ? undefined : boundedText(symbol.documentation, MAX_SOURCE_BYTES, 'chunk documentation').trim();
    const documentLocation = orderedLocations.find((location) => location.kind === 'definition') ?? orderedLocations[0];
    if (documentation !== undefined && documentation.length > 0 && documentLocation !== undefined) {
      const source = sourceByPath.get(pathKey(documentLocation.file));
      if (source !== undefined) {
        seeds.push({
          symbol_usr: symbol.stable_usr,
          file: source.absolute_path,
          chunk_kind: 'documentation',
          text: `${symbol.qualified_name}\n${documentation}`,
          start_line: null,
          start_column: null,
          end_line: null,
          end_column: null,
        });
      }
    }
  }

  const chunks = seeds.flatMap((seed) => materialize(seed, maxBytes, maxTokens)).sort((left, right) => left.stable_key.localeCompare(right.stable_key, 'en'));
  if (new Set(chunks.map((chunk) => chunk.stable_key)).size !== chunks.length) throw new TypeError('chunk stable identity collision');
  return Object.freeze({
    chunks: Object.freeze(chunks),
    source_location_count: sourceLocations,
    missing_source_location_count: missingSources,
    empty_location_count: emptyLocations,
    split_chunk_count: chunks.filter((chunk) => chunk.part_count > 1).length,
  });
}
