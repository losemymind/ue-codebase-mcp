import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { authenticationFailed, credentialOperationFailed, type Clock, systemClock } from './common.ts';

const TOKEN_PREFIX = 'uemcp_v1';
const TOKEN_PATTERN = /^uemcp_v1\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;
const HASH_VERSION = 1;
const HASH_BYTES = 58;
const SALT_OFFSET = 10;
const DIGEST_OFFSET = 26;

export type TokenOwnerType = 'user' | 'service';

export interface BearerTokenRecord {
  id: string;
  ownerType: TokenOwnerType;
  ownerId: string;
  tokenHash: Uint8Array;
  scopes: readonly string[];
  expiresAt: number;
  revokedAt: number | null;
  createdAt: number;
}

export interface BearerTokenRepository {
  findById(id: string): Promise<BearerTokenRecord | null>;
  insert(record: Readonly<BearerTokenRecord>): Promise<void>;
  replace(currentId: string, replacement: Readonly<BearerTokenRecord>, revokedAt: number): Promise<void>;
  revoke(id: string, revokedAt: number): Promise<void>;
}

export interface IssueBearerTokenInput {
  ownerType: TokenOwnerType;
  ownerId: string;
  scopes: readonly string[];
  expiresAt: number;
}

export interface IssuedBearerToken {
  token: string;
  record: Readonly<BearerTokenRecord>;
}

export interface BearerIdentity {
  kind: 'bearer';
  tokenId: string;
  ownerType: TokenOwnerType;
  ownerId: string;
  scopes: readonly string[];
  expiresAt: number;
}

interface ScryptParameters {
  logN: number;
  r: number;
  p: number;
}

function validBoundedString(value: unknown, maximum = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function validateIssue(input: IssueBearerTokenInput, now: number): void {
  if (!['user', 'service'].includes(input.ownerType) || !validBoundedString(input.ownerId)) credentialOperationFailed();
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now || input.expiresAt > now + 366 * 24 * 60 * 60 * 1_000) credentialOperationFailed();
  if (!Array.isArray(input.scopes) || input.scopes.length > 64 || input.scopes.some((scope) => !/^[A-Za-z0-9:_-]{1,128}$/.test(scope)) || new Set(input.scopes).size !== input.scopes.length) credentialOperationFailed();
}

function parseAuthorizationHeader(header: string): string {
  if (typeof header !== 'string' || header.length > 512 || header.includes('\r') || header.includes('\n')) authenticationFailed();
  const match = /^Bearer ([A-Za-z0-9._-]+)$/i.exec(header);
  if (!match) authenticationFailed();
  return match[1];
}

function parseToken(token: string): { id: string; secret: string } {
  const match = TOKEN_PATTERN.exec(token);
  if (!match) authenticationFailed();
  return { id: match[1], secret: match[2] };
}

function parseHash(value: Uint8Array): { parameters: ScryptParameters; salt: Buffer; digest: Buffer } | undefined {
  const buffer = Buffer.from(value);
  if (buffer.length !== HASH_BYTES || buffer[0] !== HASH_VERSION) return undefined;
  const parameters = { logN: buffer[1], r: buffer.readUInt32BE(2), p: buffer.readUInt32BE(6) };
  if (parameters.logN < 14 || parameters.logN > 20 || parameters.r < 8 || parameters.r > 32 || parameters.p < 1 || parameters.p > 8) return undefined;
  return { parameters, salt: buffer.subarray(SALT_OFFSET, DIGEST_OFFSET), digest: buffer.subarray(DIGEST_OFFSET) };
}

function packHash(parameters: ScryptParameters, salt: Buffer, digest: Buffer): Uint8Array {
  const output = Buffer.alloc(HASH_BYTES);
  output[0] = HASH_VERSION;
  output[1] = parameters.logN;
  output.writeUInt32BE(parameters.r, 2);
  output.writeUInt32BE(parameters.p, 6);
  salt.copy(output, SALT_OFFSET);
  digest.copy(output, DIGEST_OFFSET);
  return new Uint8Array(output);
}

function derive(secret: string, tokenId: string, salt: Buffer, pepper: Buffer, parameters: ScryptParameters): Promise<Buffer> {
  const effectiveSalt = createHmac('sha256', pepper).update(salt).update(tokenId, 'utf8').digest();
  const N = 2 ** parameters.logN;
  return new Promise((resolve, reject) => {
    scrypt(secret, effectiveSalt, 32, { N, r: parameters.r, p: parameters.p, maxmem: Math.max(64 * 1024 * 1024, 256 * N * parameters.r) }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function validRecord(record: BearerTokenRecord, id: string): boolean {
  return record.id === id && ['user', 'service'].includes(record.ownerType) && validBoundedString(record.ownerId) && Number.isSafeInteger(record.expiresAt) && Number.isSafeInteger(record.createdAt) && (record.revokedAt === null || Number.isSafeInteger(record.revokedAt)) && Array.isArray(record.scopes);
}

export class BearerTokenService {
  readonly #repository: BearerTokenRepository;
  readonly #pepper: Buffer;
  readonly #clock: Clock;
  readonly #parameters: ScryptParameters = Object.freeze({ logN: 14, r: 8, p: 1 });
  readonly #dummySalt = Buffer.alloc(16, 0xa5);

  constructor(repository: BearerTokenRepository, pepper: Uint8Array, clock: Clock = systemClock) {
    if (!(pepper instanceof Uint8Array) || pepper.byteLength < 32) credentialOperationFailed();
    this.#repository = repository;
    this.#pepper = Buffer.from(pepper);
    this.#clock = clock;
  }

  async #makeRecord(input: IssueBearerTokenInput): Promise<IssuedBearerToken> {
    const now = this.#clock.now();
    validateIssue(input, now);
    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const token = `${TOKEN_PREFIX}.${id}.${secret}`;
    const salt = randomBytes(16);
    const digest = await derive(secret, id, salt, this.#pepper, this.#parameters);
    const record: BearerTokenRecord = Object.freeze({ id, ownerType: input.ownerType, ownerId: input.ownerId, tokenHash: packHash(this.#parameters, salt, digest), scopes: Object.freeze([...input.scopes]), expiresAt: input.expiresAt, revokedAt: null, createdAt: now });
    return Object.freeze({ token, record });
  }

  async issue(input: IssueBearerTokenInput): Promise<IssuedBearerToken> {
    try {
      const issued = await this.#makeRecord(input);
      await this.#repository.insert(issued.record);
      return issued;
    } catch {
      credentialOperationFailed();
    }
  }

  async rotate(currentId: string, expiresAt: number): Promise<IssuedBearerToken> {
    try {
      const now = this.#clock.now();
      const current = await this.#repository.findById(currentId);
      if (!current || !validRecord(current, currentId) || current.revokedAt !== null || current.expiresAt <= now) credentialOperationFailed();
      const replacement = await this.#makeRecord({ ownerType: current.ownerType, ownerId: current.ownerId, scopes: current.scopes, expiresAt });
      await this.#repository.replace(current.id, replacement.record, now);
      return replacement;
    } catch {
      credentialOperationFailed();
    }
  }

  async revoke(id: string): Promise<void> {
    try {
      if (!TOKEN_PATTERN.test(`${TOKEN_PREFIX}.${id}.${'A'.repeat(43)}`)) credentialOperationFailed();
      await this.#repository.revoke(id, this.#clock.now());
    } catch {
      credentialOperationFailed();
    }
  }

  async authenticate(authorizationHeader: string): Promise<BearerIdentity> {
    try {
      const token = parseAuthorizationHeader(authorizationHeader);
      const parsed = parseToken(token);
      const record = await this.#repository.findById(parsed.id);
      if (!record) {
        await derive(parsed.secret, parsed.id, this.#dummySalt, this.#pepper, this.#parameters);
        authenticationFailed();
      }
      const stored = parseHash(record.tokenHash);
      if (!stored || !validRecord(record, parsed.id)) authenticationFailed();
      const candidate = await derive(parsed.secret, parsed.id, stored.salt, this.#pepper, stored.parameters);
      if (!timingSafeEqual(candidate, stored.digest)) authenticationFailed();
      const now = this.#clock.now();
      if (record.revokedAt !== null || record.expiresAt <= now || record.createdAt > now) authenticationFailed();
      return Object.freeze({ kind: 'bearer', tokenId: record.id, ownerType: record.ownerType, ownerId: record.ownerId, scopes: Object.freeze([...record.scopes]), expiresAt: record.expiresAt });
    } catch {
      authenticationFailed();
    }
  }
}
