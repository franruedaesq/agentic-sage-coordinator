import type { SagaContext, SagaStep } from './types.js';
import { SagaCompensationError } from './types.js';
import type { SagaDefinition } from './builder.js';

/** Default number of compensation retry attempts when not specified on the step. */
const DEFAULT_COMPENSATION_RETRIES = 3;

/**
 * Executes a {@link SagaDefinition} step-by-step, accumulating results in the
 * shared {@link SagaContext}.
 *
 * On failure, it automatically rolls back all successfully completed steps in
 * reverse order, retrying each compensation with exponential backoff.
 *
 * @example
 * ```typescript
 * const executor = new SagaExecutor(saga, { results: {} });
 * const finalContext = await executor.run();
 * ```
 */
export class SagaExecutor<TContext extends SagaContext = SagaContext> {
  private readonly _definition: SagaDefinition<TContext>;
  private readonly _context: TContext;

  constructor(definition: SagaDefinition<TContext>, context: TContext) {
    this._definition = definition;
    this._context = context;
  }

  /**
   * Run all steps in order, awaiting each `execute()` call and storing its
   * result under `context.results[step.name]`.
   *
   * If a step throws, all previously completed steps are compensated in
   * reverse order before the original error is re-thrown.
   *
   * @returns The final context with all step results accumulated.
   * @throws The original step error after rollback completes.
   * @throws {@link SagaCompensationError} if a compensation function fails
   *   after all retries, indicating a compromised state.
   */
  async run(): Promise<TContext> {
    const completed: Array<{ step: SagaStep<unknown, TContext>; result: unknown }> = [];

    for (const step of this._definition.steps) {
      try {
        const result = await step.execute(this._context);
        this._context.results[step.name] = result;
        completed.push({ step, result });
      } catch (err) {
        await this._rollback(completed);
        throw err;
      }
    }

    return this._context;
  }

  /**
   * Iterate backwards through completed steps and call each step's
   * `compensate()`, retrying with exponential backoff on failure.
   *
   * @throws {@link SagaCompensationError} if any compensation fails after all
   *   retries.
   */
  private async _rollback(
    completed: Array<{ step: SagaStep<unknown, TContext>; result: unknown }>,
  ): Promise<void> {
    for (let i = completed.length - 1; i >= 0; i--) {
      const { step, result } = completed[i];
      const maxRetries = step.metadata?.compensationRetries ?? DEFAULT_COMPENSATION_RETRIES;
      let lastError: unknown;
      let succeeded = false;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          // Exponential backoff: 100ms, 200ms, 400ms, …
          await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt - 1)));
        }
        try {
          await step.compensate(this._context, result);
          succeeded = true;
          break;
        } catch (err) {
          lastError = err;
        }
      }

      if (!succeeded) {
        throw new SagaCompensationError(step.name, lastError);
      }
    }
  }
}
