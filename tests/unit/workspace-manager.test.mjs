import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ReadOnlyWorkspaceManager,
  WorkspaceError,
  createRevisionSet,
} from '../../services/index-coordinator/src/workspace.ts';

class FakeSvnAdapter {
  head = new Map([['engine', '101'], ['game', '201']]);
  checkoutCalls = [];
  revisions = new Map();
  failRepository;

  async checkout(request) {
    this.checkoutCalls.push({ ...request });
    if (request.url.includes(this.failRepository ?? '<never>')) throw new Error('synthetic interruption');
    await mkdir(request.destination, { recursive: true });
    await writeFile(path.join(request.destination, 'Source.cpp'), `revision ${request.revision}\n`);
    this.revisions.set(request.destination, request.revision);
    return [{ revision: request.revision }];
  }
  async info(request) { return [{ revision: this.revisions.get(request.target) ?? request.revision }]; }
  async status() { return []; }
}

function revisionSet() {
  return createRevisionSet('project-1', [
    { id: 'game-1', role: 'game', url: 'https://svn.example.invalid/game/stable', revision: '200' },
    { id: 'engine-1', role: 'engine', url: 'https://svn.example.invalid/engine/stable', revision: '100' },
  ]);
}

test('revision set hash is deterministic, ordered, and rejects VCS ambiguity', () => {
  const first = revisionSet();
  const second = createRevisionSet('project-1', [...first.repositories].reverse());
  assert.equal(first.hash, second.hash);
  assert.deepEqual(first.repositories.map(({ id }) => id), ['engine-1', 'game-1']);
  assert.throws(() => createRevisionSet('project-1', [{ id: 'git-1', role: 'game', url: 'git://example/repo', revision: '1' }]), WorkspaceError);
  assert.throws(() => createRevisionSet('project-1', [{ id: 'bad', role: 'game', url: 'https://user:password@example/repo', revision: '1' }]), WorkspaceError);
});

test('multi-repository workspace remains pinned when remote HEAD changes and is reusable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ue-mcp-workspace-'));
  try {
    const adapter = new FakeSvnAdapter();
    const manager = new ReadOnlyWorkspaceManager(root, adapter);
    const set = revisionSet();
    const handle = await manager.prepare(set);
    assert.equal(adapter.checkoutCalls.length, 2);
    assert.deepEqual(adapter.checkoutCalls.map(({ revision }) => revision), ['100', '200']);
    adapter.head.set('engine', '999');
    adapter.head.set('game', '999');
    await manager.verify(handle, set);
    const reused = await manager.prepare(set);
    assert.equal(reused.root, handle.root);
    assert.equal(adapter.checkoutCalls.length, 2);
    const manifest = JSON.parse(await readFile(path.join(handle.root, 'workspace.json'), 'utf8'));
    assert.equal(manifest.revision_set_hash, set.hash);
    assert.deepEqual(manifest.repositories.map(({ revision }) => revision), ['100', '200']);
    await manager.remove(set);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('interrupted preparation is cleaned and never publishes a partial workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ue-mcp-workspace-fail-'));
  try {
    const adapter = new FakeSvnAdapter();
    adapter.failRepository = '/game/';
    const manager = new ReadOnlyWorkspaceManager(root, adapter);
    const set = revisionSet();
    await assert.rejects(() => manager.prepare(set), (error) => error instanceof WorkspaceError && error.code === 'WORKSPACE_PREPARE_FAILED');
    await assert.rejects(() => readFile(path.join(root, set.project_id, set.hash, 'workspace.json')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

