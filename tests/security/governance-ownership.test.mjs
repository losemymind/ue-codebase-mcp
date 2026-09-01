import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateOwnership } from '../../tools/validate-ownership.mjs';

const source = JSON.parse(await readFile('docs/governance/ownership.json', 'utf8'));
const clone = () => structuredClone(source);

test('solo governance resolves every active role to LIBO without claiming independent G1 approval', () => {
  const resolved = validateOwnership(source);
  assert.equal(resolved.active_mode, 'solo');
  assert.equal(resolved.assurance_level, 'self_attested');
  assert.equal(resolved.phase_1_g1_eligible, false);
  assert.equal(resolved.risk_acceptance_id, 'PERSONAL-1');
  for (const identity of Object.values(resolved.roles)) {
    assert.equal(identity.identity_id, 'personal_libo');
    assert.equal(identity.display_name, 'LIBO');
    assert.equal(identity.principal, 'github:losemymind');
  }
});

test('team mode fails closed until every predeclared GitHub team is configured', () => {
  const value = clone();
  value.active_mode = 'team';
  assert.throws(() => validateOwnership(value), /active mode references an unconfigured identity/);
});

test('one active_mode change selects configured separated team roles', () => {
  const value = clone();
  const teams = {
    team_control_plane: 'github-team:example/control-plane',
    team_security: 'github-team:example/security',
    team_operations: 'github-team:example/operations',
    team_quality: 'github-team:example/quality',
    team_g1_reviewers: 'github-team:example/g1-reviewers',
  };
  for (const [id, principal] of Object.entries(teams)) {
    value.identities[id].principal = principal;
    value.identities[id].configured = true;
  }
  value.active_mode = 'team';
  const resolved = validateOwnership(value);
  assert.equal(resolved.assurance_level, 'independently_approved');
  assert.equal(resolved.phase_1_g1_eligible, true);
  assert.equal(new Set(Object.values(resolved.roles).map((identity) => identity.identity_id)).size, 5);
});

test('governance rejects weakened mode policy, role collapse, placeholders, and extensions', () => {
  const weakened = clone();
  weakened.modes.solo.policy.phase_1_g1_eligible = true;
  assert.throws(() => validateOwnership(weakened), /solo policy must remain self-attested and G1-ineligible/);

  const placeholder = clone();
  placeholder.identities.team_control_plane.configured = true;
  assert.throws(() => validateOwnership(placeholder), /cannot configure a placeholder principal/);

  const extended = clone();
  extended.modes.solo.roles.repository_admin = 'personal_libo';
  assert.throws(() => validateOwnership(extended), /solo roles must contain exact fields/);
});
