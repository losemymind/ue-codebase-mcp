import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = (await readFile(path.join(root, 'VERSION'), 'utf8')).trim();
const errors = [];
if (pkg.version !== version) errors.push(`VERSION (${version}) does not match package.json (${pkg.version})`);
if (!/^\d+\.\d+\.\d+$/.test(version)) errors.push('VERSION must be stable SemVer');
if (!pkg.private) errors.push('root package must remain private');
if (Object.keys(pkg.dependencies ?? {}).length > 0) errors.push('new runtime dependencies require explicit review');
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`release policy passed for ${version}`);
}

