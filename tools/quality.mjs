import { readTextFiles } from './lib/files.mjs';

const mode = process.argv[2];
if (!['format', 'lint'].includes(mode)) throw new Error('Usage: node tools/quality.mjs <format|lint>');

const failures = [];
for (const file of await readTextFiles()) {
  if (file.text.includes('\r')) failures.push(`${file.relative}: CR characters are not allowed`);
  if (!file.text.endsWith('\n')) failures.push(`${file.relative}: missing final newline`);
  if (file.text.split('\n').some((line) => /[ \t]+$/.test(line))) failures.push(`${file.relative}: trailing whitespace`);
  if (mode === 'lint') {
    if (/\beval\s*\(/.test(file.text)) failures.push(`${file.relative}: eval is forbidden`);
    if (/child_process/.test(file.text) && !file.relative.startsWith('workers/')) failures.push(`${file.relative}: process execution is restricted to reviewed workers`);
    if (/BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/.test(file.text)) failures.push(`${file.relative}: private key material detected`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`${mode} check passed`);
}

