import type { SagaContext, SagaStep } from './types.js';
import { SagaCompensationError } from './types.js';
import type { SagaDefinition } from './builder.js';
import type { SagaStateAdapter } from './persistence.js';
import { InMemoryAdapter } from './persistence.js';

/** Default number of compensation retry attempts when not specified on the step. */
const DEFAULT_COMPENSATION_RETRIES = 3;

/**
 * Executes a {@link SagaDefinition} step-by-step, accumulating results in the
 * shared {@link SagaContext}.
 *
 * On failure, it automatically rolls back all successfully completed steps in
 * reverse order, retrying each compensation with exponential backoff.
 *
 * Supports pluggable persistence via {@link SagaStateAdapter}: each step's
 * state is checkpointed after a successful execute or compensate, and
 * idempotency checks prevent re-executing steps that already completed.
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
  private readonly _adapter: SagaStateAdapter;

  constructor(
    definition: SagaDefinition<TContext>,
    context: TContext,
    adapter?: SagaStateAdapter,
  ) {
    this._definition = definition;
    this._context = context;
    this._adapter = adapter ?? new InMemoryAdapter();
  }

  /**
   * Run all steps in order, awaiting each `execute()` call and storing its
   * result under `context.results[step.name]`.
   *
   * If the state adapter reports the step is already 'completed', the execute
   * call is skipped and the stored result is replayed (idempotency).
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
    const completed: Array<{
      step: SagaStep<unknown, TContext>;
      result: unknown;
      idemKey: string;
    }> = [];

    for (const step of this._definition.steps) {
      const idemKey = step.metadata?.idempotencyKey ?? step.name;
      try {
        const existing = await this._adapter.loadState(idemKey);
        let result: unknown;
        if (existing?.status === 'completed') {
          // Idempotency: step already ran successfully – replay its result.
          result = existing.result;
        } else {
          result = await step.execute(this._context);
          // Checkpoint: persist state after a successful execute.
          await this._adapter.saveState(idemKey, { status: 'completed', result });
        }
        this._context.results[step.name] = result;
        completed.push({ step, result, idemKey });
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
   * If the state adapter reports the compensation is already 'compensated',
   * the call is skipped (idempotency).  After a successful compensate the
   * state is checkpointed.
   *
   * @throws {@link SagaCompensationError} if any compensation fails after all
   *   retries.
   */
  private async _rollback(
    completed: Array<{ step: SagaStep<unknown, TContext>; result: unknown; idemKey: string }>,
  ): Promise<void> {
    for (let i = completed.length - 1; i >= 0; i--) {
      const { step, result, idemKey } = completed[i];
      const compensateKey = `${idemKey}:compensate`;

      // Idempotency: skip if compensation was already recorded.
      const existing = await this._adapter.loadState(compensateKey);
      if (existing?.status === 'compensated') {
        continue;
      }

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
          // Checkpoint: persist state after a successful compensate.
          await this._adapter.saveState(compensateKey, { status: 'compensated' });
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
