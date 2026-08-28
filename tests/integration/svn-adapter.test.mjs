import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SvnAdapter, parseSvnXml, svnRevision } from '../../workers/svn-adapter/src/index.ts';
import {
  commitSyntheticHeadChange,
  createSyntheticRepository,
} from '../../workers/svn-adapter/test-support/synthetic-repository.ts';

const svnPath = 'C:\\Program Files\\TortoiseSVN\\bin\\svn.exe';
const svnAdminPath = 'C:\\Program Files\\TortoiseSVN\\bin\\svnadmin.exe';

test('strict SVN XML parser rejects DTD/entity expansion and malformed documents', () => {
  assert.throws(() => parseSvnXml('<!DOCTYPE x [<!ENTITY e "secret">]><info>&e;</info>'), /DTD_FORBIDDEN/);
  assert.throws(() => parseSvnXml('<info><entry></info>'), /MISMATCHED_TAG/);
  assert.throws(() => parseSvnXml('<info>&unknown;</info>'), /UNKNOWN_ENTITY/);
  assert.equal(parseSvnXml('<?xml version="1.0"?><info></info>').name, 'info');
});

test('typed invocation never accepts arbitrary executable, credentials, or command arguments', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ue-mcp-svn-args-'));
  try {
    const workspaceRoot = path.join(root, 'workspaces');
    await mkdir(workspaceRoot);
    const invocations = [];
    const adapter = new SvnAdapter({
      executablePath: svnPath,
      workspaceRoot,
      allowedRepositoryRoots: ['https://svn.example.invalid/repos/yihuan'],
      credentialRef: 'secret://corp-vault/svn/readonly',
      executor: async (invocation) => {
        invocations.push(invocation);
        return { exitCode: 0, stderr: '', stdout: '<?xml version="1.0"?><info><entry kind="dir" path="x" revision="42"><url>https://svn.example.invalid/repos/yihuan/trunk</url><repository><root>https://svn.example.invalid/repos/yihuan</root><uuid>00000000-0000-0000-0000-000000000000</uuid></repository></entry></info>' };
      },
    });
    await adapter.info({ target: 'https://svn.example.invalid/repos/yihuan/trunk', revision: svnRevision(42) });
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].executablePath, svnPath);
    assert.deepEqual(invocations[0].args.slice(0, 4), ['info', '--xml', '--non-interactive', '--depth']);
    assert.doesNotMatch(JSON.stringify(invocations), /corp-vault|password|username|--config-option/);
    assert.throws(() => new SvnAdapter({ executablePath: 'cmd.exe', workspaceRoot, allowedRepositoryRoots: ['https://svn.example.invalid/repos/yihuan'] }));
    await assert.rejects(() => adapter.info({ target: 'https://attacker.invalid/repo', revision: svnRevision(1) }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real synthetic SVN repository stays revision-pinned while HEAD changes', { timeout: 60_000 }, async (t) => {
  try {
    await Promise.all([access(svnPath), access(svnAdminPath)]);
  } catch {
    t.skip('TortoiseSVN command-line tools are unavailable');
    return;
  }
  const testRoot = path.join(process.cwd(), 'database', '.test-data');
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(path.join(testRoot, 'svn-live-'));
  try {
    const synthetic = await createSyntheticRepository(root, svnPath, svnAdminPath);
    const workspaceRoot = path.join(root, 'workspaces');
    const checkoutPath = path.join(workspaceRoot, 'pinned');
    await mkdir(workspaceRoot);
    const adapter = new SvnAdapter({
      executablePath: svnPath,
      workspaceRoot,
      allowedRepositoryRoots: [synthetic.repositoryUrl],
      allowFileUrlsForTests: true,
      commandTimeoutMs: 30_000,
    });

    const checkout = await adapter.checkout({ url: synthetic.trunkUrl, destination: checkoutPath, revision: svnRevision(1) });
    assert.ok(checkout.length > 0);
    assert.ok(checkout.every((entry) => entry.revision === '1'));
    await commitSyntheticHeadChange(synthetic, svnPath);

    const stillPinned = await adapter.info({ target: checkoutPath, revision: svnRevision(1), depth: 'infinity' });
    assert.ok(stillPinned.every((entry) => entry.revision === '1'));
    const history = await adapter.log({ url: synthetic.trunkUrl, startRevision: svnRevision(2), endRevision: svnRevision(1) });
    assert.deepEqual(history.map((entry) => entry.revision), ['2', '1']);
    const changed = await adapter.diff({ url: synthetic.trunkUrl, startRevision: svnRevision(1), endRevision: svnRevision(2) });
    assert.ok(changed.some((entry) => entry.item === 'modified' && entry.target.endsWith('Fixture.cpp')));

    const updated = await adapter.update({ workingCopy: checkoutPath, revision: svnRevision(2) });
    assert.ok(updated.every((entry) => entry.revision === '2'));
    const status = await adapter.status({ workingCopy: checkoutPath, expectedRevision: svnRevision(2) });
    assert.ok(Array.isArray(status));

    const acl = await adapter.captureAclSnapshot({
      repositoryUrl: synthetic.trunkUrl,
      revision: svnRevision(2),
      subject: 'synthetic-user',
      paths: ['Source/Fixture/Fixture.cpp', 'Source/Missing.cpp'],
      ttlSeconds: 60,
    });
    assert.equal(acl.paths[0].access, 'read');
    assert.equal(acl.paths[1].access, 'none');
    assert.equal(acl.complete, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
