import type { SagaContext, SagaStep } from './types.js';

/**
 * Immutable snapshot produced by {@link SagaBuilder.build}.
 * Contains the ordered list of steps ready for an executor.
 */
export interface SagaDefinition<TContext extends SagaContext = SagaContext> {
  /** Ordered, immutable array of saga steps. */
  readonly steps: ReadonlyArray<SagaStep<unknown, TContext>>;
}

/**
 * Fluent builder for constructing a {@link SagaDefinition}.
 *
 * Steps are executed in the order they are added.
 * Once {@link build} is called the underlying array is frozen so the
 * definition cannot be mutated afterwards.
 *
 * @example
 * ```typescript
 * const saga = new SagaBuilder<PaymentContext>()
 *   .addStep(reserveFundsStep)
 *   .addStep(chargeCardStep)
 *   .addStep(sendReceiptStep)
 *   .build();
 * ```
 */
export class SagaBuilder<TContext extends SagaContext = SagaContext> {
  private readonly _steps: Array<SagaStep<unknown, TContext>> = [];

  /**
   * Append a step to the saga.
   * Returns `this` to allow fluent chaining.
   *
   * @param step - A fully-defined {@link SagaStep}.
   * @throws {Error} If a step with the same `name` has already been added.
   */
  addStep<TResult>(step: SagaStep<TResult, TContext>): this {
    const duplicate = this._steps.some((s) => s.name === step.name);
    if (duplicate) {
      throw new Error(
        `SagaBuilder: a step named "${step.name}" has already been added. Step names must be unique.`,
      );
    }
    this._steps.push(step as SagaStep<unknown, TContext>);
    return this;
  }

  /**
   * Finalise the builder and return an immutable {@link SagaDefinition}.
   *
   * @throws {Error} If no steps have been added.
   */
  build(): SagaDefinition<TContext> {
    if (this._steps.length === 0) {
      throw new Error('SagaBuilder: cannot build a saga with no steps.');
    }
    return {
      steps: Object.freeze([...this._steps]),
    };
  }
}
