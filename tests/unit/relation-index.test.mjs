import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { buildRelationIndex } from '../../workers/clang-indexer/src/relation-index.ts';

const workspace = path.resolve('packages/test-fixtures/cpp-symbols');
const header = path.join(workspace, 'SymbolGold.h');
const source = path.join(workspace, 'SymbolGold.cpp');

function symbol(stableUsr, kind, ownerUsr) {
  const name = stableUsr.split('@').at(-1).replace(/[^A-Za-z0-9_]/g, '') || 'Symbol';
  return {
    stable_usr: stableUsr,
    qualified_name: `Relations::${name}`,
    name,
    display_name: name,
    kind,
    ...(ownerUsr === undefined ? {} : { owner_usr: ownerUsr }),
    type_spelling: '',
    result_type: '',
    signature_hash: 'a'.repeat(64),
    locations: [{ kind: 'definition', file: header, start_line: 1, start_column: 1, end_line: 1, end_column: 2 }],
    template_parameters: [],
    uht_specifiers: [],
    uht_metadata: {},
    blueprint_exposure: 'none',
  };
}

function corpus() {
  const namespace = 'c:@N@Relations';
  const base = `${namespace}@S@Base`;
  const derived = `${namespace}@S@Derived`;
  const baseMethod = `${base}@F@Compute#I#1`;
  const derivedMethod = `${derived}@F@Compute#I#1`;
  const helper = `${namespace}@F@Helper#I#`;
  const field = `${base}@FI@State`;
  const symbols = [
    symbol(namespace, 'namespace'),
    symbol(base, 'struct', namespace),
    symbol(derived, 'struct', namespace),
    symbol(baseMethod, 'method', base),
    symbol(derivedMethod, 'method', derived),
    symbol(helper, 'function', namespace),
    symbol(field, 'field', base),
    symbol('c:@S@ExternalChild', 'struct', 'c:@N@MissingOwner'),
  ];
  return { symbols, namespace, base, derived, baseMethod, derivedMethod, helper, field };
}

test('relation index derives ownership and deterministically deduplicates cross-TU semantic edges', () => {
  const values = corpus();
  const call = { edge_type: 'calls', src_usr: values.derivedMethod, dst_usr: values.baseMethod, file: source, line: 7, column: 10, confidence: 0.8 };
  const shards = [
    {
      schema_version: 1,
      symbol_edges: [
        call,
        { edge_type: 'references', src_usr: values.baseMethod, dst_usr: values.field, file: source, line: 3, column: 20, confidence: 1 },
        { edge_type: 'inherits', src_usr: values.derived, dst_usr: values.base, file: header, line: 18, column: 18, confidence: 1 },
      ],
      file_edges: [{ edge_type: 'include', src_file: source, dst_file: header, line: 1, column: 1 }],
    },
    {
      schema_version: 1,
      symbol_edges: [
        { ...call, confidence: 1 },
        { edge_type: 'overrides', src_usr: values.derivedMethod, dst_usr: values.baseMethod, file: header, line: 20, column: 3, confidence: 1 },
        { edge_type: 'calls', src_usr: values.derivedMethod, dst_usr: 'c:@F@NotIndexed#', file: source, line: 8, column: 3, confidence: 1 },
      ],
      file_edges: [{ edge_type: 'include', src_file: source, dst_file: header, line: 1, column: 1 }],
    },
  ];
  const report = buildRelationIndex(values.symbols, shards, [workspace]);
  assert.equal(report.source_symbol_edge_records, 6);
  assert.equal(report.source_file_edge_records, 2);
  assert.equal(report.deduplicated_symbol_edges, 1);
  assert.equal(report.deduplicated_file_edges, 1);
  assert.equal(report.unresolved_symbol_edges, 1);
  assert.equal(report.unresolved_owner_edges, 1);
  assert.equal(report.symbol_edges.length, 10);
  assert.equal(report.file_edges.length, 1);
  assert.equal(report.symbol_edges.find((edge) => edge.edge_type === 'calls').confidence, 1);
  assert.equal(report.symbol_edges.filter((edge) => edge.edge_type === 'owns').length, 6);
  assert.deepEqual(report.file_edges[0], { edge_type: 'include', src_file: source, dst_file: header, line: 1, column: 1 });
  assert.equal(JSON.stringify(report).includes('NotIndexed'), false);
  assert.equal(JSON.stringify(report).includes('MissingOwner'), false);
});

test('relation index output is input-order independent', () => {
  const values = corpus();
  const edges = [
    { edge_type: 'calls', src_usr: values.derivedMethod, dst_usr: values.baseMethod, confidence: 1 },
    { edge_type: 'inherits', src_usr: values.derived, dst_usr: values.base, file: header, line: 18, column: 18, confidence: 1 },
  ];
  const left = buildRelationIndex(values.symbols, [{ schema_version: 1, symbol_edges: edges, file_edges: [] }], [workspace]);
  const right = buildRelationIndex([...values.symbols].reverse(), [{ schema_version: 1, symbol_edges: [...edges].reverse(), file_edges: [] }], [workspace]);
  assert.deepEqual(left, right);
});

test('relation index fails closed on unknown types, extensions, partial locations, and path escape', () => {
  const values = corpus();
  const base = { schema_version: 1, symbol_edges: [], file_edges: [] };
  assert.throws(() => buildRelationIndex(values.symbols, [{ ...base, extension: true }], [workspace]), /invalid/);
  assert.throws(() => buildRelationIndex(values.symbols, [{ ...base, symbol_edges: [{ edge_type: 'instantiates', src_usr: values.derived, dst_usr: values.base, confidence: 1 }] }], [workspace]), /invalid/);
  assert.throws(() => buildRelationIndex(values.symbols, [{ ...base, symbol_edges: [{ edge_type: 'inherits', src_usr: values.derived, dst_usr: values.base, file: header, confidence: 1 }] }], [workspace]), /invalid/);
  assert.throws(() => buildRelationIndex(values.symbols, [{ ...base, symbol_edges: [{ edge_type: 'inherits', src_usr: values.derived, dst_usr: values.base, file: path.resolve('outside.h'), line: 1, column: 1, confidence: 1 }] }], [workspace]), /invalid/);
  assert.throws(() => buildRelationIndex(values.symbols, [{ ...base, file_edges: [{ edge_type: 'include', src_file: source, dst_file: source, line: 1, column: 1 }] }], [workspace]), /invalid/);
});

test('relation index rejects duplicate or self-owned symbol identities', () => {
  const values = corpus();
  assert.throws(() => buildRelationIndex([...values.symbols, values.symbols[0]], [], [workspace]), /invalid/);
  const selfOwned = symbol('c:@S@Self', 'struct', 'c:@S@Self');
  assert.throws(() => buildRelationIndex([selfOwned], [], [workspace]), /invalid/);
});
