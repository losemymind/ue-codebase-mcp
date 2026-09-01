import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validateOwnership } from './validate-ownership.mjs';

const CONFIG_PATH = 'docs/governance/ownership.json';
const CODEOWNERS_PATH = '.github/CODEOWNERS';
const GITHUB_USER = /^github:([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)$/;
const GITHUB_TEAM = /^github-team:([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9-]{0,99})$/;

function codeOwner(principal) {
  const match = GITHUB_USER.exec(principal) ?? GITHUB_TEAM.exec(principal);
  if (match === null) throw new TypeError('active ownership principal is not a GitHub user or team');
  return `@${match[1]}`;
}

export function renderCodeowners(ownership) {
  const resolved = validateOwnership(ownership);
  const owner = (role) => codeOwner(resolved.roles[role].principal);
  const technical = owner('control_plane_technical_owner');
  const security = owner('security_release_approver');
  const operations = owner('deployment_operator');
  const gate = owner('g1_gate_approver');
  return [
    '# Generated from docs/governance/ownership.json by npm run governance:sync.',
    '# Review routing does not replace assurance or separation checks.',
    `* ${technical}`,
    `/apps/mcp-server/ ${technical}`,
    `/services/ ${technical}`,
    `/packages/ ${technical}`,
    `/deploy/ ${operations}`,
    `/deploy/compose/control-plane-approval.example.json ${security}`,
    `/deploy/compose/control-plane-approval.schema.json ${security}`,
    `/docs/governance/ ${gate}`,
    `/.github/ ${security}`,
    '',
  ].join('\n');
}

async function main() {
  const action = process.argv[2] ?? '--check';
  if (!['--check', '--write'].includes(action) || process.argv.length > 3) {
    throw new TypeError('usage: node tools/sync-codeowners.mjs [--check|--write]');
  }
  const ownership = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  const expected = renderCodeowners(ownership);
  if (action === '--write') {
    await writeFile(CODEOWNERS_PATH, expected, 'utf8');
    process.stdout.write(`updated ${CODEOWNERS_PATH}\n`);
    return;
  }
  const actual = await readFile(CODEOWNERS_PATH, 'utf8');
  if (actual !== expected) throw new TypeError(`${CODEOWNERS_PATH} is not synchronized with ${CONFIG_PATH}`);
  process.stdout.write(`${CODEOWNERS_PATH} is synchronized\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
