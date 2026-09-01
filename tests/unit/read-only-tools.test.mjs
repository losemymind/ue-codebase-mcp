import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseToolArguments,
  READ_ONLY_TOOLS,
  ToolContractError,
} from '../../packages/contracts/src/read-only-tools.ts';

const projectId = '10000000-0000-4000-8000-000000000001';
const repositoryId = '20000000-0000-4000-8000-000000000001';

test('Phase 1 publishes exactly nine closed read-only tools', () => {
  assert.deepEqual(READ_ONLY_TOOLS.map(({ name }) => name), [
    'list_projects', 'index_status', 'search_code', 'read_file_excerpt', 'get_symbol',
    'find_references', 'trace_calls', 'find_derived_types', 'get_module_dependencies',
  ]);
  for (const tool of READ_ONLY_TOOLS) {
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.outputSchema.additionalProperties, false);
    assert.doesNotMatch(tool.name, /write|edit|patch|commit|push|submit|shell|command|build|reindex/u);
    assert.ok(!Object.keys(tool.inputSchema.properties).some((name) => /command|executable|environment|script/u.test(name)));
  }
});

test('tool arguments are normalized with bounded defaults and cursor separation', () => {
  assert.deepEqual(parseToolArguments('search_code', { project_id: projectId, query: 'Actor' }), {
    values: { project_id: projectId, query: 'Actor', limit: 20 }, limit: 20,
  });
  assert.deepEqual(parseToolArguments('trace_calls', { project_id: projectId, symbol: 'AActor::BeginPlay' }), {
    values: { project_id: projectId, symbol: 'AActor::BeginPlay', direction: 'both', max_depth: 3, max_nodes: 100 },
    limit: 100,
  });
});

test('tool contracts reject unknown fields, traversal, duplicates and oversized excerpts', () => {
  const invalid = (tool, input) => assert.throws(() => parseToolArguments(tool, input), ToolContractError);
  invalid('search_code', { project_id: projectId, query: 'Actor', command: 'whoami' });
  invalid('search_code', { project_id: projectId, query: 'Actor', repository_ids: [repositoryId, repositoryId] });
  invalid('read_file_excerpt', {
    project_id: projectId, repository_id: repositoryId, revision: '42', path: '../Secrets.ini', start_line: 1, end_line: 2,
  });
  invalid('read_file_excerpt', {
    project_id: projectId, repository_id: repositoryId, revision: '42', path: 'Source/A.cpp', start_line: 1, end_line: 501,
  });
  invalid('trace_calls', { project_id: projectId, symbol: 'A', max_depth: 9 });
});
