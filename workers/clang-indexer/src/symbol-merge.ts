import { createHash } from 'node:crypto';
import type { CursorIndexResult, CursorSymbol } from './cursor-stream.ts';
import type { ClangSymbolRecord } from './symbol-model.ts';
import { attachUhtAnnotations, type BlueprintExposure, type UhtAnnotation } from './uht-metadata.ts';

export interface IndexedSymbol extends CursorSymbol {
  clang_documentation_id?: string;
  template_parameters: readonly string[];
  uht_specifiers: readonly string[];
  uht_metadata: Readonly<Record<string, string>>;
  blueprint_exposure: BlueprintExposure;
}

export interface SymbolMergeReport {
  symbols: readonly IndexedSymbol[];
  matched_clang_documentation: number;
  unmatched_clang_documentation_ids: readonly string[];
  unmatched_uht_annotations: readonly UhtAnnotation[];
  ambiguous_uht_annotations: readonly UhtAnnotation[];
}

const MAX_MERGE_SYMBOLS = 2_000_000;

function clangDocId(usr: string): string {
  return createHash('sha1').update(usr).digest('hex');
}

function preferredDocumentation(left: string | undefined, right: string | undefined): string | undefined {
  return [left, right].filter((value): value is string => value !== undefined).sort((a, b) => b.length - a.length)[0];
}

export function mergeCursorSymbols(
  cursorIndex: CursorIndexResult,
  clangDocumentation: readonly ClangSymbolRecord[],
  uhtAnnotations: readonly UhtAnnotation[],
): SymbolMergeReport {
  if (cursorIndex.symbols.length > MAX_MERGE_SYMBOLS || clangDocumentation.length > MAX_MERGE_SYMBOLS || uhtAnnotations.length > MAX_MERGE_SYMBOLS) {
    throw new TypeError('symbol merge input exceeds the limit');
  }
  const documentationById = new Map<string, ClangSymbolRecord>();
  for (const record of clangDocumentation) {
    const key = record.clang_symbol_id.toLowerCase();
    if (documentationById.has(key)) throw new TypeError('clang documentation contains a duplicate symbol ID');
    documentationById.set(key, record);
  }
  const uhtReport = attachUhtAnnotations(cursorIndex.symbols.map((symbol) => ({
    stable_usr: symbol.stable_usr,
    qualified_name: symbol.qualified_name,
    kind: symbol.kind,
    locations: symbol.locations.map((location) => ({ kind: location.kind, line: location.start_line })),
  })), uhtAnnotations);
  const uhtByUsr = new Map<string, (typeof uhtReport.metadata)[number]>();
  for (const metadata of uhtReport.metadata) {
    if (uhtByUsr.has(metadata.stable_usr)) throw new TypeError('multiple UHT annotations resolve to one symbol');
    uhtByUsr.set(metadata.stable_usr, metadata);
  }
  const matchedDocumentation = new Set<string>();
  const symbols = cursorIndex.symbols.map((symbol): IndexedSymbol => {
    const id = clangDocId(symbol.stable_usr);
    const clangDoc = documentationById.get(id);
    if (clangDoc !== undefined) {
      if (clangDoc.qualified_name !== symbol.qualified_name || clangDoc.kind !== symbol.kind) throw new TypeError('raw USR and clang documentation disagree');
      matchedDocumentation.add(id);
    }
    const uht = uhtByUsr.get(symbol.stable_usr);
    const documentation = preferredDocumentation(symbol.documentation, clangDoc?.documentation);
    return Object.freeze({
      ...symbol,
      ...(documentation === undefined ? {} : { documentation }),
      ...(clangDoc === undefined ? {} : { clang_documentation_id: clangDoc.clang_symbol_id }),
      template_parameters: Object.freeze([...(clangDoc?.template_parameters ?? [])]),
      uht_specifiers: Object.freeze([...(uht?.uht_specifiers ?? [])]),
      uht_metadata: Object.freeze({ ...(uht?.uht_metadata ?? {}) }),
      blueprint_exposure: uht?.blueprint_exposure ?? 'none',
    });
  });
  const unmatchedDocumentation = [...documentationById.keys()]
    .filter((id) => !matchedDocumentation.has(id))
    .map((id) => documentationById.get(id)!.clang_symbol_id)
    .sort((left, right) => left.localeCompare(right, 'en'));
  return Object.freeze({
    symbols: Object.freeze(symbols),
    matched_clang_documentation: matchedDocumentation.size,
    unmatched_clang_documentation_ids: Object.freeze(unmatchedDocumentation),
    unmatched_uht_annotations: uhtReport.unmatched,
    ambiguous_uht_annotations: uhtReport.ambiguous,
  });
}
