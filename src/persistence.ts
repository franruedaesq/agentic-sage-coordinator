/**
 * Represents the persisted state of a single step operation.
 */
export interface StepState {
  /** Execution status of the operation. */
  status: 'completed' | 'compensated';
  /** Result value stored for idempotent replay (only set for 'completed' execute steps). */
  result?: unknown;
}

/**
 * Interface for persisting and loading saga step state.
 * Implement this to plug in any storage backend (Redis, database, etc.).
 *
 * @example
 * ```typescript
 * class RedisAdapter implements SagaStateAdapter {
 *   async saveState(key: string, state: StepState) { ... }
 *   async loadState(key: string) { ... }
 * }
 * ```
 */
export interface SagaStateAdapter {
  /**
   * Persist the state of a step operation under the given idempotency key.
   * @param key   - The idempotency key for this step operation.
   * @param state - The state to persist.
   */
  saveState(key: string, state: StepState): Promise<void>;

  /**
   * Load the previously persisted state for the given key, or `undefined`
   * if no state has been saved yet.
   * @param key - The idempotency key to look up.
   */
  loadState(key: string): Promise<StepState | undefined>;
}

/**
 * Default in-memory implementation of {@link SagaStateAdapter}.
 * Suitable for single-process use and testing.
 * State is lost when the process exits.
 */
export class InMemoryAdapter implements SagaStateAdapter {
  private readonly _store = new Map<string, StepState>();

  async saveState(key: string, state: StepState): Promise<void> {
    this._store.set(key, state);
  }

  async loadState(key: string): Promise<StepState | undefined> {
    return this._store.get(key);
  }
}
