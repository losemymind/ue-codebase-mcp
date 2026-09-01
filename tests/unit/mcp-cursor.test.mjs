import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { CursorError, OpaqueCursorCodec } from '../../apps/mcp-server/src/cursor.ts';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const binding = Object.freeze({ tool: 'search_code', principal: digest('principal'), request_hash: digest('request') });

test('opaque cursor round trips only within the bound caller, tool and query', () => {
  const codec = new OpaqueCursorCodec(Buffer.alloc(32, 7), 60_000, { now: () => 1_000 });
  const token = codec.encode(binding, 'position:20');
  assert.equal(codec.decode(binding, token), 'position:20');
  assert.throws(() => codec.decode({ ...binding, principal: digest('other') }, token), CursorError);
  assert.throws(() => codec.decode({ ...binding, request_hash: digest('other') }, token), CursorError);
  const changed = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
  assert.throws(() => codec.decode(binding, changed), CursorError);
});

test('opaque cursor expires and constructor rejects weak secrets', () => {
  let now = 1_000;
  const codec = new OpaqueCursorCodec(Buffer.alloc(32, 9), 1_000, { now: () => now });
  const token = codec.encode(binding, '20');
  now = 2_000;
  assert.throws(() => codec.decode(binding, token), CursorError);
  assert.throws(() => new OpaqueCursorCodec(Buffer.alloc(31)), CursorError);
});
