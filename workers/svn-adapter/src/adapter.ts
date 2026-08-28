import { spawn } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { child, children, parseSvnXml, textOf, type XmlNode } from './xml.ts';
import type {
  SvnAclSnapshot,
  SvnAdapterOptions,
  SvnCommandExecutor,
  SvnDepth,
  SvnDiffEntry,
  SvnErrorCategory,
  SvnExecutionResult,
  SvnInfo,
  SvnInvocation,
  SvnLogEntry,
  SvnNodeKind,
  SvnOperation,
  SvnRequestBase,
  SvnRevision,
  SvnStatusEntry,
} from './types.ts';

const SECRET_REF = /^secret:\/\/[a-z][a-z0-9._-]{1,62}\/[A-Za-z0-9][A-Za-z0-9._/-]{0,253}$/;
const SVN_ERROR_CODE = /\b(E\d{6})\b/g;
const SAFE_ENVIRONMENT_KEYS = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'LANG', 'LC_ALL'] as const;

export class SvnAdapterError extends Error {
  readonly category: SvnErrorCategory;
  readonly operation: SvnOperation;
  readonly svnCodes: readonly string[];
  readonly retryable: boolean;
  readonly exitCode?: number;

  constructor(operation: SvnOperation, category: SvnErrorCategory, options: { svnCodes?: string[]; exitCode?: number; cause?: unknown } = {}) {
    super(`SVN ${operation} failed (${category})`, { cause: options.cause });
    this.name = 'SvnAdapterError';
    this.category = category;
    this.operation = operation;
    this.svnCodes = Object.freeze(options.svnCodes ?? []);
    this.retryable = ['timeout', 'unavailable'].includes(category);
    this.exitCode = options.exitCode;
  }
}

export function svnRevision(value: string | number | bigint): SvnRevision {
  const normalized = String(value);
  if (!/^(0|[1-9][0-9]{0,18})$/.test(normalized) || BigInt(normalized) > 9_223_372_036_854_775_807n) {
    throw new TypeError('SVN revision must be a non-negative 64-bit decimal integer');
  }
  return normalized as SvnRevision;
}

function nodeKind(value: string | undefined): SvnNodeKind {
  return value === 'file' || value === 'dir' || value === 'none' ? value : 'unknown';
}

function required(value: string | undefined, field: string): string {
  if (!value) throw new Error(`SVN_XML_MISSING_${field.toUpperCase()}`);
  return value;
}

function classify(stderr: string): { category: SvnErrorCategory; codes: string[] } {
  const codes = [...new Set(stderr.match(SVN_ERROR_CODE) ?? [])];
  if (codes.some((code) => ['E170001', 'E215004'].includes(code))) return { category: 'authentication', codes };
  if (codes.some((code) => ['E175013', 'E220004'].includes(code))) return { category: 'authorization', codes };
  if (codes.some((code) => ['E155015', 'E155011', 'E195016'].includes(code))) return { category: 'conflict', codes };
  if (codes.some((code) => ['E160013', 'E200009', 'E170000'].includes(code))) return { category: 'not-found', codes };
  if (codes.some((code) => ['E170013', 'E175002', 'E730061'].includes(code))) return { category: 'unavailable', codes };
  return { category: 'unknown', codes };
}

function defaultExecutor(invocation: SvnInvocation): Promise<SvnExecutionResult> {
  return new Promise((resolve, reject) => {
    const environment: NodeJS.ProcessEnv = {};
    for (const key of SAFE_ENVIRONMENT_KEYS) if (process.env[key] !== undefined) environment[key] = process.env[key];
    environment.LC_ALL = 'C';
    const subprocess = spawn(invocation.executablePath, [...invocation.args], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environment,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      subprocess.kill();
    }, invocation.timeoutMs);
    timer.unref();
    const abort = () => subprocess.kill();
    invocation.signal?.addEventListener('abort', abort, { once: true });
    subprocess.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > invocation.maxOutputBytes) {
        outputExceeded = true;
        subprocess.kill();
      } else stdout.push(chunk);
    });
    subprocess.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > invocation.maxOutputBytes) {
        outputExceeded = true;
        subprocess.kill();
      } else stderr.push(chunk);
    });
    subprocess.once('error', (cause) => {
      clearTimeout(timer);
      invocation.signal?.removeEventListener('abort', abort);
      reject(cause);
    });
    subprocess.once('close', (exitCode) => {
      clearTimeout(timer);
      invocation.signal?.removeEventListener('abort', abort);
      if (outputExceeded) return reject(new SvnAdapterError(invocation.operation, 'output-limit'));
      if (timedOut || invocation.signal?.aborted) return reject(new SvnAdapterError(invocation.operation, 'timeout'));
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: exitCode ?? -1 });
    });
  });
}

function parseInfo(xml: string, maxBytes: number): SvnInfo[] {
  const root = parseSvnXml(xml, maxBytes);
  if (root.name !== 'info') throw new Error('SVN_XML_EXPECTED_INFO');
  return children(root, 'entry').map((entry) => {
    const repository = child(entry, 'repository');
    const commit = child(entry, 'commit');
    return {
      path: required(entry.attributes.path, 'path'),
      kind: nodeKind(entry.attributes.kind),
      revision: svnRevision(required(entry.attributes.revision, 'revision')),
      url: required(textOf(child(entry, 'url')), 'url'),
      repositoryRoot: required(textOf(repository && child(repository, 'root')), 'repository_root'),
      repositoryUuid: required(textOf(repository && child(repository, 'uuid')), 'repository_uuid'),
      ...(commit?.attributes.revision ? { lastChangedRevision: svnRevision(commit.attributes.revision) } : {}),
      ...(textOf(commit && child(commit, 'author')) ? { lastChangedAuthor: textOf(commit && child(commit, 'author')) } : {}),
      ...(textOf(commit && child(commit, 'date')) ? { lastChangedAt: textOf(commit && child(commit, 'date')) } : {}),
    };
  });
}

function parseLog(xml: string, maxBytes: number): SvnLogEntry[] {
  const root = parseSvnXml(xml, maxBytes);
  if (root.name !== 'log') throw new Error('SVN_XML_EXPECTED_LOG');
  return children(root, 'logentry').map((entry) => ({
    revision: svnRevision(required(entry.attributes.revision, 'revision')),
    ...(textOf(child(entry, 'author')) ? { author: textOf(child(entry, 'author')) } : {}),
    committedAt: required(textOf(child(entry, 'date')), 'date'),
    message: textOf(child(entry, 'msg')) ?? '',
    changedPaths: children(child(entry, 'paths') ?? { children: [] } as XmlNode, 'path').map((changed) => ({
      path: changed.text.trim(),
      action: required(changed.attributes.action, 'action') as 'A' | 'D' | 'M' | 'R',
      ...(changed.attributes.kind ? { kind: nodeKind(changed.attributes.kind) } : {}),
    })),
  }));
}

function parseDiff(xml: string, maxBytes: number): SvnDiffEntry[] {
  const root = parseSvnXml(xml, maxBytes);
  if (root.name !== 'diff') throw new Error('SVN_XML_EXPECTED_DIFF');
  const paths = child(root, 'paths');
  if (!paths) return [];
  return children(paths, 'path').map((entry) => ({
    target: entry.text.trim(),
    item: required(entry.attributes.item, 'item') as SvnDiffEntry['item'],
    kind: nodeKind(entry.attributes.kind),
  }));
}

function parseStatus(xml: string, maxBytes: number): SvnStatusEntry[] {
  const root = parseSvnXml(xml, maxBytes);
  if (root.name !== 'status') throw new Error('SVN_XML_EXPECTED_STATUS');
  const result: SvnStatusEntry[] = [];
  for (const target of children(root, 'target')) {
    for (const entry of children(target, 'entry')) {
      const working = child(entry, 'wc-status');
      const repository = working && child(working, 'repos-status');
      if (!working) throw new Error('SVN_XML_MISSING_WC_STATUS');
      result.push({
        path: required(entry.attributes.path, 'path'),
        item: required(working.attributes.item, 'item'),
        properties: required(working.attributes.props, 'props'),
        ...(working.attributes.revision ? { workingRevision: svnRevision(working.attributes.revision) } : {}),
        ...(repository?.attributes.item ? { repositoryItem: repository.attributes.item } : {}),
        ...(repository?.attributes.props ? { repositoryProperties: repository.attributes.props } : {}),
      });
    }
  }
  return result;
}

export interface CheckoutRequest extends SvnRequestBase { url: string; destination: string; revision: SvnRevision; depth?: SvnDepth }
export interface UpdateRequest extends SvnRequestBase { workingCopy: string; revision: SvnRevision; depth?: SvnDepth }
export interface InfoRequest extends SvnRequestBase { target: string; revision: SvnRevision; depth?: SvnDepth }
export interface LogRequest extends SvnRequestBase { url: string; startRevision: SvnRevision; endRevision: SvnRevision; limit?: number }
export interface DiffRequest extends SvnRequestBase { url: string; startRevision: SvnRevision; endRevision: SvnRevision; depth?: SvnDepth }
export interface StatusRequest extends SvnRequestBase { workingCopy: string; expectedRevision: SvnRevision; remote?: boolean }
export interface AclSnapshotRequest extends SvnRequestBase { repositoryUrl: string; revision: SvnRevision; subject: string; paths: readonly string[]; ttlSeconds: number }

export class SvnAdapter {
  readonly #options: Required<Pick<SvnAdapterOptions, 'commandTimeoutMs' | 'maxOutputBytes' | 'allowFileUrlsForTests'>> & SvnAdapterOptions;
  readonly #executor: SvnCommandExecutor;
  readonly #workspaceRoot: string;
  readonly #allowedRoots: URL[];

  constructor(options: SvnAdapterOptions) {
    if (!path.isAbsolute(options.executablePath) || !/^svn(?:\.exe)?$/i.test(path.basename(options.executablePath))) throw new TypeError('SVN executable must be a fixed absolute svn executable path');
    if (!path.isAbsolute(options.workspaceRoot)) throw new TypeError('SVN workspace root must be absolute');
    if (options.allowedRepositoryRoots.length === 0) throw new TypeError('At least one allowed SVN repository root is required');
    if (options.credentialRef && !SECRET_REF.test(options.credentialRef)) throw new TypeError('SVN credential must be an opaque secret reference');
    this.#options = { commandTimeoutMs: 120_000, maxOutputBytes: 8 * 1024 * 1024, allowFileUrlsForTests: false, ...options };
    if (this.#options.commandTimeoutMs < 1_000 || this.#options.commandTimeoutMs > 600_000) throw new TypeError('SVN timeout is outside the allowed range');
    if (this.#options.maxOutputBytes < 1_024 || this.#options.maxOutputBytes > 8 * 1024 * 1024) throw new TypeError('SVN output limit is outside the allowed range');
    this.#executor = options.executor ?? defaultExecutor;
    this.#workspaceRoot = path.resolve(options.workspaceRoot);
    this.#allowedRoots = options.allowedRepositoryRoots.map((root) => this.#validateUrl(root, false));
  }

  async checkout(request: CheckoutRequest): Promise<SvnInfo[]> {
    const url = this.#allowedUrl(request.url);
    const destination = await this.#workspacePath(request.destination, false);
    await this.#run('checkout', ['checkout', '--non-interactive', '--quiet', '--ignore-externals', '--depth', request.depth ?? 'infinity', '--revision', request.revision, url, destination], request.signal, false);
    return this.#verifyWorkingCopy(destination, request.revision, request.signal);
  }

  async update(request: UpdateRequest): Promise<SvnInfo[]> {
    const workingCopy = await this.#workspacePath(request.workingCopy, true);
    await this.#run('update', ['update', '--non-interactive', '--quiet', '--ignore-externals', '--accept', 'postpone', '--depth', request.depth ?? 'infinity', '--revision', request.revision, workingCopy], request.signal, false);
    return this.#verifyWorkingCopy(workingCopy, request.revision, request.signal);
  }

  async info(request: InfoRequest): Promise<SvnInfo[]> {
    const target = await this.#target(request.target);
    const xml = await this.#run('info', ['info', '--xml', '--non-interactive', '--depth', request.depth ?? 'empty', '--revision', request.revision, target], request.signal);
    return parseInfo(xml, this.#options.maxOutputBytes);
  }

  async log(request: LogRequest): Promise<SvnLogEntry[]> {
    const url = this.#allowedUrl(request.url);
    const limit = request.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('SVN log limit must be from 1 through 1000');
    const xml = await this.#run('log', ['log', '--xml', '--non-interactive', '--verbose', '--limit', String(limit), '--revision', `${request.startRevision}:${request.endRevision}`, url], request.signal);
    return parseLog(xml, this.#options.maxOutputBytes);
  }

  async diff(request: DiffRequest): Promise<SvnDiffEntry[]> {
    const url = this.#allowedUrl(request.url);
    const xml = await this.#run('diff', ['diff', '--summarize', '--xml', '--non-interactive', '--depth', request.depth ?? 'infinity', '--revision', `${request.startRevision}:${request.endRevision}`, url], request.signal);
    return parseDiff(xml, this.#options.maxOutputBytes);
  }

  async status(request: StatusRequest): Promise<SvnStatusEntry[]> {
    const workingCopy = await this.#workspacePath(request.workingCopy, true);
    await this.#verifyWorkingCopy(workingCopy, request.expectedRevision, request.signal);
    const args = ['status', '--xml', '--non-interactive', '--ignore-externals'];
    if (request.remote) args.push('--show-updates');
    args.push(workingCopy);
    return parseStatus(await this.#run('status', args, request.signal), this.#options.maxOutputBytes);
  }

  async captureAclSnapshot(request: AclSnapshotRequest): Promise<SvnAclSnapshot> {
    const repositoryUrl = this.#allowedUrl(request.repositoryUrl);
    if (!request.subject || request.subject.length > 512) throw new TypeError('SVN ACL subject is invalid');
    if (request.paths.length === 0 || request.paths.length > 1024 || request.ttlSeconds < 30 || request.ttlSeconds > 3600) throw new TypeError('SVN ACL snapshot bounds are invalid');
    const capturedAt = new Date();
    const paths = [];
    for (const relativePath of request.paths) {
      if (!/^(?:\/?[A-Za-z0-9._ -]+)*\/?$/.test(relativePath) || relativePath.split('/').some((segment) => segment === '..')) throw new TypeError('SVN ACL probe path is invalid');
      const target = new URL(relativePath.replace(/^\//, ''), `${repositoryUrl.replace(/\/$/, '')}/`).href;
      try {
        await this.info({ target, revision: request.revision, signal: request.signal });
        paths.push({ path: relativePath, access: 'read' as const });
      } catch (error) {
        if (!(error instanceof SvnAdapterError)) throw error;
        const access = ['authentication', 'authorization', 'not-found'].includes(error.category) ? 'none' as const : 'indeterminate' as const;
        paths.push({ path: relativePath, access, errorCategory: error.category });
      }
    }
    return {
      repositoryUrl,
      revision: request.revision,
      subject: request.subject,
      capturedAt: capturedAt.toISOString(),
      expiresAt: new Date(capturedAt.getTime() + request.ttlSeconds * 1000).toISOString(),
      complete: paths.every((entry) => entry.access !== 'indeterminate'),
      paths,
    };
  }

  async #verifyWorkingCopy(workingCopy: string, expected: SvnRevision, signal?: AbortSignal): Promise<SvnInfo[]> {
    const xml = await this.#run('info', ['info', '--xml', '--non-interactive', '--depth', 'infinity', workingCopy], signal);
    const entries = parseInfo(xml, this.#options.maxOutputBytes);
    if (entries.length === 0 || entries.some((entry) => entry.revision !== expected)) throw new SvnAdapterError('info', 'revision-mismatch');
    return entries;
  }

  async #run(operation: SvnOperation, args: string[], signal?: AbortSignal, expectXml = true): Promise<string> {
    if (args.some((arg) => /\r|\n|\0/.test(arg)) || args.some((arg) => ['--username', '--password', '--config-option', '--config-dir', '--editor-cmd', '--diff-cmd'].includes(arg))) {
      throw new SvnAdapterError(operation, 'invalid-input');
    }
    if (expectXml && !args.includes('--xml')) throw new SvnAdapterError(operation, 'invalid-input');
    const started = performance.now();
    try {
      const result = await this.#executor({ operation, executablePath: this.#options.executablePath, args: Object.freeze(args), timeoutMs: this.#options.commandTimeoutMs, maxOutputBytes: this.#options.maxOutputBytes, signal });
      if (result.exitCode !== 0) {
        const classified = classify(result.stderr);
        throw new SvnAdapterError(operation, classified.category, { svnCodes: classified.codes, exitCode: result.exitCode });
      }
      this.#options.onTelemetry?.({ operation, outcome: 'succeeded', durationMs: Math.round(performance.now() - started) });
      return result.stdout;
    } catch (cause) {
      const error = cause instanceof SvnAdapterError ? cause : new SvnAdapterError(operation, 'unavailable', { cause });
      this.#options.onTelemetry?.({ operation, outcome: 'failed', durationMs: Math.round(performance.now() - started), errorCategory: error.category });
      throw error;
    }
  }

  #validateUrl(value: string, enforceAllowed: boolean): URL {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new TypeError('SVN target must be an absolute URL'); }
    const protocols = this.#options?.allowFileUrlsForTests ? ['https:', 'svn+ssh:', 'file:'] : ['https:', 'svn+ssh:'];
    if (!protocols.includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || /%2e/i.test(parsed.pathname)) throw new TypeError('SVN URL violates repository policy');
    if (enforceAllowed && !this.#allowedRoots.some((root) => parsed.href === root.href || parsed.href.startsWith(`${root.href.replace(/\/$/, '')}/`))) throw new TypeError('SVN URL is outside configured repository roots');
    return parsed;
  }

  #allowedUrl(value: string): string {
    return this.#validateUrl(value, true).href;
  }

  async #target(value: string): Promise<string> {
    if (path.isAbsolute(value)) return this.#workspacePath(value, true);
    try { return this.#allowedUrl(value); } catch (error) {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) throw error;
      return this.#workspacePath(value, true);
    }
  }

  async #workspacePath(value: string, mustExist: boolean): Promise<string> {
    if (!path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new TypeError('SVN workspace path must be absolute');
    const resolved = path.resolve(value);
    const relative = path.relative(this.#workspaceRoot, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new TypeError('SVN workspace path is outside the configured root');
    let probe = resolved;
    if (mustExist) await access(probe);
    while (true) {
      try { probe = await realpath(probe); break; } catch {
        const parent = path.dirname(probe);
        if (parent === probe) throw new TypeError('SVN workspace path has no existing confined parent');
        probe = parent;
      }
    }
    const rootReal = await realpath(this.#workspaceRoot);
    const realRelative = path.relative(rootReal, probe);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new TypeError('SVN workspace path crosses a link or junction outside the configured root');
    return resolved;
  }
}
