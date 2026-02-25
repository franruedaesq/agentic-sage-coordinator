/**
 * Thrown when a saga step returns a value that cannot be round-tripped through
 * `JSON.stringify` / `JSON.parse`.
 *
 * AI agents sometimes return raw HTTP responses, class instances, or objects
 * with circular references.  If these reach a {@link SagaStateAdapter}, most
 * storage backends will crash or silently corrupt the persisted state.
 *
 * The {@link SagaExecutor} throws this error before calling
 * `SagaStateAdapter.saveState()` so that the problem surfaces at the saga
 * layer, not deep inside your storage backend.
 */
export class SerializationError extends Error {
  /** Name of the step that returned the non-serializable value. */
  readonly stepName: string;
  /** The original error thrown by `JSON.stringify`. */
  readonly cause: unknown;

  constructor(stepName: string, cause: unknown) {
    super(
      `SagaExecutor: result from step "${stepName}" is not JSON-serializable. ` +
        `Ensure steps do not return circular objects, class instances, or other non-serializable values.`,
    );
    this.name = 'SerializationError';
    this.stepName = stepName;
    this.cause = cause;
  }
}

/**
 * Returns `true` when `value` can be losslessly serialized with
 * `JSON.stringify`, `false` otherwise.
 *
 * @example
 * ```typescript
 * isJsonSerializable({ id: 1 })          // true
 * isJsonSerializable(new Response(...))  // false (circular / non-enumerable)
 * ```
 */
export function isJsonSerializable(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Throws a {@link SerializationError} if `value` cannot be serialized with
 * `JSON.stringify`.
 *
 * @param value    - The value to validate.
 * @param stepName - The name of the saga step that produced the value.
 *                   Used in the error message.
 * @throws {@link SerializationError}
 */
export function assertJsonSerializable(value: unknown, stepName: string): void {
  try {
    JSON.stringify(value);
  } catch (cause) {
    throw new SerializationError(stepName, cause);
  }
}
