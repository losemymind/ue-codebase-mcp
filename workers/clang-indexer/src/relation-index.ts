import path from 'node:path';
import type { IndexedSymbol } from './symbol-merge.ts';

export type ExtractedSymbolEdgeType = 'calls' | 'references' | 'inherits' | 'overrides';
export type SymbolEdgeType = ExtractedSymbolEdgeType | 'owns';

export interface ExtractedSymbolEdge {
  edge_type: ExtractedSymbolEdgeType;
  src_usr: string;
  dst_usr: string;
  file?: string;
  line?: number;
  column?: number;
  confidence: number;
}

export interface ExtractedFileEdge {
  edge_type: 'include';
  src_file: string;
  dst_file: string;
  line: number;
  column: number;
}

export interface RelationShard {
  schema_version: 1;
  symbol_edges: readonly ExtractedSymbolEdge[];
  file_edges: readonly ExtractedFileEdge[];
}

export interface MergedRelationShards {
  shard: RelationShard;
  source_symbol_edge_records: number;
  source_file_edge_records: number;
  deduplicated_symbol_edges: number;
  deduplicated_file_edges: number;
}

export interface IndexedSymbolEdge {
  edge_type: SymbolEdgeType;
  src_usr: string;
  dst_usr: string;
  file?: string;
  line?: number;
  column?: number;
  confidence: number;
}

export interface IndexedFileEdge extends ExtractedFileEdge {}

export interface RelationIndex {
  schema_version: 1;
  symbol_edges: readonly IndexedSymbolEdge[];
  file_edges: readonly IndexedFileEdge[];
  source_symbol_edge_records: number;
  source_file_edge_records: number;
  deduplicated_symbol_edges: number;
  deduplicated_file_edges: number;
  unresolved_symbol_edges: number;
  unresolved_owner_edges: number;
}

const EXTRACTED_EDGE_TYPES = new Set<ExtractedSymbolEdgeType>(['calls', 'references', 'inherits', 'overrides']);
const MAX_SHARDS = 1_000_000;
const MAX_EDGES = 8_000_000;
const MAX_ROOTS = 64;

function invalid(): never {
  throw new TypeError('relation index input is invalid');
}

function exactKeys(value: object, required: readonly string[], optional: readonly string[] = []): void {
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) invalid();
}

function boundedText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\r\n\0]/.test(value)) invalid();
  return value;
}

function coordinate(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10_000_000) invalid();
  return value as number;
}

function canonicalRoots(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_ROOTS) invalid();
  const roots = values.map((value) => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) invalid();
    return path.resolve(value);
  });
  if (new Set(roots.map((value) => process.platform === 'win32' ? value.toLowerCase() : value)).size !== roots.length) invalid();
  return roots;
}

function confinedFile(value: unknown, roots: readonly string[]): string {
  const file = path.resolve(boundedText(value));
  if (!path.isAbsolute(value as string)) invalid();
  const accepted = roots.some((root) => {
    const relative = path.relative(root, file);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
  if (!accepted) invalid();
  return file;
}

function symbolEdgeKey(edge: ExtractedSymbolEdge): string {
  return JSON.stringify([edge.edge_type, edge.src_usr, edge.dst_usr, edge.file ?? null, edge.line ?? null, edge.column ?? null]);
}

function fileEdgeKey(edge: IndexedFileEdge): string {
  return JSON.stringify([edge.edge_type, edge.src_file, edge.dst_file, edge.line, edge.column]);
}

function compareSymbolEdges(left: ExtractedSymbolEdge, right: ExtractedSymbolEdge): number {
  return left.edge_type.localeCompare(right.edge_type, 'en')
    || left.src_usr.localeCompare(right.src_usr, 'en')
    || left.dst_usr.localeCompare(right.dst_usr, 'en')
    || (left.file ?? '').localeCompare(right.file ?? '', 'en')
    || (left.line ?? 0) - (right.line ?? 0)
    || (left.column ?? 0) - (right.column ?? 0);
}

function compareFileEdges(left: IndexedFileEdge, right: IndexedFileEdge): number {
  return left.src_file.localeCompare(right.src_file, 'en') || left.dst_file.localeCompare(right.dst_file, 'en')
    || left.line - right.line || left.column - right.column;
}

export function buildRelationIndex(
  symbols: readonly IndexedSymbol[],
  shards: readonly RelationShard[],
  workspaceRoots: readonly string[],
): RelationIndex {
  if (!Array.isArray(symbols) || symbols.length > 2_000_000 || !Array.isArray(shards) || shards.length > MAX_SHARDS) invalid();
  const roots = canonicalRoots(workspaceRoots);
  const symbolUsrs = new Set<string>();
  for (const symbol of symbols) {
    const usr = boundedText(symbol.stable_usr);
    if (symbolUsrs.has(usr)) invalid();
    symbolUsrs.add(usr);
  }
  const merged = mergeRelationShards(shards, roots);
  const symbolEdges = new Map<string, IndexedSymbolEdge>();
  let unresolvedSymbolEdges = 0;
  let unresolvedOwnerEdges = 0;
  for (const edge of merged.shard.symbol_edges) {
    if (!symbolUsrs.has(edge.src_usr) || !symbolUsrs.has(edge.dst_usr)) { unresolvedSymbolEdges += 1; continue; }
    symbolEdges.set(symbolEdgeKey(edge), edge);
  }
  for (const symbol of symbols) {
    if (symbol.owner_usr === undefined) continue;
    const ownerUsr = boundedText(symbol.owner_usr);
    if (ownerUsr === symbol.stable_usr) invalid();
    if (!symbolUsrs.has(ownerUsr)) { unresolvedOwnerEdges += 1; continue; }
    const owns: IndexedSymbolEdge = Object.freeze({
      edge_type: 'owns',
      src_usr: ownerUsr,
      dst_usr: symbol.stable_usr,
      confidence: 1,
    });
    symbolEdges.set(symbolEdgeKey(owns), owns);
  }
  return Object.freeze({
    schema_version: 1,
    symbol_edges: Object.freeze([...symbolEdges.values()].sort(compareSymbolEdges)),
    file_edges: merged.shard.file_edges,
    source_symbol_edge_records: merged.source_symbol_edge_records,
    source_file_edge_records: merged.source_file_edge_records,
    deduplicated_symbol_edges: merged.deduplicated_symbol_edges,
    deduplicated_file_edges: merged.deduplicated_file_edges,
    unresolved_symbol_edges: unresolvedSymbolEdges,
    unresolved_owner_edges: unresolvedOwnerEdges,
  });
}

export function mergeRelationShards(
  shards: readonly RelationShard[],
  workspaceRoots: readonly string[],
): MergedRelationShards {
  if (!Array.isArray(shards) || shards.length > MAX_SHARDS) invalid();
  const roots = canonicalRoots(workspaceRoots);
  const symbolEdges = new Map<string, ExtractedSymbolEdge>();
  const fileEdges = new Map<string, ExtractedFileEdge>();
  let sourceSymbolEdges = 0;
  let sourceFileEdges = 0;
  for (const shard of shards) {
    if (typeof shard !== 'object' || shard === null || shard.schema_version !== 1 || !Array.isArray(shard.symbol_edges) || !Array.isArray(shard.file_edges)) invalid();
    exactKeys(shard, ['schema_version', 'symbol_edges', 'file_edges']);
    sourceSymbolEdges += shard.symbol_edges.length;
    sourceFileEdges += shard.file_edges.length;
    if (sourceSymbolEdges > MAX_EDGES || sourceFileEdges > MAX_EDGES) invalid();
    for (const edge of shard.symbol_edges) {
      if (typeof edge !== 'object' || edge === null || !EXTRACTED_EDGE_TYPES.has(edge.edge_type)) invalid();
      exactKeys(edge, ['edge_type', 'src_usr', 'dst_usr', 'confidence'], ['file', 'line', 'column']);
      const srcUsr = boundedText(edge.src_usr);
      const dstUsr = boundedText(edge.dst_usr);
      if ((edge.edge_type === 'inherits' || edge.edge_type === 'overrides') && srcUsr === dstUsr) invalid();
      if (!Number.isFinite(edge.confidence) || edge.confidence < 0 || edge.confidence > 1) invalid();
      const hasLocation = edge.file !== undefined || edge.line !== undefined || edge.column !== undefined;
      if (hasLocation && (edge.file === undefined || edge.line === undefined || edge.column === undefined)) invalid();
      const normalized: ExtractedSymbolEdge = Object.freeze({
        edge_type: edge.edge_type,
        src_usr: srcUsr,
        dst_usr: dstUsr,
        ...(hasLocation ? { file: confinedFile(edge.file, roots), line: coordinate(edge.line), column: coordinate(edge.column) } : {}),
        confidence: edge.confidence,
      });
      const key = symbolEdgeKey(normalized);
      const existing = symbolEdges.get(key);
      if (existing === undefined || normalized.confidence > existing.confidence) symbolEdges.set(key, normalized);
    }
    for (const edge of shard.file_edges) {
      if (typeof edge !== 'object' || edge === null || edge.edge_type !== 'include') invalid();
      exactKeys(edge, ['edge_type', 'src_file', 'dst_file', 'line', 'column']);
      const normalized: ExtractedFileEdge = Object.freeze({
        edge_type: 'include',
        src_file: confinedFile(edge.src_file, roots),
        dst_file: confinedFile(edge.dst_file, roots),
        line: coordinate(edge.line),
        column: coordinate(edge.column),
      });
      if (normalized.src_file === normalized.dst_file) invalid();
      fileEdges.set(fileEdgeKey(normalized), normalized);
    }
  }
  return Object.freeze({
    shard: Object.freeze({
      schema_version: 1,
      symbol_edges: Object.freeze([...symbolEdges.values()].sort(compareSymbolEdges)),
      file_edges: Object.freeze([...fileEdges.values()].sort(compareFileEdges)),
    }),
    source_symbol_edge_records: sourceSymbolEdges,
    source_file_edge_records: sourceFileEdges,
    deduplicated_symbol_edges: sourceSymbolEdges - symbolEdges.size,
    deduplicated_file_edges: sourceFileEdges - fileEdges.size,
  });
}
