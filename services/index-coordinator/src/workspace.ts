import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

export type RepositoryRole = 'engine' | 'game' | 'plugin';

export interface PinnedRepository {
  id: string;
  role: RepositoryRole;
  url: string;
  revision: string;
}

export interface RevisionSet {
  schema: 'ue-codebase-mcp/revision-set';
  version: 1;
  project_id: string;
  hash: string;
  repositories: readonly PinnedRepository[];
}

export interface WorkspaceManifest {
  schema: 'ue-codebase-mcp/workspace';
  version: 1;
  project_id: string;
  revision_set_hash: string;
  state: 'ready';
  repositories: ReadonlyArray<PinnedRepository & { relative_path: string }>;
}

export interface WorkspaceHandle {
  root: string;
  manifest: Readonly<WorkspaceManifest>;
}

export interface WorkspaceSvnAdapter {
  checkout(request: Readonly<{ url: string; destination: string; revision: string }>): Promise<readonly { revision: string }[]>;
  info(request: Readonly<{ target: string; revision: string; depth: 'infinity' }>): Promise<readonly { revision: string }[]>;
  status(request: Readonly<{ workingCopy: string; expectedRevision: string }>): Promise<readonly { path: string; item: string }[]>;
}

export class WorkspaceError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

const ID = /^[a-z][a-z0-9-]{1,62}$/;
const REVISION = /^(0|[1-9][0-9]{0,18})$/;
const HASH = /^[a-f0-9]{64}$/;

function canonicalRepositories(repositories: readonly PinnedRepository[]): PinnedRepository[] {
  if (!Array.isArray(repositories) || repositories.length === 0 || repositories.length > 64) {
    throw new WorkspaceError('REVISION_SET_INVALID', 'revision set requires a bounded repository list');
  }
  const result = repositories.map((repository) => {
    if (!ID.test(repository.id) || !['engine', 'game', 'plugin'].includes(repository.role) || !REVISION.test(repository.revision)) {
      throw new WorkspaceError('REVISION_SET_INVALID', 'revision set repository metadata is invalid');
    }
    let url: URL;
    try { url = new URL(repository.url); } catch { throw new WorkspaceError('REVISION_SET_INVALID', 'revision set URL is invalid'); }
    if (!['https:', 'svn+ssh:', 'file:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new WorkspaceError('REVISION_SET_INVALID', 'revision set URL violates SVN policy');
    }
    return Object.freeze({ id: repository.id, role: repository.role, url: url.href, revision: repository.revision });
  });
  result.sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(result.map(({ id }) => id)).size !== result.length) throw new WorkspaceError('REVISION_SET_INVALID', 'repository IDs must be unique');
  return result;
}

export function createRevisionSet(projectId: string, repositories: readonly PinnedRepository[]): Readonly<RevisionSet> {
  if (!ID.test(projectId)) throw new WorkspaceError('REVISION_SET_INVALID', 'project ID is invalid');
  const canonical = canonicalRepositories(repositories);
  const serialized = JSON.stringify({ schema: 'ue-codebase-mcp/revision-set', version: 1, project_id: projectId, repositories: canonical });
  return Object.freeze({
    schema: 'ue-codebase-mcp/revision-set',
    version: 1,
    project_id: projectId,
    hash: createHash('sha256').update(serialized).digest('hex'),
    repositories: Object.freeze(canonical),
  });
}

function exactManifest(value: unknown, expected: RevisionSet): WorkspaceManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WorkspaceError('WORKSPACE_INVALID', 'workspace manifest is invalid');
  const manifest = value as Record<string, unknown>;
  const allowed = ['schema', 'version', 'project_id', 'revision_set_hash', 'state', 'repositories'];
  if (Object.keys(manifest).some((key) => !allowed.includes(key)) || manifest.schema !== 'ue-codebase-mcp/workspace' || manifest.version !== 1 || manifest.project_id !== expected.project_id || manifest.revision_set_hash !== expected.hash || manifest.state !== 'ready' || !Array.isArray(manifest.repositories)) {
    throw new WorkspaceError('WORKSPACE_INVALID', 'workspace manifest does not match the revision set');
  }
  const repositories = manifest.repositories as Array<Record<string, unknown>>;
  if (repositories.length !== expected.repositories.length) throw new WorkspaceError('WORKSPACE_INVALID', 'workspace repository count is invalid');
  for (let index = 0; index < repositories.length; index += 1) {
    const actual = repositories[index];
    const pinned = expected.repositories[index];
    if (Object.keys(actual).some((key) => !['id', 'role', 'url', 'revision', 'relative_path'].includes(key)) || actual.id !== pinned.id || actual.role !== pinned.role || actual.url !== pinned.url || actual.revision !== pinned.revision || actual.relative_path !== `repositories/${pinned.id}`) {
      throw new WorkspaceError('WORKSPACE_INVALID', 'workspace repository mapping is invalid');
    }
  }
  return manifest as unknown as WorkspaceManifest;
}

async function markReadOnly(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.svn') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await markReadOnly(absolute);
      await chmod(absolute, 0o555);
    } else if (entry.isFile()) {
      await chmod(absolute, 0o444);
    }
  }
}

export class ReadOnlyWorkspaceManager {
  #root: string;
  readonly #adapter: WorkspaceSvnAdapter;

  constructor(root: string, adapter: WorkspaceSvnAdapter) {
    if (!path.isAbsolute(root)) throw new WorkspaceError('WORKSPACE_ROOT_INVALID', 'workspace root must be absolute');
    this.#root = path.resolve(root);
    this.#adapter = adapter;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    // Confinement uses the filesystem-canonical root, including Windows 8.3/case normalization.
    this.#root = path.resolve(await realpath(this.#root));
  }

  async prepare(revisionSet: Readonly<RevisionSet>): Promise<WorkspaceHandle> {
    if (!HASH.test(revisionSet.hash) || createRevisionSet(revisionSet.project_id, revisionSet.repositories).hash !== revisionSet.hash) {
      throw new WorkspaceError('REVISION_SET_INVALID', 'revision set hash is invalid');
    }
    await this.initialize();
    const projectRoot = this.#confined(this.#root, revisionSet.project_id);
    await mkdir(projectRoot, { recursive: true });
    const finalRoot = this.#confined(projectRoot, revisionSet.hash);
    try {
      return await this.#openAndVerify(finalRoot, revisionSet);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }

    const lockPath = this.#confined(projectRoot, `${revisionSet.hash}.lock`);
    let lock;
    try {
      lock = await open(lockPath, 'wx');
    } catch (cause) {
      throw new WorkspaceError('WORKSPACE_BUSY', 'revision set workspace is being prepared', { cause });
    }
    const stagingRoot = this.#confined(projectRoot, `.staging-${revisionSet.hash}-${randomUUID()}`);
    try {
      await mkdir(path.join(stagingRoot, 'repositories'), { recursive: true });
      const manifestRepositories: WorkspaceManifest['repositories'] = [];
      for (const repository of revisionSet.repositories) {
        const relative = `repositories/${repository.id}`;
        const destination = this.#confined(stagingRoot, ...relative.split('/'));
        const info = await this.#adapter.checkout({ url: repository.url, destination, revision: repository.revision });
        if (info.length === 0 || info.some((entry) => entry.revision !== repository.revision)) {
          throw new WorkspaceError('REVISION_DRIFT', 'checkout did not remain on the pinned revision');
        }
        const status = await this.#adapter.status({ workingCopy: destination, expectedRevision: repository.revision });
        if (status.some((entry) => !['normal', 'none', 'external'].includes(entry.item))) {
          throw new WorkspaceError('WORKSPACE_DIRTY', 'new checkout contains local changes');
        }
        await markReadOnly(destination);
        manifestRepositories.push(Object.freeze({ ...repository, relative_path: relative }));
      }
      const manifest: WorkspaceManifest = Object.freeze({
        schema: 'ue-codebase-mcp/workspace', version: 1, project_id: revisionSet.project_id,
        revision_set_hash: revisionSet.hash, state: 'ready', repositories: Object.freeze(manifestRepositories),
      });
      await writeFile(path.join(stagingRoot, 'workspace.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await rename(stagingRoot, finalRoot);
      return Object.freeze({ root: finalRoot, manifest });
    } catch (cause) {
      await this.#remove(stagingRoot);
      if (cause instanceof WorkspaceError) throw cause;
      throw new WorkspaceError('WORKSPACE_PREPARE_FAILED', 'workspace preparation failed', { cause });
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }

  async verify(handle: Readonly<WorkspaceHandle>, revisionSet: Readonly<RevisionSet>): Promise<void> {
    if (path.resolve(handle.root) !== this.#confined(this.#root, revisionSet.project_id, revisionSet.hash)) throw new WorkspaceError('WORKSPACE_INVALID', 'workspace handle escaped its revision set');
    await this.#openAndVerify(handle.root, revisionSet);
  }

  async remove(revisionSet: Readonly<RevisionSet>): Promise<void> {
    const target = this.#confined(this.#root, revisionSet.project_id, revisionSet.hash);
    await this.#remove(target);
  }

  async recoverStaging(maximumAgeMs: number, now = Date.now()): Promise<number> {
    if (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 60_000) throw new WorkspaceError('WORKSPACE_RECOVERY_INVALID', 'staging age is invalid');
    await this.initialize();
    let removed = 0;
    for (const project of await readdir(this.#root, { withFileTypes: true })) {
      if (!project.isDirectory() || !ID.test(project.name)) continue;
      const projectRoot = this.#confined(this.#root, project.name);
      for (const entry of await readdir(projectRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('.staging-')) continue;
        const target = this.#confined(projectRoot, entry.name);
        const metadata = await stat(target);
        if (now - metadata.mtimeMs >= maximumAgeMs) {
          await this.#remove(target);
          removed += 1;
        }
      }
    }
    return removed;
  }

  async #openAndVerify(root: string, revisionSet: Readonly<RevisionSet>): Promise<WorkspaceHandle> {
    const manifest = exactManifest(JSON.parse(await readFile(path.join(root, 'workspace.json'), 'utf8')), revisionSet);
    for (const repository of manifest.repositories) {
      const workingCopy = this.#confined(root, ...repository.relative_path.split('/'));
      const info = await this.#adapter.info({ target: workingCopy, revision: repository.revision, depth: 'infinity' });
      if (info.length === 0 || info.some((entry) => entry.revision !== repository.revision)) throw new WorkspaceError('REVISION_DRIFT', 'workspace revision drifted');
      const status = await this.#adapter.status({ workingCopy, expectedRevision: repository.revision });
      if (status.some((entry) => !['normal', 'none', 'external'].includes(entry.item))) throw new WorkspaceError('WORKSPACE_DIRTY', 'workspace has local changes');
    }
    return Object.freeze({ root, manifest: Object.freeze(manifest) });
  }

  #confined(root: string, ...segments: string[]): string {
    const target = path.resolve(root, ...segments);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new WorkspaceError('WORKSPACE_PATH_ESCAPE', 'workspace path escaped its root');
    return target;
  }

  async #remove(target: string): Promise<void> {
    const relative = path.relative(this.#root, path.resolve(target));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).length < 2) {
      throw new WorkspaceError('WORKSPACE_PATH_ESCAPE', 'refusing to remove a broad workspace path');
    }
    await chmod(target, 0o700).catch(() => undefined);
    await rm(target, { recursive: true, force: true });
  }
}
