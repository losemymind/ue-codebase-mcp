import assert from 'node:assert/strict';
import test from 'node:test';
import {
  garbageCollectGenerations,
  GenerationPublicationError,
  publishGeneration,
  rollbackGeneration,
  stageGeneration,
  validateGeneration,
} from '../../services/index-coordinator/src/generation-publication.ts';

const projectId = '10000000-0000-4000-8000-000000000001';
const generationA = '20000000-0000-4000-8000-000000000001';
const generationB = '20000000-0000-4000-8000-000000000002';
const generationC = '20000000-0000-4000-8000-000000000003';
const branchA = '30000000-0000-4000-8000-000000000001';
const revisionA = '40000000-0000-4000-8000-000000000001';
const repositoryA = '50000000-0000-4000-8000-000000000001';
const revisionSetHash = '1'.repeat(64);
const manifestHash = '2'.repeat(64);
const gcOperationId = '60000000-0000-4000-8000-000000000001';
const actor = Object.freeze({ type: 'service', id: 'index-coordinator' });
const profile = Object.freeze({ provider: 'approved-provider', model: 'embedding-v1', dimensions: 1536 });

function snapshot(overrides = {}) {
  return {
    revision_count: 1, repository_count: 1, invalid_revision_count: 0,
    file_count: 2, invalid_file_count: 0, invalid_module_count: 0,
    symbol_count: 2, symbol_location_count: 2, invalid_symbol_count: 0,
    symbol_edge_count: 1, invalid_symbol_edge_count: 0,
    file_dependency_count: 1, invalid_file_dependency_count: 0,
    code_chunk_count: 2, invalid_code_chunk_count: 0,
    embedding_count: 2, invalid_embedding_count: 0, unresolved_failure_count: 0,
    ...overrides,
  };
}

function generation(id, status, overrides = {}) {
  const validated = ['ready', 'active', 'superseded'].includes(status);
  return {
    id, project_id: projectId, revision_set_hash: revisionSetHash, status,
    manifest_uri: validated ? 'https://artifacts.example/index.json' : null,
    manifest_hash: validated ? manifestHash : null,
    validation_hash: validated ? '3'.repeat(64) : null,
    validated_at: validated ? '2026-08-31T00:00:00Z' : null,
    symbol_plan_hash: '4'.repeat(64), symbol_payload_hash: '5'.repeat(64),
    symbol_count: 2, symbol_location_count: 2, symbols_imported_at: '2026-08-31T00:00:00Z',
    relation_plan_hash: '6'.repeat(64), relation_payload_hash: '7'.repeat(64),
    symbol_edge_count: 1, file_dependency_count: 1, relations_imported_at: '2026-08-31T00:00:00Z',
    chunk_plan_hash: '8'.repeat(64), chunk_payload_hash: '9'.repeat(64),
    code_chunk_count: 2, chunks_imported_at: '2026-08-31T00:00:00Z',
    embedding_provider: validated ? profile.provider : null,
    embedding_model: validated ? profile.model : null,
    embedding_dimensions: validated ? profile.dimensions : null,
    embedding_count: validated ? 2 : null,
    publication_version: validated ? 1 : 0,
    gc_claim_hash: null,
    gc_claimed_at: null,
    ...overrides,
  };
}

class FakeDatabase {
  constructor(options = {}) {
    this.state = {
      projectStatus: options.projectStatus ?? 'active',
      generations: new Map(options.generations ?? []),
      mappings: new Map(options.mappings ?? []),
      events: [],
      deleted: [],
    };
    this.snapshot = options.snapshot ?? snapshot();
    this.verifiedRevisions = options.verifiedRevisions ?? [{ repository_branch_id: branchA, revision_id: revisionA, repository_id: repositoryA }];
    this.gcCandidates = options.gcCandidates ?? [];
    this.failAt = options.failAt;
    this.shortWriteAt = options.shortWriteAt;
    this.statements = [];
  }

  async transaction(operation) {
    const draft = structuredClone(this.state);
    const execute = async (statement, values) => {
      this.statements.push(statement);
      if (this.failAt === statement.name) throw new Error('private database connection detail');
      const short = this.shortWriteAt === statement.name;
      switch (statement.name) {
        case 'generation-publication-lock-project-v1':
          return { rows: draft.projectStatus === null ? [] : [{ status: draft.projectStatus }], row_count: draft.projectStatus === null ? 0 : 1 };
        case 'generation-publication-validate-revisions-v1':
          return { rows: this.verifiedRevisions, row_count: this.verifiedRevisions.length };
        case 'generation-publication-load-by-hash-v1': {
          const rows = [...draft.generations.values()].filter((item) => item.revision_set_hash === values[1])
            .map(({ id, status, publication_version }) => ({ id, status, publication_version }));
          return { rows, row_count: rows.length };
        }
        case 'generation-publication-insert-staging-v1': {
          const row = generation(generationB, 'building', { revision_set_hash: values[1] });
          draft.generations.set(row.id, row);
          return { rows: short ? [] : [{ id: row.id, status: row.status, publication_version: row.publication_version }], row_count: short ? 0 : 1 };
        }
        case 'generation-publication-insert-revisions-v1': {
          const rows = JSON.parse(values[1]);
          draft.mappings.set(values[0], rows);
          return { rows: [], row_count: short ? rows.length - 1 : rows.length };
        }
        case 'generation-publication-load-revisions-v1': {
          const rows = draft.mappings.get(values[0]) ?? [];
          return { rows, row_count: rows.length };
        }
        case 'generation-publication-lock-generation-v1': {
          const row = draft.generations.get(values[0]);
          const rows = row !== undefined && row.project_id === values[1] ? [{ ...row }] : [];
          return { rows, row_count: rows.length };
        }
        case 'generation-publication-load-validation-snapshot-v1':
          return { rows: [{ ...this.snapshot }], row_count: 1 };
        case 'generation-publication-mark-ready-v1': {
          const row = draft.generations.get(values[0]);
          if (row === undefined || row.status !== 'building' || row.publication_version !== values[9]) return { rows: [], row_count: 0 };
          Object.assign(row, {
            status: 'ready', manifest_uri: values[2], manifest_hash: values[3], validation_hash: values[4],
            validated_at: '2026-08-31T01:00:00Z', embedding_provider: values[5], embedding_model: values[6],
            embedding_dimensions: values[7], embedding_count: values[8], publication_version: row.publication_version + 1,
          });
          return { rows: short ? [] : [{ publication_version: row.publication_version }], row_count: short ? 0 : 1 };
        }
        case 'generation-publication-quarantine-invalid-v1': {
          const row = draft.generations.get(values[0]);
          if (row === undefined || row.status !== 'building' || row.publication_version !== values[2]) return { rows: [], row_count: 0 };
          row.status = 'failed';
          row.publication_version += 1;
          return { rows: short ? [] : [{ publication_version: row.publication_version }], row_count: short ? 0 : 1 };
        }
        case 'generation-publication-load-active-v1': {
          const rows = [...draft.generations.values()].filter((item) => item.project_id === values[0] && item.status === 'active').map((item) => ({ ...item }));
          return { rows, row_count: rows.length };
        }
        case 'generation-publication-supersede-active-v1': {
          const row = draft.generations.get(values[0]);
          if (row === undefined || row.status !== 'active' || row.publication_version !== values[2]) return { rows: [], row_count: 0 };
          row.status = 'superseded';
          row.superseded_at = '2026-08-31T02:00:00Z';
          row.publication_version += 1;
          return { rows: [], row_count: short ? 0 : 1 };
        }
        case 'generation-publication-activate-ready-v1': {
          const row = draft.generations.get(values[0]);
          if (row === undefined || row.status !== 'ready' || row.validation_hash !== values[2] || row.publication_version !== values[3]) return { rows: [], row_count: 0 };
          row.status = 'active';
          row.publication_version += 1;
          return { rows: short ? [] : [{ publication_version: row.publication_version }], row_count: short ? 0 : 1 };
        }
        case 'generation-publication-activate-rollback-v1': {
          const row = draft.generations.get(values[0]);
          if (row === undefined || row.status !== 'superseded' || row.publication_version !== values[2] || row.gc_claimed_at !== null) return { rows: [], row_count: 0 };
          row.status = 'active';
          row.superseded_at = null;
          row.publication_version += 1;
          return { rows: short ? [] : [{ publication_version: row.publication_version }], row_count: short ? 0 : 1 };
        }
        case 'generation-publication-gc-candidates-v1':
          return { rows: this.gcCandidates.map((item) => ({ ...item })), row_count: this.gcCandidates.length };
        case 'generation-publication-gc-claim-v1': {
          const row = draft.generations.get(values[0]);
          if (row === undefined || !['superseded', 'failed'].includes(row.status) || row.publication_version !== values[2]
              || (row.gc_claim_hash !== null && row.gc_claim_hash !== values[3])) return { rows: [], row_count: 0 };
          if (row.gc_claim_hash === null) row.publication_version += 1;
          row.gc_claim_hash = values[3];
          row.gc_claimed_at ??= '2026-08-31T03:00:00Z';
          return { rows: short ? [] : [{ id: row.id, status: row.status, manifest_uri: row.manifest_uri,
            manifest_hash: row.manifest_hash, publication_version: row.publication_version }], row_count: short ? 0 : 1 };
        }
        case 'generation-publication-gc-delete-v1': {
          const row = draft.generations.get(values[0]);
          if (row === undefined || !['superseded', 'failed'].includes(row.status) || row.publication_version !== values[2]
              || row.gc_claim_hash !== values[3]) return { rows: [], row_count: 0 };
          draft.generations.delete(values[0]);
          draft.deleted.push(values[0]);
          return { rows: [], row_count: short ? 0 : 1 };
        }
        case 'generation-publication-insert-event-v1':
          if (!short) draft.events.push({ generation_id: values[1], previous_id: values[2], type: values[3], request_hash: values[6], version: values[7] });
          return { rows: [], row_count: short ? 0 : 1 };
        default:
          throw new Error(`unexpected statement ${statement.name}`);
      }
    };
    const result = await operation({ execute });
    this.state = draft;
    return result;
  }
}

function stageRequest(overrides = {}) {
  return { project_id: projectId, revision_set_hash: revisionSetHash,
    revisions: [{ repository_branch_id: branchA, revision_id: revisionA }], actor, ...overrides };
}

function validateRequest(overrides = {}) {
  return { project_id: projectId, generation_id: generationB, manifest_uri: 'https://artifacts.example/index.json',
    manifest_hash: manifestHash, embedding_profile: profile, actor, ...overrides };
}

test('staging atomically binds one verified revision per repository and resumes exact building state', async () => {
  const database = new FakeDatabase();
  const first = await stageGeneration(database, stageRequest());
  assert.equal(first.generation_id, generationB);
  assert.equal(first.already_staged, false);
  assert.equal(database.state.mappings.get(generationB).length, 1);
  assert.deepEqual(database.state.events.map(({ type }) => type), ['staged']);

  const resumed = await stageGeneration(database, stageRequest());
  assert.equal(resumed.already_staged, true);
  assert.equal(database.state.events.length, 1);
});

test('staging rejects cross-project, duplicate-repository, and changed mappings without partial writes', async () => {
  const duplicateRepository = new FakeDatabase({
    verifiedRevisions: [
      { repository_branch_id: branchA, revision_id: revisionA, repository_id: repositoryA },
      { repository_branch_id: '30000000-0000-4000-8000-000000000002', revision_id: '40000000-0000-4000-8000-000000000002', repository_id: repositoryA },
    ],
  });
  await assert.rejects(stageGeneration(duplicateRepository, stageRequest({ revisions: [
    { repository_branch_id: branchA, revision_id: revisionA },
    { repository_branch_id: '30000000-0000-4000-8000-000000000002', revision_id: '40000000-0000-4000-8000-000000000002' },
  ] })), { code: 'revision-mismatch' });
  assert.equal(duplicateRepository.state.generations.size, 0);

  const changed = new FakeDatabase({
    generations: [[generationB, generation(generationB, 'building')]],
    mappings: [[generationB, [{ repository_branch_id: branchA, revision_id: '40000000-0000-4000-8000-000000000002' }]]],
  });
  await assert.rejects(stageGeneration(changed, stageRequest()), { code: 'generation-conflict' });
});

test('validation binds exact import counts, embedding coverage, manifest, and a deterministic evidence hash', async () => {
  const database = new FakeDatabase({ generations: [[generationB, generation(generationB, 'building')]] });
  const report = await validateGeneration(database, validateRequest());
  assert.match(report.validation_hash, /^[a-f0-9]{64}$/);
  assert.equal(report.publication_version, 1);
  assert.deepEqual(report.counts, {
    revisions: 1, files: 2, symbols: 2, symbol_locations: 2,
    symbol_edges: 1, file_dependencies: 1, code_chunks: 2, embeddings: 2,
  });
  assert.equal(database.state.generations.get(generationB).status, 'ready');
  assert.deepEqual(database.state.events.map(({ type }) => type), ['validated']);

  const replay = await validateGeneration(database, validateRequest());
  assert.equal(replay.already_validated, true);
  assert.equal(replay.validation_hash, report.validation_hash);
  assert.deepEqual(replay.counts, report.counts);
  assert.equal(database.state.events.length, 1);
});

test('validation quarantines incomplete markers, graph bindings, embeddings, and unresolved failures with an audit event', async () => {
  for (const [stateOverride, snapshotOverride, code] of [
    [{ chunks_imported_at: null }, {}, 'generation-incomplete'],
    [{}, { invalid_symbol_edge_count: 1 }, 'generation-incomplete'],
    [{}, { embedding_count: 1 }, 'generation-incomplete'],
    [{}, { unresolved_failure_count: 1 }, 'generation-incomplete'],
  ]) {
    const database = new FakeDatabase({ generations: [[generationB, generation(generationB, 'building', stateOverride)]], snapshot: snapshot(snapshotOverride) });
    await assert.rejects(validateGeneration(database, validateRequest()), { code });
    assert.equal(database.state.generations.get(generationB).status, 'failed');
    assert.deepEqual(database.state.events.map(({ type }) => type), ['validation_failed']);
  }

  const stale = new FakeDatabase({ generations: [[generationB, generation(generationB, 'building', { publication_version: 2 })]] });
  await assert.rejects(validateGeneration(stale, validateRequest()), { code: 'publication-conflict' });
  assert.equal(stale.state.generations.get(generationB).status, 'building');
  assert.equal(stale.state.events.length, 0);
});

test('publication switches active generations and writes its audit event in one transaction', async () => {
  const validationHash = '3'.repeat(64);
  const database = new FakeDatabase({ generations: [
    [generationA, generation(generationA, 'active', { publication_version: 4 })],
    [generationB, generation(generationB, 'ready', { validation_hash: validationHash, publication_version: 1 })],
  ] });
  const report = await publishGeneration(database, {
    project_id: projectId, generation_id: generationB, validation_hash: validationHash,
    expected_publication_version: 1, actor,
  });
  assert.equal(report.previous_active_generation_id, generationA);
  assert.equal(database.state.generations.get(generationA).status, 'superseded');
  assert.equal(database.state.generations.get(generationB).status, 'active');
  assert.deepEqual(database.state.events.map(({ type }) => type), ['published']);

  const replay = await publishGeneration(database, {
    project_id: projectId, generation_id: generationB, validation_hash: validationHash,
    expected_publication_version: 1, actor,
  });
  assert.equal(replay.already_active, true);
  assert.equal(database.state.events.length, 1);
});

test('failed publication rolls back the supersede step and retains the previous active generation', async () => {
  const database = new FakeDatabase({
    generations: [
      [generationA, generation(generationA, 'active', { publication_version: 4 })],
      [generationB, generation(generationB, 'ready', { publication_version: 1 })],
    ],
    failAt: 'generation-publication-activate-ready-v1',
  });
  await assert.rejects(publishGeneration(database, {
    project_id: projectId, generation_id: generationB, validation_hash: '3'.repeat(64),
    expected_publication_version: 1, actor,
  }), (error) => error instanceof GenerationPublicationError && error.code === 'transaction-failed'
    && !error.message.includes('private database connection detail'));
  assert.equal(database.state.generations.get(generationA).status, 'active');
  assert.equal(database.state.generations.get(generationB).status, 'ready');
  assert.equal(database.state.events.length, 0);
});

test('rollback atomically reactivates an exact superseded generation and fences the expected current active', async () => {
  const database = new FakeDatabase({ generations: [
    [generationA, generation(generationA, 'superseded', { publication_version: 5 })],
    [generationB, generation(generationB, 'active', { publication_version: 2 })],
  ] });
  const report = await rollbackGeneration(database, {
    project_id: projectId, target_generation_id: generationA, expected_target_version: 5,
    expected_active_generation_id: generationB, actor,
  });
  assert.equal(report.superseded_generation_id, generationB);
  assert.equal(database.state.generations.get(generationA).status, 'active');
  assert.equal(database.state.generations.get(generationB).status, 'superseded');
  assert.deepEqual(database.state.events.map(({ type }) => type), ['rolled_back']);

  await assert.rejects(rollbackGeneration(new FakeDatabase({ generations: [
    [generationA, generation(generationA, 'superseded', { publication_version: 5 })],
    [generationB, generation(generationB, 'active', { publication_version: 2 })],
  ] }), {
    project_id: projectId, target_generation_id: generationA, expected_target_version: 5,
    expected_active_generation_id: generationC, actor,
  }), { code: 'active-generation-mismatch' });

  await assert.rejects(rollbackGeneration(new FakeDatabase({ generations: [
    [generationA, generation(generationA, 'superseded', {
      publication_version: 5, gc_claim_hash: 'b'.repeat(64), gc_claimed_at: '2026-08-31T03:00:00Z',
    })],
    [generationB, generation(generationB, 'active', { publication_version: 2 })],
  ] }), {
    project_id: projectId, target_generation_id: generationA, expected_target_version: 5,
    expected_active_generation_id: generationB, actor,
  }), { code: 'generation-gc-claimed' });
});

test('GC is dry-run by default and execution deletes only database-selected fenced candidates with durable audit identity', async () => {
  const candidates = [
    { id: generationA, status: 'superseded', manifest_uri: 'https://artifacts.example/index.json', manifest_hash: manifestHash, publication_version: 5 },
    { id: generationC, status: 'failed', manifest_uri: null, manifest_hash: null, publication_version: 0 },
  ];
  const generations = [
    [generationA, generation(generationA, 'superseded', { publication_version: 5 })],
    [generationB, generation(generationB, 'active', { publication_version: 2 })],
    [generationC, generation(generationC, 'failed', { publication_version: 0, validated_at: null })],
  ];
  const preview = new FakeDatabase({ generations, gcCandidates: candidates });
  const planned = await garbageCollectGenerations(preview, { project_id: projectId, actor });
  assert.deepEqual(planned.candidate_generation_ids, [generationA, generationC]);
  assert.deepEqual(planned.deleted_generation_ids, []);
  assert.equal(preview.state.generations.size, 3);
  assert.equal(preview.state.events.length, 0);

  const executing = new FakeDatabase({ generations, gcCandidates: candidates });
  const artifactRequests = [];
  const artifactStore = {
    async deleteManifest(request) {
      artifactRequests.push(request);
      return { receipt_hash: 'a'.repeat(64) };
    },
  };
  const deleted = await garbageCollectGenerations(executing, {
    project_id: projectId, operation_id: gcOperationId, execute: true, actor,
  }, artifactStore);
  assert.deepEqual(deleted.deleted_generation_ids, [generationA, generationC]);
  assert.equal(artifactRequests.length, 1);
  assert.equal(artifactRequests[0].generation_id, generationA);
  assert.match(artifactRequests[0].idempotency_key, /^[a-f0-9]{64}$/);
  assert.ok(executing.state.generations.has(generationB));
  assert.deepEqual(executing.state.events.map(({ generation_id, type }) => ({ generation_id, type })), [
    { generation_id: generationA, type: 'gc_claimed' },
    { generation_id: generationC, type: 'gc_claimed' },
    { generation_id: generationA, type: 'gc_deleted' },
    { generation_id: generationC, type: 'gc_deleted' },
  ]);
});

test('GC SQL retains at least two recent valid generations, waits seven days, and cannot select live states', async () => {
  const database = new FakeDatabase();
  await garbageCollectGenerations(database, { project_id: projectId, actor });
  const statement = database.statements.find(({ name }) => name === 'generation-publication-gc-candidates-v1');
  assert.match(statement.text, /row_number\(\) OVER \(ORDER BY published_at DESC, id DESC\)/);
  assert.match(statement.text, /ranked\.valid_rank > \$3::integer/);
  assert.match(statement.text, /make_interval\(days => \$2::integer\)/);
  assert.match(statement.text, /generation\.status = 'superseded'/);
  assert.match(statement.text, /generation\.status = 'failed'/);
  assert.match(statement.text, /backup\.status = 'running'/);
  assert.match(statement.text, /gc_claim_hash IS NULL OR generation\.gc_claim_hash = decode\(\$5, 'hex'\)/);
  assert.doesNotMatch(statement.text, /generation\.status = 'ready'/);
  assert.doesNotMatch(statement.text, /generation\.status = 'building'/);
  await assert.rejects(garbageCollectGenerations(database, { project_id: projectId, retention_days: 6, actor }), { code: 'invalid-request' });
  await assert.rejects(garbageCollectGenerations(database, { project_id: projectId, retain_recent: 1, actor }), { code: 'invalid-request' });
  await assert.rejects(garbageCollectGenerations(database, { project_id: projectId, execute: true, actor }), { code: 'invalid-request' });
});

test('artifact deletion failure leaves a durable claim and never deletes database rows', async () => {
  const candidate = { id: generationA, status: 'superseded', manifest_uri: 'https://artifacts.example/index.json',
    manifest_hash: manifestHash, publication_version: 5 };
  const database = new FakeDatabase({
    generations: [[generationA, generation(generationA, 'superseded', { publication_version: 5 })]],
    gcCandidates: [candidate],
  });
  await assert.rejects(garbageCollectGenerations(database, {
    project_id: projectId, operation_id: gcOperationId, execute: true, actor,
  }, {
    async deleteManifest() { throw new Error('private object-store detail'); },
  }), (error) => error instanceof GenerationPublicationError && error.code === 'transaction-failed'
    && !error.message.includes('private object-store detail'));
  assert.ok(database.state.generations.has(generationA));
  assert.notEqual(database.state.generations.get(generationA).gc_claim_hash, null);
  assert.deepEqual(database.state.events.map(({ type }) => type), ['gc_claimed']);
});

test('all state transitions use project/generation row locks, fixed statements, and content-safe errors', async () => {
  const database = new FakeDatabase({ failAt: 'generation-publication-lock-project-v1' });
  await assert.rejects(stageGeneration(database, stageRequest()), (error) => {
    assert.ok(error instanceof GenerationPublicationError);
    assert.equal(error.code, 'transaction-failed');
    assert.doesNotMatch(error.message, /private database/);
    return true;
  });
  const texts = new FakeDatabase();
  await stageGeneration(texts, stageRequest());
  assert.ok(texts.statements.every(({ name }) => name.startsWith('generation-publication-')));
  assert.match(texts.statements.find(({ name }) => name === 'generation-publication-lock-project-v1').text, /FOR UPDATE/);
  await assert.rejects(validateGeneration(texts, validateRequest({
    manifest_uri: 'https://artifacts.example/index.json?credential=secret',
  })), { code: 'invalid-request' });
});
