import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
await mkdir(dist, { recursive: true });
for (const file of ['VERSION', 'LICENSE_POLICY.md', 'SECURITY.md']) {
  await cp(path.join(root, file), path.join(dist, file));
}
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = {
  name: packageJson.name,
  version: packageJson.version,
  node: packageJson.engines.node,
  sourceDateEpoch: process.env.SOURCE_DATE_EPOCH ?? '0',
};
await writeFile(path.join(dist, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`built ${manifest.name}@${manifest.version}`);

