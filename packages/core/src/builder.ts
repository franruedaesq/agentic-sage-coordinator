import type { SagaContext, SagaStep, ParallelStepGroup } from './types.js';

/**
 * Top-level metadata for a saga, used by AI framework wrappers to generate
 * tool schemas (e.g. LangChain, Vercel AI SDK).
 */
export interface SagaMetadata {
  /** Machine-friendly identifier for the saga (used as the tool name). */
  name: string;
  /** Human-readable description of what the saga does (used as the tool description). */
  description: string;
}

/**
 * Immutable snapshot produced by {@link SagaBuilder.build}.
 * Contains the ordered list of steps (or parallel step groups) ready for an executor.
 */
export interface SagaDefinition<TContext extends SagaContext = SagaContext> {
  /** Ordered, immutable array of saga steps or parallel step groups. */
  readonly steps: ReadonlyArray<SagaStep<unknown, TContext> | ParallelStepGroup<TContext>>;
  /** Optional top-level metadata consumed by AI framework wrappers. */
  readonly metadata?: SagaMetadata;
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
  private readonly _steps: Array<SagaStep<unknown, TContext> | ParallelStepGroup<TContext>> = [];

  /**
   * Append a step to the saga.
   * Returns `this` to allow fluent chaining.
   *
   * @param step - A fully-defined {@link SagaStep}.
   * @throws {Error} If a step with the same `name` has already been added.
   */
  addStep<TResult>(step: SagaStep<TResult, TContext>): this {
    if (this._hasName(step.name)) {
      throw new Error(
        `SagaBuilder: a step named "${step.name}" has already been added. Step names must be unique.`,
      );
    }
    this._steps.push(step as SagaStep<unknown, TContext>);
    return this;
  }

  /**
   * Append a group of steps that will be executed **concurrently** by the
   * executor via `Promise.allSettled()`.
   *
   * Use this for side-effects that are independent of each other (e.g. sending
   * an email and syncing a CRM record at the same time).  If any step in the
   * group fails, all successfully completed steps in the group — plus every
   * prior sequential step — are compensated in reverse order.
   *
   * Returns `this` to allow fluent chaining.
   *
   * @param steps - An array of {@link SagaStep} objects to run in parallel.
   * @throws {Error} If `steps` is empty.
   * @throws {Error} If any step name duplicates one that was already added.
   *
   * @example
   * ```typescript
   * const saga = new SagaBuilder<OrderContext>()
   *   .addStep(reserveFundsStep)
   *   .addParallelSteps([sendEmailStep, syncCrmStep])
   *   .addStep(issueReceiptStep)
   *   .build();
   * ```
   */
  addParallelSteps<TResult>(steps: Array<SagaStep<TResult, TContext>>): this {
    if (steps.length === 0) {
      throw new Error('SagaBuilder: addParallelSteps() requires at least one step.');
    }
    for (const step of steps) {
      if (this._hasName(step.name)) {
        throw new Error(
          `SagaBuilder: a step named "${step.name}" has already been added. Step names must be unique.`,
        );
      }
    }
    this._steps.push({
      parallel: true,
      steps: Object.freeze([...steps]) as ReadonlyArray<SagaStep<unknown, TContext>>,
    });
    return this;
  }

  /**
   * Finalise the builder and return an immutable {@link SagaDefinition}.
   *
   * @param metadata - Optional top-level metadata (name + description) used by
   *   AI framework wrappers such as `@agentic-sage/langchain` and
   *   `@agentic-sage/vercel-ai` to auto-generate tool schemas.
   * @throws {Error} If no steps have been added.
   */
  build(metadata?: SagaMetadata): SagaDefinition<TContext> {
    if (this._steps.length === 0) {
      throw new Error('SagaBuilder: cannot build a saga with no steps.');
    }
    return {
      steps: Object.freeze([...this._steps]),
      ...(metadata !== undefined ? { metadata } : {}),
    };
  }

  /** Returns `true` if `name` is already present (in a sequential or parallel entry). */
  private _hasName(name: string): boolean {
    return this._steps.some((entry) => {
      if ('parallel' in entry) {
        return entry.steps.some((s) => s.name === name);
      }
      return entry.name === name;
    });
  }
}
