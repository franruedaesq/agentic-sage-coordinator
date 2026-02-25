import type { SagaContext, SagaStep } from './types.js';
import { SagaCompensationError, PendingApprovalError } from './types.js';
import type {
  RunOptions,
  DryRunResult,
  PendingApprovalResult,
  BeforeStepHook,
  AfterStepHook,
  ErrorHook,
  CompensationHook,
} from './types.js';
import type { SagaDefinition } from './builder.js';
import type { SagaStateAdapter } from './persistence.js';
import { InMemoryAdapter } from './persistence.js';

/** Default number of compensation retry attempts when not specified on the step. */
const DEFAULT_COMPENSATION_RETRIES = 3;

/**
 * Internal adapter key used to track which step is awaiting human approval
 * so that {@link SagaExecutor.resume} can continue from the right place.
 */
const HITL_PENDING_KEY = '__hitl:pending__';

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
 * **Phase 5 additions:**
 * - `run({ dryRun: true })` returns an {@link DryRunResult} execution plan without
 *   invoking any step functions.
 * - Lifecycle hooks: {@link onBeforeStep}, {@link onAfterStep}, {@link onError},
 *   {@link onCompensation}.
 * - HITL support: steps may throw {@link PendingApprovalError}; the saga pauses
 *   and can be continued with {@link resume}.
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

  private readonly _beforeStepHooks: Array<BeforeStepHook<TContext>> = [];
  private readonly _afterStepHooks: Array<AfterStepHook<TContext>> = [];
  private readonly _errorHooks: Array<ErrorHook<TContext>> = [];
  private readonly _compensationHooks: Array<CompensationHook<TContext>> = [];

  constructor(
    definition: SagaDefinition<TContext>,
    context: TContext,
    adapter?: SagaStateAdapter,
  ) {
    this._definition = definition;
    this._context = context;
    this._adapter = adapter ?? new InMemoryAdapter();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle hook registration
  // ---------------------------------------------------------------------------

  /**
   * Register a hook to be called immediately **before** each step's `execute()`
   * is invoked (only for actual executions, not idempotency replays).
   * Returns `this` for fluent chaining.
   */
  onBeforeStep(hook: BeforeStepHook<TContext>): this {
    this._beforeStepHooks.push(hook);
    return this;
  }

  /**
   * Register a hook to be called immediately **after** each step's `execute()`
   * resolves successfully.
   * Returns `this` for fluent chaining.
   */
  onAfterStep(hook: AfterStepHook<TContext>): this {
    this._afterStepHooks.push(hook);
    return this;
  }

  /**
   * Register a hook to be called when a step's `execute()` throws an error
   * (including {@link PendingApprovalError}).
   * Returns `this` for fluent chaining.
   */
  onError(hook: ErrorHook<TContext>): this {
    this._errorHooks.push(hook);
    return this;
  }

  /**
   * Register a hook to be called each time a step's `compensate()` is invoked
   * during rollback.
   * Returns `this` for fluent chaining.
   */
  onCompensation(hook: CompensationHook<TContext>): this {
    this._compensationHooks.push(hook);
    return this;
  }

  // ---------------------------------------------------------------------------
  // Public execution API
  // ---------------------------------------------------------------------------

  /**
   * Run all steps in order, awaiting each `execute()` call and storing its
   * result under `context.results[step.name]`.
   *
   * When `options.dryRun` is `true`, no step functions are invoked and a
   * {@link DryRunResult} execution plan is returned instead.
   *
   * If a step throws {@link PendingApprovalError}, the saga pauses and returns
   * a {@link PendingApprovalResult}.  Call {@link resume} to continue.
   *
   * If any other step error is thrown, all previously completed steps are
   * compensated in reverse order before the original error is re-thrown.
   *
   * @returns The final context, a {@link DryRunResult}, or a {@link PendingApprovalResult}.
   * @throws The original step error after rollback completes.
   * @throws {@link SagaCompensationError} if a compensation function fails
   *   after all retries, indicating a compromised state.
   */
  async run(options?: RunOptions): Promise<TContext | DryRunResult | PendingApprovalResult> {
    if (options?.dryRun) {
      return this._dryRun();
    }

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
        } else if (existing?.status === 'pending_approval') {
          // HITL: the step is still waiting for approval.
          return { status: 'pending_approval', stepName: step.name };
        } else {
          // Invoke lifecycle before-hook.
          for (const hook of this._beforeStepHooks) {
            await hook(step.name, this._context);
          }
          result = await step.execute(this._context);
          // Checkpoint: persist state after a successful execute.
          await this._adapter.saveState(idemKey, { status: 'completed', result });
          // Invoke lifecycle after-hook.
          for (const hook of this._afterStepHooks) {
            await hook(step.name, result, this._context);
          }
        }
        this._context.results[step.name] = result;
        completed.push({ step, result, idemKey });
      } catch (err) {
        // Fire error hook for all errors (including PendingApprovalError).
        for (const hook of this._errorHooks) {
          await hook(step.name, err, this._context);
        }
        if (err instanceof PendingApprovalError) {
          // HITL: pause the saga – save state, do NOT roll back.
          await this._adapter.saveState(idemKey, { status: 'pending_approval' });
          await this._adapter.saveState(HITL_PENDING_KEY, {
            status: 'completed',
            result: step.name,
          });
          return { status: 'pending_approval', stepName: step.name };
        }
        await this._rollback(completed);
        throw err;
      }
    }

    return this._context;
  }

  /**
   * Resume a saga that was paused by a {@link PendingApprovalError}.
   *
   * Marks the pending step as completed with the provided `approvedResult`,
   * updates the context, then continues execution from the next step.
   *
   * @param approvedResult - The value to store as the pending step's result
   *   (e.g. the approval decision or any relevant payload).
   * @returns The final context or another {@link PendingApprovalResult} if a
   *   subsequent step also requires approval.
   * @throws {Error} If there is no pending step found in the adapter.
   */
  async resume(
    approvedResult?: unknown,
  ): Promise<TContext | DryRunResult | PendingApprovalResult> {
    const pending = await this._adapter.loadState(HITL_PENDING_KEY);
    if (!pending || pending.status !== 'completed') {
      throw new Error('SagaExecutor: no pending step found. Cannot resume.');
    }
    const stepName = pending.result as string;
    const step = this._definition.steps.find((s) => s.name === stepName);
    if (!step) {
      throw new Error(`SagaExecutor: pending step "${stepName}" not found in definition.`);
    }
    const idemKey = step.metadata?.idempotencyKey ?? step.name;
    // Mark the pending step as completed with the approved result.
    await this._adapter.saveState(idemKey, { status: 'completed', result: approvedResult });
    this._context.results[stepName] = approvedResult;
    // Clear the HITL pending marker so it cannot be re-used accidentally.
    await this._adapter.saveState(HITL_PENDING_KEY, { status: 'compensated' });
    // Re-run: previously completed steps will be skipped via idempotency checks.
    return this.run();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Build and return the dry-run execution plan without executing any steps. */
  private _dryRun(): DryRunResult {
    return {
      dryRun: true,
      plan: this._definition.steps.map((step) => ({
        name: step.name,
        description: step.metadata?.description,
        skipOnDryRun: step.metadata?.skipOnDryRun,
      })),
    };
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
          // Invoke lifecycle compensation hook.
          for (const hook of this._compensationHooks) {
            await hook(step.name, result, this._context);
          }
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
