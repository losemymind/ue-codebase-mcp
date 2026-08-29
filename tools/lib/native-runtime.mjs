import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const HASH = /^[a-f0-9]{64}$/;
const LICENSE = /^[A-Za-z0-9-.+]+(?: WITH [A-Za-z0-9-.+]+)?$/;

function object(value, name) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function exactKeys(value, required, name) {
  if (Object.keys(value).some((key) => !required.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${name} fields are invalid`);
  }
}

function text(value, name, maximum = 256) {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\r\n\0]/.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function boundedInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function readBoundedFile(file, maximum, name) {
  const metadata = await lstat(file).catch(() => { throw new TypeError(`${name} is unavailable`); });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximum) throw new TypeError(`${name} is invalid`);
  return readFile(file);
}

export function below(root, value, name) {
  if (!path.isAbsolute(root) || !path.isAbsolute(value)) throw new TypeError(`${name} must be absolute`);
  const relative = path.relative(path.resolve(root), path.resolve(value));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new TypeError(`${name} escapes its configured root`);
  return path.resolve(value);
}

export async function canonicalFile(file, name) {
  if (!path.isAbsolute(file)) throw new TypeError(`${name} must be absolute`);
  return realpath(file).catch(() => { throw new TypeError(`${name} is unavailable`); });
}

export async function loadNativeRuntimePolicy(file) {
  const encoded = await readBoundedFile(file, 64 * 1024, 'native runtime policy');
  let parsed;
  try { parsed = JSON.parse(encoded.toString('utf8')); } catch { throw new TypeError('native runtime policy JSON is invalid'); }
  const policy = object(parsed, 'native runtime policy');
  exactKeys(policy, ['schema_version', 'component', 'runtime', 'notices'], 'native runtime policy');
  if (policy.schema_version !== 1) throw new TypeError('native runtime policy version is invalid');
  const component = object(policy.component, 'native runtime component');
  exactKeys(component, ['type', 'name', 'version', 'supplier', 'license_expression'], 'native runtime component');
  if (component.type !== 'library') throw new TypeError('native runtime component type is invalid');
  const licenseExpression = text(component.license_expression, 'native runtime license');
  if (!LICENSE.test(licenseExpression)) throw new TypeError('native runtime license is invalid');
  const runtime = object(policy.runtime, 'native runtime input');
  exactKeys(runtime, ['relative_path', 'sha256', 'max_bytes'], 'native runtime input');
  const relativePath = text(runtime.relative_path, 'native runtime path', 1024);
  if (path.isAbsolute(relativePath) || relativePath !== 'bin/libclang.dll' || relativePath.includes('..')) throw new TypeError('native runtime path is invalid');
  const runtimeHash = text(runtime.sha256, 'native runtime hash');
  if (!HASH.test(runtimeHash)) throw new TypeError('native runtime hash is invalid');
  const notices = object(policy.notices, 'native runtime notices');
  exactKeys(notices, ['sha256', 'max_bytes', 'required_markers'], 'native runtime notices');
  const noticeHash = text(notices.sha256, 'native notice hash');
  if (!HASH.test(noticeHash) || !Array.isArray(notices.required_markers) || notices.required_markers.length < 3
      || notices.required_markers.length > 16 || notices.required_markers.some((marker) => typeof marker !== 'string' || !marker || marker.length > 256)) {
    throw new TypeError('native runtime notices are invalid');
  }
  return Object.freeze({
    schema_version: 1,
    component: Object.freeze({
      type: 'library',
      name: text(component.name, 'native runtime name'),
      version: text(component.version, 'native runtime version'),
      supplier: text(component.supplier, 'native runtime supplier'),
      license_expression: licenseExpression,
    }),
    runtime: Object.freeze({ relative_path: relativePath, sha256: runtimeHash, max_bytes: boundedInteger(runtime.max_bytes, 'native runtime byte limit', 512 * 1024 * 1024) }),
    notices: Object.freeze({
      sha256: noticeHash,
      max_bytes: boundedInteger(notices.max_bytes, 'native notice byte limit', 64 * 1024 * 1024),
      required_markers: Object.freeze([...notices.required_markers]),
    }),
  });
}

export function cyclonedxComponent(policy) {
  return {
    type: policy.component.type,
    name: policy.component.name,
    version: policy.component.version,
    supplier: { name: policy.component.supplier },
    licenses: [{ expression: policy.component.license_expression }],
    hashes: [{ alg: 'SHA-256', content: policy.runtime.sha256 }],
    properties: [{ name: 'ue-codebase-mcp:distribution', value: 'bundled-native-runtime' }],
  };
}
