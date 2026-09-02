import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadNativeRuntimePolicy } from '../lib/native-runtime.mjs';

const root = process.cwd();
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const allowlist = new Set(JSON.parse(await readFile(path.join(root, 'tools/license-audit/allowlist.json'), 'utf8')).allowed);
const noticePolicy = JSON.parse(await readFile(path.join(root, 'tools/license-audit/notices.json'), 'utf8'));
const violations = [];
if (noticePolicy.schema !== 'ue-codebase-mcp/npm-notices' || noticePolicy.version !== 1 || !Array.isArray(noticePolicy.packages)) {
  violations.push('npm notice policy is invalid');
}
const notices = new Map();
for (const item of noticePolicy.packages ?? []) {
  if (typeof item !== 'object' || item === null || Object.keys(item).sort().join(',') !== 'license,name,version'
      || typeof item.name !== 'string' || typeof item.version !== 'string' || typeof item.license !== 'string'
      || notices.has(item.name)) {
    violations.push('npm notice policy contains an invalid or duplicate package');
    continue;
  }
  notices.set(item.name, item);
}
const lockedPackages = new Set();
for (const [name, metadata] of Object.entries(lock.packages ?? {})) {
  // The root and workspace paths are first-party private source; linked workspace
  // entries do not represent downloadable third-party dependencies.
  if (name === '' || metadata.link || !name.startsWith('node_modules/')) continue;
  const packageName = metadata.name ?? name.replace(/^node_modules\//, '');
  lockedPackages.add(packageName);
  const license = metadata.license;
  if (!license || !allowlist.has(license)) violations.push(`${name || '<root>'}: ${license ?? 'UNKNOWN'}`);
  const notice = notices.get(packageName);
  if (notice === undefined || notice.version !== metadata.version || notice.license !== license) {
    violations.push(`${packageName}: npm notice is missing or does not match the lockfile`);
  }
}
for (const packageName of notices.keys()) {
  if (!lockedPackages.has(packageName)) violations.push(`${packageName}: npm notice has no matching locked package`);
}
const nativePolicy = await loadNativeRuntimePolicy(path.join(root, 'workers/clang-indexer/native/runtime-policy.json'));
if (!allowlist.has(nativePolicy.component.license_expression)) {
  violations.push(`native:${nativePolicy.component.name}: ${nativePolicy.component.license_expression}`);
}
if (violations.length > 0) {
  console.error(`Dependency license policy violations:\n${violations.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('dependency license policy passed');
}
