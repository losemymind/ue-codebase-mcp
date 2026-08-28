import { AuthorizationError, type Clock, systemClock } from './common.ts';

export type PrincipalType = 'user' | 'service';
export type ProjectRole = 'reader' | 'operator' | 'administrator';
export type AuthorizationAction = 'read' | 'request_reindex' | 'start_build' | 'start_test' | 'cancel_job' | 'administer';

export interface AuthorizationPrincipal {
  type: PrincipalType;
  id: string;
}

export interface PrincipalRecord {
  type: PrincipalType;
  id: string;
  svnSubject: string;
  active: boolean;
}

export interface ProjectRecord {
  id: string;
  status: 'active' | 'disabled' | 'archived';
}

export interface RepositoryRecord {
  id: string;
  projectId: string;
  kind: 'svn';
  enabled: boolean;
}

export interface ProjectPermission {
  projectId: string;
  principalType: 'user' | 'team' | 'service';
  principalId: string;
  role: ProjectRole;
}

export interface SvnAccessSnapshot {
  repositoryId: string;
  revision: string;
  subject: string;
  path: string;
  effectiveAccess: 'none' | 'read';
  capturedAt: number;
  expiresAt: number;
}

export interface AuthorizationReadView {
  getPrincipal(principal: Readonly<AuthorizationPrincipal>): Promise<PrincipalRecord | null>;
  listActiveTeamIds(userId: string): Promise<readonly string[]>;
  getProject(projectId: string): Promise<ProjectRecord | null>;
  getRepository(repositoryId: string): Promise<RepositoryRecord | null>;
  listProjectPermissions(projectId: string): Promise<readonly ProjectPermission[]>;
  getSvnAccessSnapshot(query: Readonly<{ repositoryId: string; revision: string; subject: string; path: string }>): Promise<SvnAccessSnapshot | null>;
}

export interface AuthorizationRepository {
  readSnapshot<T>(work: (view: AuthorizationReadView) => Promise<T>): Promise<T>;
}

export interface AuthorizationRequest {
  principal: Readonly<AuthorizationPrincipal>;
  action: AuthorizationAction;
  projectId: string;
  repositoryId: string;
  revision: string;
  path?: string;
}

export type AuthorizationDecision = Readonly<
  | { allowed: true; reason: 'allowed'; role: ProjectRole }
  | { allowed: false; reason: 'not_visible' }
>;

const denied: AuthorizationDecision = Object.freeze({ allowed: false, reason: 'not_visible' });
const roleRank: Readonly<Record<ProjectRole, number>> = Object.freeze({ reader: 1, operator: 2, administrator: 3 });
const actionRank: Readonly<Record<AuthorizationAction, number>> = Object.freeze({ read: 1, request_reindex: 2, start_build: 2, start_test: 2, cancel_job: 2, administer: 3 });

function boundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,511}$/.test(value);
}

function boundedSubject(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && value === value.normalize('NFC')
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizePath(value: string | undefined): string | undefined {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048 || value !== value.normalize('NFC')) return undefined;
  if (value.includes('\\') || value.includes('\u0000') || value.includes('%') || value.startsWith('/') || value.endsWith('/')) return undefined;
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return undefined;
  return value;
}

function strongestRole(permissions: readonly ProjectPermission[], projectId: string, principal: PrincipalRecord, activeTeams: ReadonlySet<string>): ProjectRole | undefined {
  let strongest: ProjectRole | undefined;
  for (const permission of permissions) {
    if (permission.projectId !== projectId || !(permission.role in roleRank)) continue;
    const direct = permission.principalType === principal.type && permission.principalId === principal.id;
    const throughTeam = principal.type === 'user' && permission.principalType === 'team' && activeTeams.has(permission.principalId);
    if (!direct && !throughTeam) continue;
    if (!strongest || roleRank[permission.role] > roleRank[strongest]) strongest = permission.role;
  }
  return strongest;
}

function snapshotIsFresh(snapshot: SvnAccessSnapshot, query: { repositoryId: string; revision: string; subject: string; path: string }, now: number, maximumAge: number): boolean {
  return snapshot.repositoryId === query.repositoryId
    && snapshot.revision === query.revision
    && snapshot.subject === query.subject
    && snapshot.path === query.path
    && snapshot.effectiveAccess === 'read'
    && Number.isSafeInteger(snapshot.capturedAt)
    && Number.isSafeInteger(snapshot.expiresAt)
    && snapshot.capturedAt <= now
    && now - snapshot.capturedAt <= maximumAge
    && now < snapshot.expiresAt;
}

export class AclPolicyEngine {
  readonly #repository: AuthorizationRepository;
  readonly #clock: Clock;
  readonly #maximumSnapshotAgeMs: number;

  constructor(repository: AuthorizationRepository, maximumSnapshotAgeMs: number, clock: Clock = systemClock) {
    if (!Number.isSafeInteger(maximumSnapshotAgeMs) || maximumSnapshotAgeMs < 1_000 || maximumSnapshotAgeMs > 15 * 60 * 1_000) {
      throw new TypeError('invalid ACL freshness policy');
    }
    this.#repository = repository;
    this.#maximumSnapshotAgeMs = maximumSnapshotAgeMs;
    this.#clock = clock;
  }

  async evaluate(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    try {
      const path = normalizePath(request.path);
      if (path === undefined || !boundedIdentifier(request.principal.id) || !boundedIdentifier(request.projectId) || !boundedIdentifier(request.repositoryId)) return denied;
      if (!['user', 'service'].includes(request.principal.type) || !(request.action in actionRank) || !/^(?:0|[1-9][0-9]*)$/.test(request.revision)) return denied;
      return await this.#repository.readSnapshot(async (view) => {
        const principal = await view.getPrincipal(request.principal);
        if (!principal || !principal.active || principal.id !== request.principal.id || principal.type !== request.principal.type || !boundedSubject(principal.svnSubject)) return denied;
        const project = await view.getProject(request.projectId);
        const repository = await view.getRepository(request.repositoryId);
        if (!project || project.id !== request.projectId || project.status !== 'active') return denied;
        if (!repository || repository.id !== request.repositoryId || repository.projectId !== project.id || repository.kind !== 'svn' || !repository.enabled) return denied;
        const teamIds = principal.type === 'user' ? await view.listActiveTeamIds(principal.id) : [];
        if (!Array.isArray(teamIds) || teamIds.some((teamId) => !boundedIdentifier(teamId))) return denied;
        const permissions = await view.listProjectPermissions(project.id);
        if (!Array.isArray(permissions)) return denied;
        const role = strongestRole(permissions, project.id, principal, new Set(teamIds));
        if (!role || roleRank[role] < actionRank[request.action]) return denied;
        const svnQuery = Object.freeze({ repositoryId: repository.id, revision: request.revision, subject: principal.svnSubject, path });
        const snapshot = await view.getSvnAccessSnapshot(svnQuery);
        if (!snapshot || !snapshotIsFresh(snapshot, svnQuery, this.#clock.now(), this.#maximumSnapshotAgeMs)) return denied;
        return Object.freeze({ allowed: true, reason: 'allowed', role });
      });
    } catch {
      return denied;
    }
  }

  async authorize(request: AuthorizationRequest): Promise<Readonly<{ role: ProjectRole }>> {
    const decision = await this.evaluate(request);
    if (!decision.allowed) throw new AuthorizationError();
    return Object.freeze({ role: decision.role });
  }
}
