/**
 * Thrown by a saga step's `execute()` function to signal that the step
 * requires human approval before the saga can continue.
 *
 * When the executor catches this error it saves the pending state and exits
 * gracefully (no rollback).  Call `SagaExecutor.resume()` once approval has
 * been granted to continue from the next step.
 */
export class PendingApprovalError extends Error {
  constructor() {
    super('Saga step is pending human approval');
    this.name = 'PendingApprovalError';
  }
}

/**
 * Thrown when one or more compensation (rollback) functions fail after all
 * configured retries are exhausted.  This signals a potentially compromised
 * state that requires manual intervention.
 */
export class SagaCompensationError extends Error {
  /** The name of the step whose compensation failed. */
  readonly stepName: string;
  /** The original error thrown by the `compensate()` function. */
  readonly cause: unknown;

  constructor(stepName: string, cause: unknown) {
    super(
      `SagaCompensationError: compensation for step "${stepName}" failed after all retries. Manual intervention may be required.`,
    );
    this.name = 'SagaCompensationError';
    this.stepName = stepName;
    this.cause = cause;
  }
}

/**
 * Metadata associated with a single saga step.
 */
export interface SagaStepMetadata {
  /** Human-readable description of what this step does. */
  description?: string;
  /** Maximum number of retry attempts for the execute function. Defaults to 0 (no retries). */
  maxRetries?: number;
  /** Maximum number of retry attempts for the compensate function. Defaults to 3. */
  compensationRetries?: number;
  /** Whether this step should be skipped during a dry-run. Defaults to false. */
  skipOnDryRun?: boolean;
  /** Idempotency key to prevent double-execution. If omitted, one is auto-generated. */
  idempotencyKey?: string;
}

/**
 * A single step in a Saga, parameterised by:
 * - `TResult`  – the resolved value returned by `execute()`.
 * - `TContext` – the shared context object passed through all steps.
 */
export interface SagaStep<TResult = unknown, TContext extends SagaContext = SagaContext> {
  /** Unique name that identifies this step within the saga. */
  name: string;
  /**
   * Execute the step's primary action.
   * @param ctx - The shared saga context.
   * @returns A promise that resolves to the step's result on success.
   */
  execute(ctx: TContext): Promise<TResult>;
  /**
   * Compensate (roll back) the step's action.
   * Called automatically when a later step fails.
   * @param ctx    - The shared saga context.
   * @param result - The value previously returned by `execute()`.
   */
  compensate(ctx: TContext, result: TResult): Promise<void>;
  /** Optional metadata that controls execution behaviour. */
  metadata?: SagaStepMetadata;
}

/**
 * The shared context object that is threaded through every step of a Saga.
 * Extend this interface to add domain-specific fields.
 *
 * @example
 * ```typescript
 * interface PaymentContext extends SagaContext {
 *   userId: string;
 *   amount: number;
 * }
 * ```
 */
export interface SagaContext {
  /** Results produced by each completed step, keyed by step name. */
  results: Record<string, unknown>;
  /** Whether the saga is executing in dry-run mode (no real side-effects). */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Phase 5: Advanced Features
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link SagaExecutor.run}.
 */
export interface RunOptions {
  /** When `true`, skips all `execute()` / `compensate()` calls and returns the
   *  execution plan instead of running the saga. */
  dryRun?: boolean;
}

/**
 * Describes a single step as it would appear in a dry-run execution plan.
 */
export interface ExecutionPlanStep {
  /** The step's unique name. */
  name: string;
  /** Human-readable description taken from step metadata, if available. */
  description?: string;
  /** Whether this step is configured to be skipped during a dry-run. */
  skipOnDryRun?: boolean;
}

/**
 * Returned by {@link SagaExecutor.run} when called with `{ dryRun: true }`.
 * Contains the ordered list of steps that *would* have been executed.
 */
export interface DryRunResult {
  readonly dryRun: true;
  readonly plan: readonly ExecutionPlanStep[];
}

/**
 * Returned by {@link SagaExecutor.run} (or {@link SagaExecutor.resume}) when
 * a step has thrown {@link PendingApprovalError} and the saga has paused
 * awaiting human-in-the-loop approval.
 */
export interface PendingApprovalResult {
  readonly status: 'pending_approval';
  /** Name of the step that is waiting for approval. */
  readonly stepName: string;
}

// ---------------------------------------------------------------------------
// Lifecycle hook types
// ---------------------------------------------------------------------------

/** Called immediately before a step's `execute()` is invoked. */
export type BeforeStepHook<TContext extends SagaContext> = (
  stepName: string,
  ctx: TContext,
) => void | Promise<void>;

/** Called immediately after a step's `execute()` resolves successfully. */
export type AfterStepHook<TContext extends SagaContext> = (
  stepName: string,
  result: unknown,
  ctx: TContext,
) => void | Promise<void>;

/** Called when a step's `execute()` throws (including {@link PendingApprovalError}). */
export type ErrorHook<TContext extends SagaContext> = (
  stepName: string,
  error: unknown,
  ctx: TContext,
) => void | Promise<void>;

/** Called each time a step's `compensate()` is invoked during rollback. */
export type CompensationHook<TContext extends SagaContext> = (
  stepName: string,
  result: unknown,
  ctx: TContext,
) => void | Promise<void>;
