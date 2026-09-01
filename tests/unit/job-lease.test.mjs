import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DurableJobLeaseError,
  DurableJobLeaseService,
} from '../../services/index-coordinator/src/job-lease.ts';

const agentUuid = '10000000-0000-4000-8000-000000000001';
const jobId = '20000000-0000-4000-8000-000000000001';
const leaseToken1 = '30000000-0000-4000-8000-000000000001';
const leaseToken2 = '30000000-0000-4000-8000-000000000002';
const agentId = 'agent-01';
const identity = Object.freeze({ agent_id: agentId });

class FakeClock {
  constructor(value = Date.parse('2026-09-01T00:00:00.000Z')) { this.value = value; }
  now() { return new Date(this.value); }
  async sleep(milliseconds) { this.value += milliseconds; }
  advance(milliseconds) { this.value += milliseconds; }
}

function payload(overrides = {}) {
  return {
    schema: 'ue-codebase-mcp/reindex-job', version: 1, kind: 'reindex', project_id: 'project-1',
    revision_set: {
      hash: 'a'.repeat(64),
      repositories: [{ repository_id: 'engine-1', repository_kind: 'svn', branch: 'stable', revision: '75472' }],
    },
    scopes: ['engine'], resource_policy: { timeout_seconds: 3600, max_memory_mb: 4096, max_cpu_percent: 75 },
    ...overrides,
  };
}

function manifest(hash = 'a'.repeat(64)) {
  return {
    schema: 'ue-codebase-mcp/reindex-result', version: 1, generation_id: '40000000-0000-4000-8000-000000000001',
    revision_set_hash: hash, manifest_uri: 'artifact://index-store/generations/40000000-0000-4000-8000-000000000001.json',
    manifest_sha256: 'b'.repeat(64),
  };
}

function registration() {
  return {
    schema: 'ue-codebase-mcp/agent-register', version: 2, agent_id: agentId, agent_version: '0.1.0',
    ue_version: '5.6', vcs: ['svn'], capabilities: ['svn-sync', 'clang-index', 'module-index'],
  };
}

function claimRequest(wait_ms = 0) {
  return { schema: 'ue-codebase-mcp/job-claim', version: 2, agent_id: agentId, supported_kinds: ['reindex'], wait_ms };
}

class FakeDatabase {
  constructor(clock, options = {}) {
    this.clock = clock;
    this.failAt = options.failAt;
    this.statements = [];
    this.nextToken = 0;
    this.state = {
      agent: options.agent ?? null,
      job: {
        id: jobId, status: 'queued', attempt: 0, maxAttempts: 3, availableAt: clock.value,
        payload: options.payload ?? payload(), nextEventSequence: 0, events: new Map(),
        leaseAgentId: null, leaseToken: null, leaseExpiresAt: null, completion: null,
        completionAgentId: null, completionAttempt: null, lastErrorCode: null,
        lastErrorRetryable: null, lastFailureAgentId: null, lastFailureAttempt: null,
        ...options.job,
      },
    };
  }

  async transaction(operation) {
    const draft = structuredClone(this.state);
    const execute = async (statement, values) => {
      this.statements.push(statement);
      if (this.failAt === statement.name) throw new Error('PRIVATE_DATABASE_DETAIL');
      const job = draft.job;
      switch (statement.name) {
        case 'job-lease-register-agent-v2':
          if (['disabled', 'draining'].includes(draft.agent?.status)) return { rows: [], row_count: 0 };
          draft.agent = { id: agentUuid, agentId: values[0], status: 'online', capabilities: JSON.parse(values[2]) };
          return { rows: [{ id: agentUuid, status: 'online', registered_at: new Date(this.clock.value).toISOString() }], row_count: 1 };
        case 'job-lease-recover-expired-v2':
          if (job.status !== 'running' || job.leaseExpiresAt > this.clock.value) return { rows: [], row_count: 0 };
          job.lastErrorCode = 'LEASE_EXPIRED';
          job.lastErrorRetryable = job.attempt < job.maxAttempts;
          job.lastFailureAgentId = job.leaseAgentId;
          job.lastFailureAttempt = job.attempt;
          job.status = job.attempt < job.maxAttempts ? 'queued' : 'failed';
          job.availableAt = this.clock.value + values[0];
          job.leaseAgentId = null; job.leaseToken = null; job.leaseExpiresAt = null;
          return { rows: [{ id: job.id }], row_count: 1 };
        case 'job-lease-select-candidate-v2': {
          const capable = draft.agent?.status === 'online'
            && ['svn-sync', 'clang-index', 'module-index'].every((name) => draft.agent.capabilities[name]);
          if (!capable || job.status !== 'queued' || job.availableAt > this.clock.value || job.payload === null) return { rows: [], row_count: 0 };
          return { rows: [{ job_id: job.id, agent_payload: job.payload, next_event_sequence: job.nextEventSequence }], row_count: 1 };
        }
        case 'job-lease-select-active-v2':
          if (job.status !== 'running' || job.leaseAgentId !== agentUuid || job.leaseExpiresAt <= this.clock.value) return { rows: [], row_count: 0 };
          return { rows: [{ job_id: job.id, agent_payload: job.payload, next_event_sequence: job.nextEventSequence,
            attempt: job.attempt, lease_token: job.leaseToken, lease_expires_at: new Date(job.leaseExpiresAt).toISOString() }], row_count: 1 };
        case 'job-lease-claim-v2': {
          if (job.status !== 'queued') return { rows: [], row_count: 0 };
          job.status = 'running'; job.attempt += 1; job.leaseAgentId = agentUuid;
          job.leaseToken = [leaseToken1, leaseToken2][this.nextToken++] ?? leaseToken2;
          job.leaseExpiresAt = this.clock.value + values[2];
          return { rows: [{ job_id: job.id, agent_payload: job.payload, next_event_sequence: job.nextEventSequence,
            attempt: job.attempt, lease_token: job.leaseToken, lease_expires_at: new Date(job.leaseExpiresAt).toISOString() }], row_count: 1 };
        }
        case 'job-lease-heartbeat-v2':
          if (!this.active(job, values)) return { rows: [], row_count: 0 };
          job.leaseExpiresAt = this.clock.value + values[4];
          return { rows: [{ lease_expires_at: new Date(job.leaseExpiresAt).toISOString() }], row_count: 1 };
        case 'job-lease-append-event-v2':
          if (!this.active(job, values) || job.nextEventSequence !== values[4] || job.events.has(values[4])) return { rows: [], row_count: 0 };
          job.events.set(values[4], { level: values[5], event_type: values[6], redacted_payload: JSON.parse(values[7]) });
          job.nextEventSequence += 1;
          return { rows: [{ next_event_sequence: job.nextEventSequence }], row_count: 1 };
        case 'job-lease-event-state-v2': {
          const event = job.events.get(values[4]);
          return { rows: [{ active: this.active(job, values), next_event_sequence: job.nextEventSequence,
            level: event?.level ?? null, event_type: event?.event_type ?? null,
            redacted_payload: event?.redacted_payload ?? null }], row_count: 1 };
        }
        case 'job-lease-complete-v2':
          if (!this.active(job, values) || job.payload.revision_set.hash !== values[5]) return { rows: [], row_count: 0 };
          job.status = 'succeeded'; job.completion = JSON.parse(values[4]); job.completionAgentId = agentUuid;
          job.completionAttempt = job.attempt; job.leaseAgentId = null; job.leaseToken = null; job.leaseExpiresAt = null;
          return { rows: [{ id: job.id }], row_count: 1 };
        case 'job-lease-completion-state-v2':
          return { rows: [{ status: job.status, agent_id: job.completionAgentId === agentUuid ? agentId : null,
            completion_attempt: job.completionAttempt, completion_manifest: job.completion }], row_count: 1 };
        case 'job-lease-fail-v2':
          if (!this.active(job, values)) return { rows: [], row_count: 0 };
          job.lastErrorCode = values[4]; job.lastErrorRetryable = values[5]; job.lastFailureAgentId = agentUuid;
          job.lastFailureAttempt = job.attempt;
          job.status = values[5] && job.attempt < job.maxAttempts ? 'queued' : 'failed';
          job.availableAt = this.clock.value + values[6];
          job.leaseAgentId = null; job.leaseToken = null; job.leaseExpiresAt = null;
          return { rows: [{ status: job.status }], row_count: 1 };
        case 'job-lease-failure-state-v2':
          return { rows: [{ status: job.status, agent_id: job.lastFailureAgentId === agentUuid ? agentId : null,
            last_failure_attempt: job.lastFailureAttempt, last_error_code: job.lastErrorCode,
            last_error_retryable: job.lastErrorRetryable }], row_count: 1 };
        default:
          throw new Error(`unexpected statement ${statement.name}`);
      }
    };
    const result = await operation({ execute });
    this.state = draft;
    return result;
  }

  active(job, values) {
    return job.status === 'running' && job.id === values[0] && values[1] === agentId
      && job.attempt === values[2] && job.leaseToken === values[3] && job.leaseExpiresAt > this.clock.value;
  }
}

async function serviceFixture(options = {}) {
  const clock = new FakeClock();
  const database = new FakeDatabase(clock, options);
  const service = new DurableJobLeaseService(database, { clock, lease_duration_ms: 10_000, retry_delay_ms: 1_000 });
  await service.register(registration(), identity);
  return { clock, database, service };
}

test('durable claims use a short locked transaction and a random attempt fencing token', async () => {
  const { database, service } = await serviceFixture();
  const claimed = await service.claim(claimRequest(), identity);
  assert.equal(claimed.lease.attempt, 1);
  assert.equal(claimed.lease.lease_token, leaseToken1);
  assert.equal(claimed.payload.revision_set.hash, 'a'.repeat(64));
  const replay = await service.claim(claimRequest(), identity);
  assert.equal(replay.lease.attempt, claimed.lease.attempt);
  assert.equal(replay.lease.lease_token, claimed.lease.lease_token);
  const selection = database.statements.find(({ name }) => name === 'job-lease-select-candidate-v2');
  assert.match(selection.text, /FOR UPDATE OF job SKIP LOCKED LIMIT 1/);
  assert.ok(database.statements.every(({ text }) => !text.includes('project-1') && !text.includes('75472')));
});

test('expired leases recover durably and old attempts and tokens are fenced', async () => {
  const { clock, database, service } = await serviceFixture();
  const first = await service.claim(claimRequest(), identity);
  clock.advance(10_001);
  const second = await service.claim(claimRequest(1_000), identity);
  assert.equal(second.lease.attempt, 2);
  assert.equal(second.lease.lease_token, leaseToken2);
  assert.equal((await service.heartbeat({ ...first.lease, progress_percent: 5, resources: { memory_mb: 1, cpu_percent: 1 } }, identity)).disposition, 'lease_lost');
  assert.equal(database.state.job.status, 'running');
});

test('heartbeats extend only the exact active lease', async () => {
  const { clock, service } = await serviceFixture();
  const claimed = await service.claim(claimRequest(), identity);
  clock.advance(5_000);
  const renewed = await service.heartbeat({ ...claimed.lease, progress_percent: 50, resources: { memory_mb: 512, cpu_percent: 25 } }, identity);
  assert.equal(renewed.accepted, true);
  assert.equal(Date.parse(renewed.lease_expires_at), clock.value + 10_000);
  const wrong = { ...claimed.lease, lease_token: leaseToken2, progress_percent: 50, resources: { memory_mb: 1, cpu_percent: 1 } };
  assert.equal((await service.heartbeat(wrong, identity)).disposition, 'lease_lost');
});

test('job events are monotonic and exact duplicates are idempotent', async () => {
  const { service } = await serviceFixture();
  const claimed = await service.claim(claimRequest(), identity);
  const event = { ...claimed.lease, sequence: 0, level: 'info', event_type: 'index.started', fields: { progress_percent: 1, phase: 'svn' } };
  assert.equal((await service.event(event, identity)).disposition, 'accepted');
  assert.equal((await service.event(event, identity)).disposition, 'already_applied');
  assert.equal((await service.event({ ...event, level: 'error' }, identity)).disposition, 'sequence_conflict');
  assert.equal((await service.event({ ...event, sequence: 2 }, identity)).disposition, 'sequence_conflict');
});

test('completion is revision-bound and exact replay is idempotent', async () => {
  const { database, service } = await serviceFixture();
  const claimed = await service.claim(claimRequest(), identity);
  const wrong = await service.complete({ ...claimed.lease, result: manifest('c'.repeat(64)) }, identity);
  assert.equal(wrong.disposition, 'lease_lost');
  assert.equal(database.state.job.status, 'running');
  const request = { ...claimed.lease, result: manifest() };
  assert.equal((await service.complete(request, identity)).disposition, 'accepted');
  assert.equal((await service.complete(request, identity)).disposition, 'already_applied');
  assert.equal(database.state.job.status, 'succeeded');
});

test('retryable failure is durable and duplicate failure does not consume another attempt', async () => {
  const { database, service } = await serviceFixture();
  const claimed = await service.claim(claimRequest(), identity);
  const failure = { ...claimed.lease, error_code: 'DEPENDENCY_UNAVAILABLE', retryable: true, diagnostic: 'dependency unavailable' };
  assert.equal((await service.fail(failure, identity)).disposition, 'accepted');
  assert.equal((await service.fail(failure, identity)).disposition, 'already_applied');
  assert.equal(database.state.job.status, 'queued');
  assert.equal(database.state.job.attempt, 1);
});

test('invalid stored payload and database failures roll back and expose only stable errors', async () => {
  const malformed = await serviceFixture({ payload: { ...payload(), command: 'PRIVATE_COMMAND' } });
  await assert.rejects(malformed.service.claim(claimRequest(), identity), { code: 'payload-invalid' });
  assert.equal(malformed.database.state.job.status, 'queued');

  const clock = new FakeClock();
  const database = new FakeDatabase(clock, { failAt: 'job-lease-register-agent-v2' });
  const service = new DurableJobLeaseService(database, { clock });
  await assert.rejects(service.register(registration(), identity), (error) => {
    assert.ok(error instanceof DurableJobLeaseError);
    assert.equal(error.code, 'database-failed');
    assert.doesNotMatch(error.message, /PRIVATE/u);
    return true;
  });
});
