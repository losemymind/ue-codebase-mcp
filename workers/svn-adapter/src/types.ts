export type SvnRevision = string & { readonly __svnRevision: unique symbol };
export type SvnDepth = 'empty' | 'files' | 'immediates' | 'infinity';
export type SvnNodeKind = 'file' | 'dir' | 'none' | 'unknown';
export type SvnErrorCategory =
  | 'authentication'
  | 'authorization'
  | 'conflict'
  | 'invalid-input'
  | 'not-found'
  | 'output-limit'
  | 'revision-mismatch'
  | 'timeout'
  | 'unavailable'
  | 'unknown';
export type SvnOperation = 'checkout' | 'update' | 'log' | 'info' | 'diff' | 'status' | 'acl-snapshot';

export interface SvnInfo {
  path: string;
  kind: SvnNodeKind;
  revision: SvnRevision;
  url: string;
  repositoryRoot: string;
  repositoryUuid: string;
  lastChangedRevision?: SvnRevision;
  lastChangedAuthor?: string;
  lastChangedAt?: string;
}

export interface SvnLogEntry {
  revision: SvnRevision;
  author?: string;
  committedAt: string;
  message: string;
  changedPaths: Array<{
    path: string;
    action: 'A' | 'D' | 'M' | 'R';
    kind?: SvnNodeKind;
  }>;
}

export interface SvnDiffEntry {
  target: string;
  item: 'added' | 'deleted' | 'modified' | 'replaced' | 'none' | 'normal';
  kind: SvnNodeKind;
}

export interface SvnStatusEntry {
  path: string;
  item: string;
  properties: string;
  workingRevision?: SvnRevision;
  repositoryItem?: string;
  repositoryProperties?: string;
}

export interface SvnAclPathAccess {
  path: string;
  access: 'read' | 'none' | 'indeterminate';
  errorCategory?: SvnErrorCategory;
}

export interface SvnAclSnapshot {
  repositoryUrl: string;
  revision: SvnRevision;
  subject: string;
  capturedAt: string;
  expiresAt: string;
  complete: boolean;
  paths: SvnAclPathAccess[];
}

export interface SvnTelemetryEvent {
  operation: SvnOperation;
  outcome: 'succeeded' | 'failed';
  durationMs: number;
  errorCategory?: SvnErrorCategory;
}

export interface SvnInvocation {
  operation: SvnOperation;
  executablePath: string;
  args: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface SvnExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type SvnCommandExecutor = (invocation: SvnInvocation) => Promise<SvnExecutionResult>;

export interface SvnAdapterOptions {
  executablePath: string;
  workspaceRoot: string;
  allowedRepositoryRoots: readonly string[];
  credentialRef?: string;
  allowFileUrlsForTests?: boolean;
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
  executor?: SvnCommandExecutor;
  onTelemetry?: (event: SvnTelemetryEvent) => void;
}

export interface SvnRequestBase {
  signal?: AbortSignal;
}
