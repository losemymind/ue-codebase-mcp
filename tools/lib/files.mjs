import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const excludedDirectories = new Set(['.git', 'node_modules', 'dist', 'coverage', 'artifacts']);
export const textExtensions = new Set([
  '.cjs', '.cpp', '.css', '.h', '.hpp', '.html', '.js', '.json', '.md', '.mjs', '.ps1', '.sql', '.ts', '.yaml', '.yml',
]);

export async function walk(root = process.cwd()) {
  const result = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.push(absolute);
    }
  }
  await visit(root);
  return result;
}

export async function readTextFiles(root = process.cwd()) {
  const files = await walk(root);
  const output = [];
  for (const absolute of files) {
    if (!textExtensions.has(path.extname(absolute).toLowerCase()) && !['VERSION', '.editorconfig', '.gitattributes', '.gitignore', '.npmrc'].includes(path.basename(absolute))) continue;
    if ((await stat(absolute)).size > 2_000_000) continue;
    output.push({ absolute, relative: path.relative(root, absolute).replaceAll('\\', '/'), text: await readFile(absolute, 'utf8') });
  }
  return output;
}

