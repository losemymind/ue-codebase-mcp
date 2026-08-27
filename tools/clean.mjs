import { rm } from 'node:fs/promises';
import path from 'node:path';

for (const directory of ['dist', 'coverage', 'artifacts', 'reports/generated']) {
  await rm(path.join(process.cwd(), directory), { recursive: true, force: true });
}
console.log('cleaned generated outputs');

