import type { SagaStateAdapter, StepState } from '@agentic-sage/core';
import type { Redis } from 'ioredis';

/**
 * Options for {@link RedisAdapter}.
 */
export interface RedisAdapterOptions {
  /**
   * Optional key prefix applied to every idempotency key stored in Redis.
   * Useful for namespacing sagas when the same Redis instance is shared
   * between multiple applications or environments.
   *
   * @default ""
   * @example "myapp:saga:"
   */
  keyPrefix?: string;

  /**
   * Time-to-live in seconds for each stored key.
   * When set, Redis will automatically expire stored state after this
   * many seconds, preventing unbounded key growth.
   * When omitted, keys are stored indefinitely.
   */
  ttlSeconds?: number;
}

/**
 * Redis-backed implementation of {@link SagaStateAdapter}.
 *
 * Persists saga step state as JSON strings in Redis, allowing sagas to be
 * paused on one server and resumed on another – the key enabler for
 * Human-in-the-Loop (HITL) workflows in distributed deployments.
 *
 * @example
 * ```typescript
 * import Redis from 'ioredis';
 * import { RedisAdapter } from '@agentic-sage/redis-adapter';
 *
 * const redis = new Redis({ host: 'localhost', port: 6379 });
 * const adapter = new RedisAdapter(redis, { keyPrefix: 'saga:', ttlSeconds: 3600 });
 *
 * const executor = new SagaExecutor(definition, ctx, adapter);
 * await executor.run();
 * ```
 */
export class RedisAdapter implements SagaStateAdapter {
  private readonly _redis: Redis;
  private readonly _keyPrefix: string;
  private readonly _ttlSeconds: number | undefined;

  constructor(redis: Redis, options: RedisAdapterOptions = {}) {
    this._redis = redis;
    this._keyPrefix = options.keyPrefix ?? '';
    this._ttlSeconds = options.ttlSeconds;
  }

  /** @internal */
  private _buildKey(key: string): string {
    return `${this._keyPrefix}${key}`;
  }

  async saveState(key: string, state: StepState): Promise<void> {
    const redisKey = this._buildKey(key);
    const value = JSON.stringify(state);
    if (this._ttlSeconds !== undefined) {
      await this._redis.set(redisKey, value, 'EX', this._ttlSeconds);
    } else {
      await this._redis.set(redisKey, value);
    }
  }

  async loadState(key: string): Promise<StepState | undefined> {
    const redisKey = this._buildKey(key);
    const value = await this._redis.get(redisKey);
    if (value === null) {
      return undefined;
    }
    return JSON.parse(value) as StepState;
  }
}
