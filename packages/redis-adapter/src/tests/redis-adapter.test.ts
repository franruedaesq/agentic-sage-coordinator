import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisAdapter } from '../index.js';
import type { StepState } from '@agentic-sage/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ioredis mock satisfying the subset used by RedisAdapter. */
function makeRedisMock(): { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } & Redis {
  return {
    get: vi.fn(),
    set: vi.fn(async () => 'OK'),
  } as unknown as { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } & Redis;
}

// ---------------------------------------------------------------------------
// RedisAdapter – basic contract
// ---------------------------------------------------------------------------

describe('RedisAdapter', () => {
  let redis: ReturnType<typeof makeRedisMock>;
  let adapter: RedisAdapter;

  beforeEach(() => {
    redis = makeRedisMock();
    adapter = new RedisAdapter(redis);
  });

  it('returns undefined when the key does not exist in Redis', async () => {
    redis.get.mockResolvedValue(null);
    const state = await adapter.loadState('missing-key');
    expect(state).toBeUndefined();
    expect(redis.get).toHaveBeenCalledWith('missing-key');
  });

  it('deserialises the stored JSON when the key exists', async () => {
    const stored: StepState = { status: 'completed', result: { orderId: '42' } };
    redis.get.mockResolvedValue(JSON.stringify(stored));

    const state = await adapter.loadState('order-step');
    expect(state).toEqual(stored);
    expect(redis.get).toHaveBeenCalledWith('order-step');
  });

  it('serialises state to JSON and calls redis.set without TTL', async () => {
    const state: StepState = { status: 'completed', result: 'ok' };
    await adapter.saveState('step-1', state);

    expect(redis.set).toHaveBeenCalledWith('step-1', JSON.stringify(state));
  });

  it('stores compensated state without a result field', async () => {
    const state: StepState = { status: 'compensated' };
    await adapter.saveState('step-1:compensate', state);

    expect(redis.set).toHaveBeenCalledWith('step-1:compensate', JSON.stringify(state));
  });

  it('overwrites an existing key (round-trip)', async () => {
    const state: StepState = { status: 'compensated' };
    redis.get.mockResolvedValue(JSON.stringify(state));

    await adapter.saveState('step-1', state);
    const loaded = await adapter.loadState('step-1');

    expect(loaded).toEqual(state);
  });

  it('fulfils the SagaStateAdapter interface', () => {
    expect(typeof adapter.saveState).toBe('function');
    expect(typeof adapter.loadState).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// RedisAdapter – keyPrefix option
// ---------------------------------------------------------------------------

describe('RedisAdapter – keyPrefix option', () => {
  it('prepends the keyPrefix to every redis key on save', async () => {
    const redis = makeRedisMock();
    const adapter = new RedisAdapter(redis, { keyPrefix: 'myapp:saga:' });

    await adapter.saveState('step-1', { status: 'completed', result: 1 });
    expect(redis.set).toHaveBeenCalledWith('myapp:saga:step-1', expect.any(String));
  });

  it('prepends the keyPrefix to every redis key on load', async () => {
    const redis = makeRedisMock();
    redis.get.mockResolvedValue(null);
    const adapter = new RedisAdapter(redis, { keyPrefix: 'myapp:saga:' });

    await adapter.loadState('step-1');
    expect(redis.get).toHaveBeenCalledWith('myapp:saga:step-1');
  });

  it('uses no prefix by default', async () => {
    const redis = makeRedisMock();
    const adapter = new RedisAdapter(redis);

    await adapter.saveState('step-2', { status: 'completed' });
    const [[key]] = (redis.set as ReturnType<typeof vi.fn>).mock.calls;
    expect(key).toBe('step-2');
  });
});

// ---------------------------------------------------------------------------
// RedisAdapter – ttlSeconds option
// ---------------------------------------------------------------------------

describe('RedisAdapter – ttlSeconds option', () => {
  it('passes EX and the ttl value when ttlSeconds is set', async () => {
    const redis = makeRedisMock();
    const adapter = new RedisAdapter(redis, { ttlSeconds: 3600 });

    const state: StepState = { status: 'completed', result: 'data' };
    await adapter.saveState('step-1', state);

    expect(redis.set).toHaveBeenCalledWith('step-1', JSON.stringify(state), 'EX', 3600);
  });

  it('does not pass EX when ttlSeconds is not set', async () => {
    const redis = makeRedisMock();
    const adapter = new RedisAdapter(redis);

    const state: StepState = { status: 'completed', result: 'data' };
    await adapter.saveState('step-1', state);

    // Called with exactly 2 args (no EX, no ttl)
    expect(redis.set).toHaveBeenCalledWith('step-1', JSON.stringify(state));
  });
});
