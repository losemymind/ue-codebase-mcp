import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const allowlist = new Set(JSON.parse(await readFile(path.join(root, 'tools/license-audit/allowlist.json'), 'utf8')).allowed);
const violations = [];
for (const [name, metadata] of Object.entries(lock.packages ?? {})) {
  // The root and workspace paths are first-party private source; linked workspace
  // entries do not represent downloadable third-party dependencies.
  if (name === '' || metadata.link || !name.startsWith('node_modules/')) continue;
  const license = metadata.license;
  if (!license || !allowlist.has(license)) violations.push(`${name || '<root>'}: ${license ?? 'UNKNOWN'}`);
}
if (violations.length > 0) {
  console.error(`Dependency license policy violations:\n${violations.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('dependency license policy passed');
}
