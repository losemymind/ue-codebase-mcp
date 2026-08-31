import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  compareRelationGold,
  parseRelationGoldSuite,
  relationGoldSuitePayloadSha256,
} from '../../workers/clang-indexer/src/relation-gold-comparison.ts';

const workspace = path.resolve('packages/test-fixtures/cpp-relations');
const goldPath = 'packages/test-fixtures/cpp-relations/relation-gold-v1.json';

function relationIndex(suite) {
  return {
    schema_version: 1,
    symbol_edges: suite.symbol_edges.map((edge) => ({
      edge_type: edge.edge_type,
      src_usr: edge.src_usr,
      dst_usr: edge.dst_usr,
      ...(edge.file === null ? {} : { file: path.join(workspace, edge.file), line: edge.line, column: edge.column }),
      confidence: edge.confidence,
    })),
    file_edges: suite.file_edges.map((edge) => ({
      edge_type: 'include',
      src_file: path.join(workspace, edge.src_file),
      dst_file: path.join(workspace, edge.dst_file),
      line: edge.line,
      column: edge.column,
    })),
    source_symbol_edge_records: suite.symbol_edges.length,
    source_file_edge_records: suite.file_edges.length,
    deduplicated_symbol_edges: 0,
    deduplicated_file_edges: 0,
    unresolved_symbol_edges: 0,
    unresolved_owner_edges: 0,
  };
}

test('versioned relation gold closes the native 19.1.5 edge capture at 100 percent', async () => {
  const suite = parseRelationGoldSuite(await readFile(goldPath, 'utf8'));
  const report = compareRelationGold(suite, relationIndex(suite), workspace);
  assert.equal(suite.symbol_edges.length, 36);
  assert.equal(suite.file_edges.length, 2);
  assert.equal(report.expected_edge_count, 38);
  assert.equal(report.actual_edge_count, 38);
  assert.equal(report.matched_edge_count, 38);
  assert.equal(report.precision, 1);
  assert.equal(report.recall, 1);
  assert.equal(report.technical_pass, true);
  assert.equal(report.acceptance_pass, false);
  assert.equal(report.review_status, 'pending');
  assert.equal(report.review_valid, false);
  assert.deepEqual(report.mismatches, []);
});

test('relation gold approval is bound to the exact threshold and expectation payload', async () => {
  const raw = JSON.parse(await readFile(goldPath, 'utf8'));
  const pending = parseRelationGoldSuite(JSON.stringify(raw));
  raw.review = {
    status: 'approved',
    reviewer: 'Named UE Reviewer',
    approved_at: '2026-08-31T00:00:00Z',
    payload_sha256: relationGoldSuitePayloadSha256(pending),
  };
  const suite = parseRelationGoldSuite(JSON.stringify(raw));
  assert.equal(compareRelationGold(suite, relationIndex(suite), workspace).acceptance_pass, true);
  raw.minimum_recall = 0.96;
  const stale = parseRelationGoldSuite(JSON.stringify(raw));
  assert.equal(compareRelationGold(stale, relationIndex(stale), workspace).review_valid, false);
});

test('relation accuracy threshold detects material missing and unexpected edges without leaking identities', async () => {
  const suite = parseRelationGoldSuite(await readFile(goldPath, 'utf8'));
  const actual = relationIndex(suite);
  actual.symbol_edges = actual.symbol_edges.slice(2);
  const missing = compareRelationGold(suite, actual, workspace);
  assert.equal(missing.recall, 36 / 38);
  assert.equal(missing.technical_pass, false);
  assert.deepEqual(missing.mismatches.slice(0, 2), [
    { code: 'missing-edge', expectation_id: 'call-derived-compute-helper' },
    { code: 'missing-edge', expectation_id: 'call-derived-run-helper' },
  ]);

  const privateUsr = 'private:unexpected:stable-identity';
  const unexpected = relationIndex(suite);
  unexpected.symbol_edges.push(
    { ...unexpected.symbol_edges[0], src_usr: privateUsr, line: 100 },
    { ...unexpected.symbol_edges[0], src_usr: privateUsr, line: 101 },
    { ...unexpected.symbol_edges[0], src_usr: privateUsr, line: 102 },
  );
  const extra = compareRelationGold(suite, unexpected, workspace);
  assert.equal(extra.technical_pass, false);
  assert.equal(JSON.stringify(extra).includes(privateUsr), false);

  const drifted = relationIndex(suite);
  drifted.symbol_edges[0] = { ...drifted.symbol_edges[0], confidence: 0.5 };
  const confidence = compareRelationGold(suite, drifted, workspace);
  assert.equal(confidence.precision, 1);
  assert.equal(confidence.recall, 1);
  assert.equal(confidence.technical_pass, false);
  assert.deepEqual(confidence.mismatches, [
    { code: 'field-mismatch', expectation_id: 'call-derived-compute-helper', field: 'confidence' },
  ]);
});

test('relation gold parser rejects extensions, escaped paths, duplicate edges, and incomplete approvals', async () => {
  const raw = JSON.parse(await readFile(goldPath, 'utf8'));
  assert.throws(() => parseRelationGoldSuite(JSON.stringify({ ...raw, extension: true })), /invalid/);
  assert.throws(() => parseRelationGoldSuite(JSON.stringify({ ...raw, minimum_precision: 0.949 })), /invalid/);
  const escaped = structuredClone(raw);
  escaped.file_edges[0].src_file = '../RelationGold.cpp';
  assert.throws(() => parseRelationGoldSuite(JSON.stringify(escaped)), /invalid/);
  const duplicate = structuredClone(raw);
  duplicate.symbol_edges.push(structuredClone(duplicate.symbol_edges[0]));
  duplicate.symbol_edges.at(-1).expectation_id = 'duplicate-edge';
  assert.throws(() => parseRelationGoldSuite(JSON.stringify(duplicate)), /invalid/);
  const approval = structuredClone(raw);
  approval.review = { status: 'approved', reviewer: null, approved_at: null, payload_sha256: null };
  assert.throws(() => parseRelationGoldSuite(JSON.stringify(approval)), /invalid/);
});
