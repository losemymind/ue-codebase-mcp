import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { embedCodeChunks, EmbeddingPipelineError } from '../../packages/provider-sdk/src/index.ts';

const projectId = '10000000-0000-4000-8000-000000000001';

function provider(overrides = {}) {
  return {
    schema: 'ue-codebase-mcp/provider',
    version: 1,
    id: 'approved-provider',
    kind: 'openai-compatible',
    endpoint: 'https://provider.example.invalid/v1',
    allowed_hosts: ['provider.example.invalid'],
    credential: { secret_ref: 'secret://provider/credential' },
    embedding: { model: 'embedding-model', dimensions: 3 },
    data_processing_approved: true,
    enabled: true,
    ...overrides,
  };
}

function input(key, text) {
  return {
    chunk_key: key,
    content_hash: createHash('sha256').update(text).digest('hex'),
    text,
    token_count: text.split(/\s+/u).length,
  };
}

class MemoryCache {
  values = new Map();
  async get(key) { return this.values.get(key.cache_key); }
  async set(key, value) { this.values.set(key.cache_key, value); }
}

function executor(requests) {
  return async (request) => {
    requests.push(request);
    return { embeddings: request.inputs.map(({ content_hash }, index) => ({ content_hash, embedding: [index, 1, 2] })) };
  };
}

test('content hashes deduplicate provider inputs and completed results are served from cache', async () => {
  const cache = new MemoryCache();
  const requests = [];
  const inputs = [input('chunk-a', 'same text'), input('chunk-b', 'same text'), input('chunk-c', 'other text')];
  const first = await embedCodeChunks(provider(), projectId, inputs, cache, executor(requests), { max_batch_items: 1 });
  assert.equal(first.unique_content_count, 2);
  assert.equal(first.provider_input_count, 2);
  assert.equal(first.provider_batch_count, 2);
  assert.equal(requests.length, 2);
  assert.deepEqual(first.vectors.map(({ chunk_key }) => chunk_key), ['chunk-a', 'chunk-b', 'chunk-c']);
  assert.deepEqual(first.vectors[0].embedding, first.vectors[1].embedding);

  const secondRequests = [];
  const second = await embedCodeChunks(provider(), projectId, inputs, cache, executor(secondRequests));
  assert.equal(second.cache_hit_count, 2);
  assert.equal(second.provider_input_count, 0);
  assert.equal(second.provider_attempt_count, 0);
  assert.equal(secondRequests.length, 0);
  assert.ok(second.vectors.every(({ cached }) => cached));
});

test('transient retries reuse one deterministic idempotency key', async () => {
  const keys = [];
  const delays = [];
  let attempts = 0;
  const report = await embedCodeChunks(provider(), projectId, [input('chunk-a', 'retry text')], new MemoryCache(), async (request) => {
    attempts += 1;
    keys.push(request.idempotency_key);
    if (attempts === 1) throw new Error('private transient detail');
    return { embeddings: [{ content_hash: request.inputs[0].content_hash, embedding: [0, 1, 2] }] };
  }, {
    is_transient_error: () => true,
    retry_delay: async (attempt) => { delays.push(attempt); },
  });
  assert.equal(report.provider_attempt_count, 2);
  assert.deepEqual(delays, [1]);
  assert.equal(new Set(keys).size, 1);
  assert.match(keys[0], /^[a-f0-9]{64}$/);
});

test('provider approval, response dimensions, and the circuit breaker fail closed', async () => {
  await assert.rejects(
    embedCodeChunks(provider({ enabled: false }), projectId, [], new MemoryCache(), async () => ({ embeddings: [] })),
    (error) => error instanceof EmbeddingPipelineError && error.code === 'provider-disabled',
  );
  await assert.rejects(
    embedCodeChunks(provider({ data_processing_approved: false }), projectId, [], new MemoryCache(), async () => ({ embeddings: [] })),
    (error) => error instanceof EmbeddingPipelineError && error.code === 'provider-approval-required',
  );
  await assert.rejects(
    embedCodeChunks(provider(), projectId, [input('chunk-a', 'bad dimensions')], new MemoryCache(), async (request) => ({ embeddings: [{ content_hash: request.inputs[0].content_hash, embedding: [1] }] })),
    (error) => error instanceof EmbeddingPipelineError && error.code === 'invalid-provider-response',
  );
  await assert.rejects(
    embedCodeChunks(provider(), projectId, [input('chunk-a', 'breaker')], new MemoryCache(), async () => { throw new Error('private detail'); }, {
      max_attempts: 3,
      circuit_breaker_failures: 2,
      is_transient_error: () => true,
    }),
    (error) => error instanceof EmbeddingPipelineError && error.code === 'circuit-open' && !error.message.includes('private detail'),
  );
});

test('batch budgets and content integrity are enforced before provider execution', async () => {
  let calls = 0;
  await assert.rejects(
    embedCodeChunks(provider(), projectId, [{ ...input('chunk-a', 'text'), content_hash: '0'.repeat(64) }], new MemoryCache(), async () => { calls += 1; return { embeddings: [] }; }),
    (error) => error instanceof EmbeddingPipelineError && error.code === 'invalid-input',
  );
  await assert.rejects(
    embedCodeChunks(provider(), projectId, [input('chunk-b', 'too many tokens')], new MemoryCache(), async () => { calls += 1; return { embeddings: [] }; }, { max_batch_tokens: 1 }),
    (error) => error instanceof EmbeddingPipelineError && error.code === 'invalid-input',
  );
  assert.equal(calls, 0);
});

test('cache and retry-policy adapter failures are reduced to safe pipeline errors', async () => {
  await assert.rejects(
    embedCodeChunks(provider(), projectId, [input('chunk-a', 'cache failure')], {
      async get() { throw new Error('private cache detail'); },
      async set() {},
    }, executor([])),
    (error) => error instanceof EmbeddingPipelineError && error.code === 'cache-failed' && !error.message.includes('private cache detail'),
  );
  await assert.rejects(
    embedCodeChunks(provider(), projectId, [input('chunk-b', 'policy failure')], new MemoryCache(), async () => { throw new Error('private provider detail'); }, {
      is_transient_error: () => { throw new Error('private policy detail'); },
    }),
    (error) => error instanceof EmbeddingPipelineError && error.code === 'provider-failed' && !error.message.includes('private'),
  );
});
