import { createPublicKey, verify } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { authenticationFailed, type Clock, isRecord, systemClock } from './common.ts';

const MAX_JWT_BYTES = 16_384;
const MAX_JWKS_KEYS = 128;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export interface OidcProvider {
  id: string;
  issuer: string;
  audiences: readonly string[];
  jwksUri: string;
  allowedAlgorithms: readonly ['RS256'] | readonly string[];
  jwksCacheTtlMs: number;
  clockSkewSeconds?: number;
}

export interface JwksFetcher {
  fetchJwks(provider: Readonly<OidcProvider>): Promise<unknown>;
}

interface RsaJwk {
  kty: 'RSA';
  kid: string;
  alg: 'RS256';
  n: string;
  e: string;
  use?: 'sig';
  key_ops?: readonly string[];
}

interface CachedJwks {
  expiresAt: number;
  keys: ReadonlyMap<string, RsaJwk>;
}

export interface OidcIdentity {
  kind: 'oidc';
  subject: string;
  issuer: string;
  audience: readonly string[];
  scopes: readonly string[];
  issuedAt?: number;
  expiresAt: number;
}

function boundedString(value: unknown, maximum = 512): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : undefined;
}

function validateProvider(provider: OidcProvider): void {
  try {
    const issuer = new URL(provider.issuer);
    const jwks = new URL(provider.jwksUri);
    if (issuer.protocol !== 'https:' || jwks.protocol !== 'https:' || issuer.username || issuer.password || jwks.username || jwks.password) {
      authenticationFailed();
    }
  } catch {
    authenticationFailed();
  }
  if (!boundedString(provider.id, 128) || provider.audiences.length === 0 || provider.audiences.length > 16) authenticationFailed();
  if (new Set(provider.audiences).size !== provider.audiences.length || provider.audiences.some((value) => !boundedString(value))) authenticationFailed();
  if (provider.allowedAlgorithms.length !== 1 || provider.allowedAlgorithms[0] !== 'RS256') authenticationFailed();
  if (!Number.isSafeInteger(provider.jwksCacheTtlMs) || provider.jwksCacheTtlMs < 1_000 || provider.jwksCacheTtlMs > 86_400_000) authenticationFailed();
  if (provider.clockSkewSeconds !== undefined && (!Number.isSafeInteger(provider.clockSkewSeconds) || provider.clockSkewSeconds < 0 || provider.clockSkewSeconds > 300)) authenticationFailed();
}

function decodeBase64Url(segment: string, maximumBytes: number): Buffer {
  if (segment.length === 0 || segment.length > maximumBytes * 2 || !/^[A-Za-z0-9_-]+$/.test(segment)) authenticationFailed();
  let decoded: Buffer;
  try {
    decoded = Buffer.from(segment, 'base64url');
  } catch {
    authenticationFailed();
  }
  if (decoded.length === 0 || decoded.length > maximumBytes || decoded.toString('base64url') !== segment) authenticationFailed();
  return decoded;
}

function hasDuplicateTopLevelKeys(text: string): boolean {
  const keys = new Set<string>();
  let depth = 0;
  let index = 0;
  let expectKey = false;
  while (index < text.length) {
    const character = text[index];
    if (character === '{') {
      depth += 1;
      if (depth === 1) expectKey = true;
      index += 1;
      continue;
    }
    if (character === '}') {
      depth -= 1;
      index += 1;
      continue;
    }
    if (character === '[') {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === ']') {
      depth -= 1;
      index += 1;
      continue;
    }
    if (character === ',' && depth === 1) {
      expectKey = true;
      index += 1;
      continue;
    }
    if (character === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < text.length) {
        const current = text[index];
        if (!escaped && current === '"') break;
        escaped = !escaped && current === '\\';
        if (current !== '\\') escaped = false;
        index += 1;
      }
      if (index >= text.length) return true;
      const encoded = text.slice(start, index + 1);
      index += 1;
      if (depth === 1 && expectKey) {
        while (/\s/.test(text[index] ?? '')) index += 1;
        if (text[index] !== ':') return true;
        let key: unknown;
        try {
          key = JSON.parse(encoded);
        } catch {
          return true;
        }
        if (typeof key !== 'string' || keys.has(key)) return true;
        keys.add(key);
        expectKey = false;
      }
      continue;
    }
    index += 1;
  }
  return depth !== 0;
}

function parseJsonObject(segment: string, maximumBytes: number): Record<string, unknown> {
  const bytes = decodeBase64Url(segment, maximumBytes);
  let text: string;
  try {
    text = utf8Decoder.decode(bytes);
  } catch {
    authenticationFailed();
  }
  if (hasDuplicateTopLevelKeys(text)) authenticationFailed();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    authenticationFailed();
  }
  if (!isRecord(parsed)) authenticationFailed();
  return parsed;
}

function eligibleJwk(value: unknown): RsaJwk | undefined {
  if (!isRecord(value)) return undefined;
  const kid = boundedString(value.kid, 128);
  const modulus = boundedString(value.n, 2_048);
  const exponent = boundedString(value.e, 16);
  if (value.kty !== 'RSA' || value.alg !== 'RS256' || !kid || !modulus || !exponent) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(modulus) || !/^[A-Za-z0-9_-]+$/.test(exponent)) return undefined;
  if (value.use !== undefined && value.use !== 'sig') return undefined;
  if (value.key_ops !== undefined) {
    if (!Array.isArray(value.key_ops) || value.key_ops.some((operation) => typeof operation !== 'string') || !value.key_ops.includes('verify')) return undefined;
  }
  for (const privatePart of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth']) {
    if (value[privatePart] !== undefined) return undefined;
  }
  return { kty: 'RSA', kid, alg: 'RS256', n: modulus, e: exponent, ...(value.use === 'sig' ? { use: 'sig' as const } : {}), ...(Array.isArray(value.key_ops) ? { key_ops: Object.freeze([...value.key_ops] as string[]) } : {}) };
}

function parseJwks(value: unknown): ReadonlyMap<string, RsaJwk> {
  if (!isRecord(value) || !Array.isArray(value.keys) || value.keys.length === 0 || value.keys.length > MAX_JWKS_KEYS) authenticationFailed();
  const keys = new Map<string, RsaJwk>();
  for (const candidate of value.keys) {
    const key = eligibleJwk(candidate);
    if (!key) continue;
    const cacheKey = `${key.alg}\u0000${key.kid}`;
    if (keys.has(cacheKey)) authenticationFailed();
    keys.set(cacheKey, Object.freeze(key));
  }
  if (keys.size === 0) authenticationFailed();
  return keys;
}

export class JwksCache {
  readonly #fetcher: JwksFetcher;
  readonly #clock: Clock;
  readonly #cache = new Map<string, CachedJwks>();
  readonly #pending = new Map<string, Promise<CachedJwks>>();

  constructor(fetcher: JwksFetcher, clock: Clock = systemClock) {
    this.#fetcher = fetcher;
    this.#clock = clock;
  }

  hasFresh(provider: OidcProvider): boolean {
    const cached = this.#cache.get(provider.id);
    return cached !== undefined && this.#clock.now() < cached.expiresAt;
  }

  peek(provider: OidcProvider, kid: string, algorithm: string): RsaJwk | undefined {
    const cached = this.#cache.get(provider.id);
    if (!cached || this.#clock.now() >= cached.expiresAt) return undefined;
    return cached.keys.get(`${algorithm}\u0000${kid}`);
  }

  async refresh(provider: OidcProvider): Promise<void> {
    const existing = this.#pending.get(provider.id);
    if (existing) {
      await existing;
      return;
    }
    const pending = (async (): Promise<CachedJwks> => {
      const value = await this.#fetcher.fetchJwks(Object.freeze({ ...provider, audiences: Object.freeze([...provider.audiences]), allowedAlgorithms: Object.freeze([...provider.allowedAlgorithms]) }));
      const cached = Object.freeze({ expiresAt: this.#clock.now() + provider.jwksCacheTtlMs, keys: parseJwks(value) });
      this.#cache.set(provider.id, cached);
      return cached;
    })();
    this.#pending.set(provider.id, pending);
    try {
      await pending;
    } finally {
      this.#pending.delete(provider.id);
    }
  }

  async resolve(provider: OidcProvider, kid: string, algorithm: string): Promise<RsaJwk> {
    const fresh = this.hasFresh(provider);
    const cached = this.peek(provider, kid, algorithm);
    if (cached) return cached;
    await this.refresh(provider);
    const refreshed = this.peek(provider, kid, algorithm);
    if (!refreshed) authenticationFailed();
    if (fresh && refreshed === cached) authenticationFailed();
    return refreshed;
  }
}

function validateHeader(header: Record<string, unknown>): { algorithm: 'RS256'; kid: string } {
  const allowed = new Set(['alg', 'kid', 'typ']);
  if (Object.keys(header).some((key) => !allowed.has(key))) authenticationFailed();
  if (header.alg !== 'RS256' || (header.typ !== undefined && header.typ !== 'JWT')) authenticationFailed();
  const kid = boundedString(header.kid, 128);
  if (!kid || !/^[A-Za-z0-9_.:-]+$/.test(kid)) authenticationFailed();
  return { algorithm: 'RS256', kid };
}

function claimNumber(value: unknown, required: boolean): number | undefined {
  if (value === undefined && !required) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) authenticationFailed();
  return value as number;
}

function claimAudience(value: unknown): string[] {
  const values = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(values) || values.length === 0 || values.length > 16 || values.some((item) => !boundedString(item))) authenticationFailed();
  if (new Set(values).size !== values.length) authenticationFailed();
  return values as string[];
}

function claimScopes(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value !== 'string' || value.length > 4_096) authenticationFailed();
  const scopes = value.length === 0 ? [] : value.split(' ');
  if (scopes.length > 64 || scopes.some((scope) => !/^[A-Za-z0-9:_-]{1,128}$/.test(scope)) || new Set(scopes).size !== scopes.length) authenticationFailed();
  return scopes;
}

function validateClaims(claims: Record<string, unknown>, provider: OidcProvider, nowMs: number): OidcIdentity {
  const subject = boundedString(claims.sub);
  const issuer = boundedString(claims.iss, 2_048);
  if (!subject || issuer !== provider.issuer) authenticationFailed();
  const audience = claimAudience(claims.aud);
  const matched = audience.filter((value) => provider.audiences.includes(value));
  if (matched.length === 0) authenticationFailed();
  if (audience.length > 1 && (!boundedString(claims.azp) || !provider.audiences.includes(claims.azp as string))) authenticationFailed();
  const expiration = claimNumber(claims.exp, true) as number;
  const notBefore = claimNumber(claims.nbf, false);
  const issuedAt = claimNumber(claims.iat, false);
  const now = Math.floor(nowMs / 1_000);
  const skew = provider.clockSkewSeconds ?? 60;
  if (now >= expiration + skew) authenticationFailed();
  if (notBefore !== undefined && now + skew < notBefore) authenticationFailed();
  if (issuedAt !== undefined && issuedAt > now + skew) authenticationFailed();
  return Object.freeze({ kind: 'oidc', subject, issuer, audience: Object.freeze(audience), scopes: Object.freeze(claimScopes(claims.scope)), ...(issuedAt === undefined ? {} : { issuedAt }), expiresAt: expiration });
}

function verifies(signingInput: string, signature: Buffer, jwk: RsaJwk): boolean {
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const modulusLength = key.asymmetricKeyDetails?.modulusLength;
    if (typeof modulusLength !== 'number' || modulusLength < 2_048) return false;
    return verify('RSA-SHA256', Buffer.from(signingInput, 'ascii'), key, signature);
  } catch {
    return false;
  }
}

export class OidcJwtVerifier {
  readonly #provider: OidcProvider;
  readonly #cache: JwksCache;
  readonly #clock: Clock;

  constructor(provider: OidcProvider, fetcher: JwksFetcher, clock: Clock = systemClock) {
    validateProvider(provider);
    this.#provider = Object.freeze({ ...provider, audiences: Object.freeze([...provider.audiences]), allowedAlgorithms: Object.freeze([...provider.allowedAlgorithms]) });
    this.#clock = clock;
    this.#cache = new JwksCache(fetcher, clock);
  }

  async verify(token: string): Promise<OidcIdentity> {
    try {
      if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') > MAX_JWT_BYTES || token.includes('\r') || token.includes('\n')) authenticationFailed();
      const segments = token.split('.');
      if (segments.length !== 3) authenticationFailed();
      const header = validateHeader(parseJsonObject(segments[0], 2_048));
      const claims = parseJsonObject(segments[1], 12_288);
      const signature = decodeBase64Url(segments[2], 1_024);
      const signingInput = `${segments[0]}.${segments[1]}`;
      const key = await this.#cache.resolve(this.#provider, header.kid, header.algorithm);
      if (!verifies(signingInput, signature, key)) {
        await this.#cache.refresh(this.#provider);
        const rotated = this.#cache.peek(this.#provider, header.kid, header.algorithm);
        if (!rotated || !verifies(signingInput, signature, rotated)) authenticationFailed();
      }
      return validateClaims(claims, this.#provider, this.#clock.now());
    } catch {
      authenticationFailed();
    }
  }
}
