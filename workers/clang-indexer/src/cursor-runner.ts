import { spawn } from 'node:child_process';
import path from 'node:path';
import { buildCursorIndexerInvocation, parseCursorIndexerJsonLines, type CursorIndexerInvocation, type CursorIndexResult } from './cursor-stream.ts';

export type CursorIndexerErrorCode =
  | 'start-failed'
  | 'timeout'
  | 'aborted'
  | 'output-limit'
  | 'nonzero-exit'
  | 'input-rejected'
  | 'initialization-failed'
  | 'parse-failed'
  | 'parse-crashed'
  | 'parse-invalid-arguments'
  | 'parse-ast-read-error'
  | 'record-limit'
  | 'output-failed'
  | 'invalid-output'
  | 'diagnostic-errors';

export class CursorIndexerError extends Error {
  readonly code: CursorIndexerErrorCode;

  constructor(code: CursorIndexerErrorCode) {
    super(`cursor indexer ${code}`);
    this.name = 'CursorIndexerError';
    this.code = code;
  }
}

export interface CursorExecutionPolicy {
  timeout_ms?: number;
  max_output_bytes?: number;
  max_error_diagnostics?: number;
  signal?: AbortSignal;
}

export interface CursorProcessResult {
  exit_code: number;
  stdout: string;
  stderr_bytes: number;
  timed_out?: boolean;
  aborted?: boolean;
  output_exceeded?: boolean;
}

export type CursorProcessExecutor = (
  invocation: CursorIndexerInvocation,
  policy: Readonly<Required<Pick<CursorExecutionPolicy, 'timeout_ms' | 'max_output_bytes'>> & Pick<CursorExecutionPolicy, 'signal'>>,
) => Promise<CursorProcessResult>;

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

function safeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[name] !== undefined) environment[name] = process.env[name];
  return environment;
}

function validateInvocation(invocation: CursorIndexerInvocation): void {
  if (!path.isAbsolute(invocation.executable) || path.basename(invocation.executable).toLowerCase() !== 'clang-cursor-indexer.exe'
      || !path.isAbsolute(invocation.cwd) || !Array.isArray(invocation.args) || invocation.args.length < 5
      || invocation.args[0] !== '--source' || invocation.args[2] !== '--workspace-root'
      || invocation.args[3] !== invocation.cwd || invocation.args.some((argument) => typeof argument !== 'string' || /[\r\n\0]/.test(argument))) {
    throw new TypeError('cursor invocation is invalid');
  }
  const fileMode = invocation.args[4] === '--arguments-file';
  if ((!fileMode && invocation.args[4] !== '--')
      || (fileMode && (invocation.args.length !== 9 || invocation.args[6] !== '--arguments-root' || invocation.args[8] !== '--'))) {
    throw new TypeError('cursor invocation is invalid');
  }
  const rebuilt = buildCursorIndexerInvocation({
    executable: invocation.executable,
    tool_root: path.dirname(invocation.executable),
    workspace_root: invocation.cwd,
    source_file: invocation.args[1],
    compile_arguments: fileMode ? [] : invocation.args.slice(5),
    ...(fileMode ? { arguments_file: invocation.args[5], arguments_root: invocation.args[7] } : {}),
  });
  if (JSON.stringify(rebuilt.args) !== JSON.stringify(invocation.args)) throw new TypeError('cursor invocation is invalid');
}

function defaultExecutor(
  invocation: CursorIndexerInvocation,
  policy: Readonly<Required<Pick<CursorExecutionPolicy, 'timeout_ms' | 'max_output_bytes'>> & Pick<CursorExecutionPolicy, 'signal'>>,
): Promise<CursorProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, [...invocation.args], {
      cwd: invocation.cwd,
      env: safeEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let aborted = false;
    let outputExceeded = false;
    let settled = false;
    const stop = (): void => { if (!child.killed) child.kill(); };
    const abort = (): void => { aborted = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, policy.timeout_ms);
    timer.unref();
    policy.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes + stderrBytes > policy.max_output_bytes) { outputExceeded = true; stop(); } else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stdoutBytes + stderrBytes > policy.max_output_bytes) { outputExceeded = true; stop(); }
    });
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      policy.signal?.removeEventListener('abort', abort);
      reject(new CursorIndexerError('start-failed'));
    });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      policy.signal?.removeEventListener('abort', abort);
      resolve({ exit_code: exitCode ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr_bytes: stderrBytes, timed_out: timedOut, aborted, output_exceeded: outputExceeded });
    });
  });
}

export async function runCursorIndexer(
  invocation: CursorIndexerInvocation,
  workspaceRoots: readonly string[],
  policy: CursorExecutionPolicy = {},
  executor: CursorProcessExecutor = defaultExecutor,
): Promise<CursorIndexResult> {
  validateInvocation(invocation);
  const timeout = policy.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const outputLimit = policy.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const errorLimit = policy.max_error_diagnostics ?? 0;
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > MAX_TIMEOUT_MS
      || !Number.isSafeInteger(outputLimit) || outputLimit < 1_024 || outputLimit > DEFAULT_MAX_OUTPUT_BYTES
      || !Number.isSafeInteger(errorLimit) || errorLimit < 0 || errorLimit > 1_000) {
    throw new TypeError('cursor execution policy is invalid');
  }
  if (policy.signal?.aborted) throw new CursorIndexerError('aborted');
  const result = await executor(invocation, Object.freeze({ timeout_ms: timeout, max_output_bytes: outputLimit, ...(policy.signal === undefined ? {} : { signal: policy.signal }) }));
  if (result.output_exceeded) throw new CursorIndexerError('output-limit');
  if (result.timed_out) throw new CursorIndexerError('timeout');
  if (result.aborted || policy.signal?.aborted) throw new CursorIndexerError('aborted');
  if (result.exit_code !== 0) {
    const classified = new Map<number, CursorIndexerErrorCode>([
      [10, 'input-rejected'], [11, 'initialization-failed'], [12, 'parse-failed'], [13, 'record-limit'], [14, 'output-failed'],
      [21, 'parse-failed'], [22, 'parse-crashed'], [23, 'parse-invalid-arguments'], [24, 'parse-ast-read-error'],
    ]).get(result.exit_code) ?? 'nonzero-exit';
    throw new CursorIndexerError(classified);
  }
  let parsed: CursorIndexResult;
  try { parsed = parseCursorIndexerJsonLines(result.stdout, workspaceRoots); } catch { throw new CursorIndexerError('invalid-output'); }
  if (parsed.error_count > errorLimit) throw new CursorIndexerError('diagnostic-errors');
  return parsed;
}
