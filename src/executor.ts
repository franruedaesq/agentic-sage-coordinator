import type { SagaContext } from './types.js';
import type { SagaDefinition } from './builder.js';

/**
 * Executes a {@link SagaDefinition} step-by-step, accumulating results in the
 * shared {@link SagaContext}.
 *
 * This is the "happy path" executor – it runs every step sequentially and
 * stops (throwing) if any step's `execute()` rejects.
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
   * @returns The final context with all step results accumulated.
   */
  async run(): Promise<TContext> {
    for (const step of this._definition.steps) {
      const result = await step.execute(this._context);
      this._context.results[step.name] = result;
    }
    return this._context;
  }
}
