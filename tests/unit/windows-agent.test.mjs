import assert from 'node:assert/strict';
import test from 'node:test';
import { WindowsAgent } from '../../workers/windows-agent/src/agent.ts';
import { LeaseCoordinator } from '../../workers/windows-agent/src/coordinator.ts';
import {
  AgentContractError,
  assertCredential,
  validateAgentConfig,
  validateCompletionManifest,
  validateJobPayload,
} from '../../workers/windows-agent/src/contracts.ts';

class FakeClock {
  constructor(value = Date.parse('2026-08-28T00:00:00.000Z')) { this.value = value; }
  now() { return new Date(this.value); }
  advance(milliseconds) { this.value += milliseconds; }
  async sleep(milliseconds) { this.advance(milliseconds); }
}

const token = 'short-lived-agent-token-value';
const auth = { token };
const credentialProvider = { resolve: async () => ({ token, expires_at: '2099-01-01T00:00:00.000Z' }) };

function config() {
  return validateAgentConfig({
    schema: 'ue-codebase-mcp/windows-agent', version: 1,
    agent_id: 'agent-01', agent_version: '0.1.0',
    coordinator_endpoint: 'https://coordinator.example.invalid/internal/',
    credential: { secret_ref: 'secret://corp-vault/agents/agent-01' },
    capabilities: ['svn-sync', 'clang-index', 'module-index'],
    claim_wait_ms: 0, idle_delay_ms: 10, heartbeat_interval_ms: 1_000,
  });
}

function payload() {
  return {
    schema: 'ue-codebase-mcp/reindex-job', version: 1, kind: 'reindex', project_id: 'project-1',
    revision_set: {
      hash: 'a'.repeat(64),
      repositories: [{ repository_id: 'engine-1', repository_kind: 'svn', branch: 'stable', revision: '75472' }],
    },
    scopes: ['engine'],
    resource_policy: { timeout_seconds: 3600, max_memory_mb: 4096, max_cpu_percent: 75 },
  };
}

function manifest(hash = 'a'.repeat(64)) {
  return {
    schema: 'ue-codebase-mcp/reindex-result', version: 1,
    generation_id: '40000000-0000-4000-8000-000000000001', revision_set_hash: hash,
    manifest_uri: 'artifact://index-store/generations/40000000-0000-4000-8000-000000000001.json', manifest_sha256: 'b'.repeat(64),
  };
}

async function register(coordinator, agentId = 'agent-01') {
  await coordinator.register({
    schema: 'ue-codebase-mcp/agent-register', version: 2, agent_id: agentId,
    agent_version: '0.1.0', ue_version: '5.6', vcs: ['svn'],
    capabilities: ['svn-sync', 'clang-index', 'module-index'],
  }, auth);
}

test('job contracts reject arbitrary commands, arguments, environment, and unpinned VCS input', () => {
  assert.equal(validateJobPayload(payload()).revision_set.repositories[0].revision, '75472');
  for (const field of ['command', 'args', 'environment', 'working_directory', 'output_path']) {
    assert.throws(() => validateJobPayload({ ...payload(), [field]: 'injected' }), (error) => error instanceof AgentContractError && error.code === 'AGENT_CONTRACT_UNKNOWN_FIELD');
  }
  assert.throws(() => validateJobPayload({ ...payload(), revision_set: { ...payload().revision_set, repositories: [{ ...payload().revision_set.repositories[0], repository_kind: 'git' }] } }), AgentContractError);
  assert.throws(() => assertCredential({ token: `${token}\r\nInjected: true`, expires_at: '2099-01-01T00:00:00.000Z' }, new Date()), AgentContractError);
  assert.throws(() => validateCompletionManifest({ ...manifest(), manifest_uri: 'artifact://index-store/../private.json' }), AgentContractError);
});

test('expired leases are recovered, old attempts are fenced, and completion is idempotent', async () => {
  const clock = new FakeClock();
  const coordinator = new LeaseCoordinator({ clock, lease_duration_ms: 1_000 });
  await register(coordinator);
  const jobId = coordinator.enqueue(payload());
  const first = await coordinator.claim({ schema: 'ue-codebase-mcp/job-claim', version: 2, agent_id: 'agent-01', supported_kinds: ['reindex'], wait_ms: 0 }, auth);
  assert.equal(first.lease.attempt, 1);
  clock.advance(1_001);
  assert.equal(coordinator.recoverExpiredLeases(), 1);
  const second = await coordinator.claim({ schema: 'ue-codebase-mcp/job-claim', version: 2, agent_id: 'agent-01', supported_kinds: ['reindex'], wait_ms: 0 }, auth);
  assert.equal(second.lease.attempt, 2);
  assert.equal((await coordinator.heartbeat({ ...first.lease, progress_percent: 10, resources: { memory_mb: 1, cpu_percent: 1 } }, auth)).disposition, 'lease_lost');
  const request = { ...second.lease, result: manifest() };
  assert.deepEqual(await coordinator.complete(request, auth), { accepted: true, disposition: 'accepted' });
  assert.deepEqual(await coordinator.complete(request, auth), { accepted: true, disposition: 'already_applied' });
  assert.equal(coordinator.snapshot(jobId).status, 'succeeded');
});

test('Windows Agent executes a typed job with heartbeat/events and publishes the pinned manifest', async () => {
  const clock = new FakeClock();
  const coordinator = new LeaseCoordinator({ clock, lease_duration_ms: 10_000 });
  coordinator.enqueue(payload());
  let handled = 0;
  const agent = new WindowsAgent({
    config: config(), transport: coordinator, credentials: credentialProvider, clock,
    handlers: { reindex: async (job, context) => {
      handled += 1;
      await context.event({ level: 'info', event_type: 'index.started', fields: { phase: 'svn', progress_percent: 5 } });
      await context.heartbeat(50, { memory_mb: 512, cpu_percent: 25 });
      return manifest(job.revision_set.hash);
    } },
  });
  assert.equal(await agent.runOnce(), 'completed');
  assert.equal(handled, 1);
});

test('failed handlers are classified without returning raw diagnostics and retry safely', async () => {
  const clock = new FakeClock();
  const coordinator = new LeaseCoordinator({ clock, lease_duration_ms: 10_000, retry_delay_ms: 0 });
  const jobId = coordinator.enqueue(payload(), { max_attempts: 2 });
  const agent = new WindowsAgent({
    config: config(), transport: coordinator, credentials: credentialProvider, clock,
    handlers: { reindex: async () => { throw new Error('PRIVATE_SOURCE_CANARY'); } },
  });
  assert.equal(await agent.runOnce(), 'failed');
  assert.equal(coordinator.snapshot(jobId).status, 'queued');
  assert.equal(await agent.runOnce(), 'failed');
  assert.equal(coordinator.snapshot(jobId).status, 'failed');
});

test('independent heartbeat watchdog aborts cooperative work when its lease is lost', async () => {
  const clock = new FakeClock();
  let heartbeatCount = 0;
  let observedAbort = false;
  const lease = {
    job_id: '20000000-0000-4000-8000-000000000001', agent_id: 'agent-01', attempt: 1,
    lease_token: '30000000-0000-4000-8000-000000000001', lease_expires_at: '2026-08-28T00:01:00.000Z',
  };
  const transport = {
    async register() { return { accepted: true, registered_at: clock.now().toISOString() }; },
    async claim() { return { lease, payload: payload(), next_event_sequence: 0 }; },
    async heartbeat() {
      heartbeatCount += 1;
      return heartbeatCount === 1
        ? { accepted: true, disposition: 'accepted', lease_expires_at: new Date(clock.value + 10_000).toISOString() }
        : { accepted: false, disposition: 'lease_lost' };
    },
    async event() { throw new Error('event not expected'); },
    async complete() { throw new Error('completion not expected'); },
    async fail() { throw new Error('failure must not be reported after lease loss'); },
  };
  const agent = new WindowsAgent({
    config: config(), transport, credentials: credentialProvider, clock,
    handlers: { reindex: async (job, context) => new Promise((resolve) => {
      context.signal.addEventListener('abort', () => {
        observedAbort = true;
        resolve(manifest(job.revision_set.hash));
      }, { once: true });
    }) },
  });
  assert.equal(await agent.runOnce(), 'lease_lost');
  assert.equal(observedAbort, true);
  assert.equal(heartbeatCount, 2);
});
