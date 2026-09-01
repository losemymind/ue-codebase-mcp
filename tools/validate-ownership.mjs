import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const ROOT_FIELDS = Object.freeze(['schema', 'version', 'active_mode', 'identities', 'modes']);
const IDENTITY_FIELDS = Object.freeze(['kind', 'display_name', 'principal', 'configured']);
const MODE_FIELDS = Object.freeze(['roles', 'policy']);
const ROLE_FIELDS = Object.freeze([
  'control_plane_technical_owner',
  'security_release_approver',
  'deployment_operator',
  'fixed_device_witness',
  'g1_gate_approver',
]);
const POLICY_FIELDS = Object.freeze([
  'assurance_level',
  'separation_required',
  'phase_1_g1_eligible',
  'risk_acceptance_id',
]);
const ID = /^[a-z][a-z0-9_]{2,63}$/;
const PRINCIPAL = /^[a-z][a-z0-9_-]{1,31}:[^\s\u0000-\u001f\u007f]{1,224}$/;
const RISK = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{2,127}$/;

function object(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function exact(value, fields, label) {
  const names = Object.keys(object(value, label)).sort();
  const expected = [...fields].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new TypeError(`${label} must contain exact fields`);
  }
}

function text(value, pattern, label, maximum = 128) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || !pattern.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean`);
  return value;
}

function validateIdentity(id, value) {
  text(id, ID, 'identity id', 64);
  exact(value, IDENTITY_FIELDS, `identity ${id}`);
  if (!['human', 'team'].includes(value.kind)) throw new TypeError(`identity ${id} kind is invalid`);
  if (typeof value.display_name !== 'string' || value.display_name.length < 1 || value.display_name.length > 128
      || /[\u0000-\u001f\u007f]/u.test(value.display_name)) throw new TypeError(`identity ${id} display name is invalid`);
  text(value.principal, PRINCIPAL, `identity ${id} principal`, 256);
  boolean(value.configured, `identity ${id} configured`);
  if (value.configured && /UNCONFIGURED|PENDING|PLACEHOLDER/iu.test(value.principal)) {
    throw new TypeError(`identity ${id} cannot configure a placeholder principal`);
  }
  return Object.freeze({ ...value });
}

function validateMode(name, value, identities) {
  exact(value, MODE_FIELDS, `${name} mode`);
  exact(value.roles, ROLE_FIELDS, `${name} roles`);
  exact(value.policy, POLICY_FIELDS, `${name} policy`);
  const roles = {};
  for (const role of ROLE_FIELDS) {
    const identityId = text(value.roles[role], ID, `${name} ${role}`, 64);
    if (identities[identityId] === undefined) throw new TypeError(`${name} ${role} references an unknown identity`);
    roles[role] = identityId;
  }
  if (!['self_attested', 'independently_approved'].includes(value.policy.assurance_level)) {
    throw new TypeError(`${name} assurance level is invalid`);
  }
  boolean(value.policy.separation_required, `${name} separation_required`);
  boolean(value.policy.phase_1_g1_eligible, `${name} phase_1_g1_eligible`);
  text(value.policy.risk_acceptance_id, RISK, `${name} risk_acceptance_id`);
  return Object.freeze({
    roles: Object.freeze(roles),
    policy: Object.freeze({ ...value.policy }),
  });
}

export function validateOwnership(value) {
  exact(value, ROOT_FIELDS, 'ownership');
  if (value.schema !== 'ue-codebase-mcp/ownership' || value.version !== 1 || !['solo', 'team'].includes(value.active_mode)) {
    throw new TypeError('ownership header is invalid');
  }
  const rawIdentities = object(value.identities, 'identities');
  const identities = {};
  for (const [id, identity] of Object.entries(rawIdentities)) identities[id] = validateIdentity(id, identity);
  if (Object.keys(identities).length < 2) throw new TypeError('at least two identities are required');
  exact(value.modes, ['solo', 'team'], 'modes');
  const modes = Object.freeze({
    solo: validateMode('solo', value.modes.solo, identities),
    team: validateMode('team', value.modes.team, identities),
  });
  const solo = modes.solo;
  if (solo.policy.assurance_level !== 'self_attested' || solo.policy.separation_required
      || solo.policy.phase_1_g1_eligible || solo.policy.risk_acceptance_id === 'NOT_APPLICABLE') {
    throw new TypeError('solo policy must remain self-attested and G1-ineligible');
  }
  const team = modes.team;
  if (team.policy.assurance_level !== 'independently_approved' || !team.policy.separation_required
      || !team.policy.phase_1_g1_eligible || team.policy.risk_acceptance_id !== 'NOT_APPLICABLE') {
    throw new TypeError('team policy must require independent approval and role separation');
  }
  const active = modes[value.active_mode];
  const activeIdentityIds = ROLE_FIELDS.map((role) => active.roles[role]);
  for (const identityId of activeIdentityIds) {
    if (!identities[identityId].configured) throw new TypeError('active mode references an unconfigured identity');
  }
  if (value.active_mode === 'solo') {
    if (activeIdentityIds.some((id) => identities[id].kind !== 'human')) throw new TypeError('solo roles must resolve to humans');
  } else {
    if (new Set(activeIdentityIds).size !== ROLE_FIELDS.length) throw new TypeError('team roles must resolve to distinct identities');
    if (activeIdentityIds.some((id) => identities[id].kind !== 'team'
        || !identities[id].principal.startsWith('github-team:'))) throw new TypeError('team roles must resolve to configured GitHub teams');
  }
  const resolvedRoles = Object.fromEntries(ROLE_FIELDS.map((role) => {
    const identityId = active.roles[role];
    return [role, Object.freeze({ identity_id: identityId, ...identities[identityId] })];
  }));
  return Object.freeze({
    schema: value.schema,
    version: value.version,
    active_mode: value.active_mode,
    assurance_level: active.policy.assurance_level,
    phase_1_g1_eligible: active.policy.phase_1_g1_eligible,
    risk_acceptance_id: active.policy.risk_acceptance_id,
    roles: Object.freeze(resolvedRoles),
  });
}

async function main() {
  const path = process.argv[2] ?? 'docs/governance/ownership.json';
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  process.stdout.write(`${JSON.stringify(validateOwnership(parsed), null, 2)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
