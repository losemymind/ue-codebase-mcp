import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { rankHybridCandidates } from '../../services/retrieval/src/hybrid-ranking.ts';
import {
  compareRetrievalGold,
  parseRetrievalGoldSuite,
  retrievalGoldSuitePayloadSha256,
} from '../../services/retrieval/src/retrieval-gold.ts';

const fixturePath = 'packages/test-fixtures/retrieval/retrieval-gold-v1.json';

async function suite() {
  return parseRetrievalGoldSuite(await readFile(fixturePath, 'utf8'));
}

test('versioned bilingual retrieval gold reaches Recall@20 1.0 but remains pending review', async () => {
  const gold = await suite();
  const results = gold.cases.map((item) => ({
    case_id: item.case_id,
    chunk_keys: rankHybridCandidates({
      [item.case_id.includes('exact') ? 'exact' : item.case_id.includes('call') ? 'graph' : 'vector']: [
        { chunk_key: item.relevant_chunk_keys[0], symbol_key: 'expected-symbol', file_key: 'expected-file', score: 1 },
        { chunk_key: 'f'.repeat(64), symbol_key: 'distractor-symbol', file_key: 'distractor-file', score: 0.1 },
      ],
    }).map(({ chunk_key }) => chunk_key),
  }));
  const report = compareRetrievalGold(gold, results);
  assert.equal(report.case_count, 6);
  assert.equal(report.english_case_count, 3);
  assert.equal(report.chinese_case_count, 3);
  assert.equal(report.recall_at_20, 1);
  assert.equal(report.english_recall_at_20, 1);
  assert.equal(report.chinese_recall_at_20, 1);
  assert.equal(report.technical_pass, true);
  assert.equal(report.review_valid, false);
  assert.equal(report.acceptance_pass, false);
  assert.match(report.suite_payload_sha256, /^[a-f0-9]{64}$/);
});

test('retrieval gold approval is bound to the exact bilingual expectation payload', async () => {
  const pending = await suite();
  const payloadHash = retrievalGoldSuitePayloadSha256(pending);
  const approvedJson = JSON.stringify({
    ...pending,
    review: { status: 'approved', reviewer: 'retrieval-reviewer', approved_at: '2026-08-31T00:00:00Z', payload_sha256: payloadHash },
  });
  const approved = parseRetrievalGoldSuite(approvedJson);
  const results = approved.cases.map((item) => ({ case_id: item.case_id, chunk_keys: item.relevant_chunk_keys }));
  assert.equal(compareRetrievalGold(approved, results).acceptance_pass, true);
  const drifted = parseRetrievalGoldSuite(JSON.stringify({ ...JSON.parse(approvedJson), minimum_recall_at_20: 0.91 }));
  assert.equal(compareRetrievalGold(drifted, results).review_valid, false);
});

test('Recall@20 fails when either language degrades and diagnostics expose no query or chunk key', async () => {
  const gold = await suite();
  const results = gold.cases.map((item) => ({
    case_id: item.case_id,
    chunk_keys: item.language === 'zh' ? [] : item.relevant_chunk_keys,
  }));
  const report = compareRetrievalGold(gold, results);
  assert.equal(report.english_recall_at_20, 1);
  assert.equal(report.chinese_recall_at_20, 0);
  assert.equal(report.technical_pass, false);
  assert.equal(report.mismatch_count, 3);
  const safe = JSON.stringify(report.mismatches);
  assert.doesNotMatch(safe, /谁调用|说明在哪里|111111|222222|333333/);
});

test('retrieval gold parser and result boundary reject extensions, duplicates, weak thresholds, and unknown cases', async () => {
  const raw = JSON.parse(await readFile(fixturePath, 'utf8'));
  for (const invalid of [
    { ...raw, unexpected: true },
    { ...raw, minimum_recall_at_20: 0.89 },
    { ...raw, cases: [raw.cases[0], raw.cases[0], ...raw.cases.slice(2)] },
    { ...raw, cases: raw.cases.map((item) => ({ ...item, unexpected: true })) },
    { ...raw, review: { status: 'approved', reviewer: null, approved_at: null, payload_sha256: null } },
  ]) assert.throws(() => parseRetrievalGoldSuite(JSON.stringify(invalid)), /retrieval gold suite is invalid/);
  const gold = await suite();
  assert.throws(() => compareRetrievalGold(gold, [{ case_id: 'unknown', chunk_keys: [] }]), /unknown case/);
  assert.throws(() => compareRetrievalGold(gold, [{ case_id: gold.cases[0].case_id, chunk_keys: ['a'.repeat(64), 'a'.repeat(64)] }]), /results are invalid/);
});
