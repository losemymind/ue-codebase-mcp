import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CursorClock { now(): number }
export const cursorSystemClock: CursorClock = Object.freeze({ now: () => Date.now() });

export interface CursorBinding {
  readonly tool: string;
  readonly principal: string;
  readonly request_hash: string;
}

interface CursorPayload extends CursorBinding {
  readonly schema_version: 1;
  readonly position: string;
  readonly expires_at: number;
}

export class CursorError extends Error {
  readonly code = 'invalid-cursor';

  constructor() {
    super('cursor invalid-cursor');
    this.name = 'CursorError';
  }
}

const HASH = /^[a-f0-9]{64}$/;
const TOOL = /^[a-z][a-z0-9_]{0,63}$/;
const PRINCIPAL = /^[a-f0-9]{64}$/;
const POSITION = /^[A-Za-z0-9._:-]{1,2048}$/;
const TOKEN = /^[A-Za-z0-9_-]{8,3072}\.[A-Za-z0-9_-]{43}$/;
const MAX_TTL_MS = 15 * 60 * 1_000;

function invalid(): never {
  throw new CursorError();
}

function validBinding(binding: CursorBinding): boolean {
  return typeof binding === 'object' && binding !== null && TOOL.test(binding.tool)
    && PRINCIPAL.test(binding.principal) && HASH.test(binding.request_hash);
}

function signature(secret: Buffer, body: string): Buffer {
  return createHmac('sha256', secret).update('ue-codebase-mcp/cursor/v1\0').update(body, 'utf8').digest();
}

export class OpaqueCursorCodec {
  readonly #secret: Buffer;
  readonly #ttlMs: number;
  readonly #clock: CursorClock;

  constructor(secret: Uint8Array, ttlMs = 5 * 60 * 1_000, clock: CursorClock = cursorSystemClock) {
    if (!(secret instanceof Uint8Array) || secret.byteLength < 32 || !Number.isSafeInteger(ttlMs)
        || ttlMs < 1_000 || ttlMs > MAX_TTL_MS || typeof clock !== 'object' || clock === null || typeof clock.now !== 'function') invalid();
    this.#secret = Buffer.from(secret);
    this.#ttlMs = ttlMs;
    this.#clock = clock;
  }

  encode(binding: CursorBinding, position: string): string {
    if (!validBinding(binding) || typeof position !== 'string' || !POSITION.test(position)) invalid();
    const now = this.#clock.now();
    if (!Number.isSafeInteger(now) || now < 0) invalid();
    const payload: CursorPayload = Object.freeze({ schema_version: 1, tool: binding.tool, principal: binding.principal,
      request_hash: binding.request_hash, position, expires_at: now + this.#ttlMs });
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${body}.${signature(this.#secret, body).toString('base64url')}`;
  }

  decode(binding: CursorBinding, token: string): string {
    if (!validBinding(binding) || typeof token !== 'string' || !TOKEN.test(token)) invalid();
    const parts = token.split('.');
    if (parts.length !== 2) invalid();
    const candidate = Buffer.from(parts[1], 'base64url');
    const expected = signature(this.#secret, parts[0]);
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) invalid();
    let payload: unknown;
    try {
      const bytes = Buffer.from(parts[0], 'base64url');
      if (bytes.byteLength > 4096 || bytes.toString('base64url') !== parts[0]) invalid();
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      invalid();
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) invalid();
    const value = payload as Record<string, unknown>;
    if (Object.keys(value).some((key) => !['schema_version', 'tool', 'principal', 'request_hash', 'position', 'expires_at'].includes(key))
        || value.schema_version !== 1 || value.tool !== binding.tool || value.principal !== binding.principal
        || value.request_hash !== binding.request_hash || typeof value.position !== 'string' || !POSITION.test(value.position)
        || !Number.isSafeInteger(value.expires_at)) invalid();
    const now = this.#clock.now();
    if (!Number.isSafeInteger(now) || now < 0 || (value.expires_at as number) <= now
        || (value.expires_at as number) > now + MAX_TTL_MS) invalid();
    return value.position;
  }
}
