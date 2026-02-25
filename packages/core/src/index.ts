export type { SagaContext, SagaStep, SagaStepMetadata, ParallelStepGroup, Logger } from './types.js';
export type {
  RunOptions,
  ExecutionPlanStep,
  DryRunResult,
  PendingApprovalResult,
  BeforeStepHook,
  AfterStepHook,
  ErrorHook,
  CompensationHook,
} from './types.js';
export { SagaCompensationError, PendingApprovalError } from './types.js';
export { SagaBuilder } from './builder.js';
export type { SagaDefinition, SagaMetadata } from './builder.js';
export { SagaExecutor } from './executor.js';
export type { SagaStateAdapter, StepState } from './persistence.js';
export { InMemoryAdapter } from './persistence.js';
export { SerializationError, isJsonSerializable, assertJsonSerializable } from './serialization.js';

// ---------------------------------------------------------------------------
// Action templates – copy-and-customise starting points for common steps
// ---------------------------------------------------------------------------
export { StripeChargeStep, DbInsertStep } from './templates/index.js';
export type {
  StripeChargeResult,
  StripeChargeContext,
  DbInsertResult,
  DbInsertContext,
} from './templates/index.js';
