import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const components = Object.entries(lock.packages ?? {}).filter(([name]) => name !== '').map(([name, pkg]) => ({
  type: 'library',
  name: pkg.name ?? name.replace(/^node_modules\//, ''),
  version: pkg.version,
  licenses: pkg.license ? [{ license: { id: pkg.license } }] : [],
}));
const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: { component: { type: 'application', name: lock.name, version: lock.version } },
  components,
};
const output = path.join(root, 'reports/generated');
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'sbom.cdx.json'), `${JSON.stringify(bom, null, 2)}\n`, 'utf8');
console.log(`generated CycloneDX SBOM with ${components.length} dependencies`);

