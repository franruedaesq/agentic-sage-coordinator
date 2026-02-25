import { describe, it, expect, vi } from 'vitest';
import { SagaBuilder } from '../builder.js';
import type { SagaContext, SagaStep } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep<TResult = void>(
  name: string,
  executeResult: TResult,
): SagaStep<TResult, SagaContext> {
  return {
    name,
    execute: vi.fn(async () => executeResult),
    compensate: vi.fn(async () => undefined),
  };
}

// ---------------------------------------------------------------------------
// SagaBuilder – construction
// ---------------------------------------------------------------------------

describe('SagaBuilder', () => {
  it('returns a SagaBuilder instance from the constructor', () => {
    const builder = new SagaBuilder();
    expect(builder).toBeInstanceOf(SagaBuilder);
  });

  it('addStep() returns the same builder instance (supports chaining)', () => {
    const builder = new SagaBuilder();
    const step = makeStep('step-1', undefined);
    const returned = builder.addStep(step);
    expect(returned).toBe(builder);
  });

  it('build() returns a SagaDefinition with the steps in insertion order', () => {
    const step1 = makeStep('step-1', 'a');
    const step2 = makeStep('step-2', 'b');
    const step3 = makeStep('step-3', 'c');

    const definition = new SagaBuilder().addStep(step1).addStep(step2).addStep(step3).build();

    expect(definition.steps).toHaveLength(3);
    expect(definition.steps[0].name).toBe('step-1');
    expect(definition.steps[1].name).toBe('step-2');
    expect(definition.steps[2].name).toBe('step-3');
  });

  it('build() throws when called with no steps', () => {
    const builder = new SagaBuilder();
    expect(() => builder.build()).toThrowError(
      'SagaBuilder: cannot build a saga with no steps.',
    );
  });

  it('addStep() throws when a duplicate step name is added', () => {
    const builder = new SagaBuilder();
    builder.addStep(makeStep('duplicate', undefined));
    expect(() => builder.addStep(makeStep('duplicate', undefined))).toThrowError(
      'SagaBuilder: a step named "duplicate" has already been added. Step names must be unique.',
    );
  });

  it('build() produces a frozen (immutable) steps array', () => {
    const definition = new SagaBuilder().addStep(makeStep('step-1', undefined)).build();
    expect(Object.isFrozen(definition.steps)).toBe(true);
  });

  it('mutating the builder after build() does not affect the built definition', () => {
    const builder = new SagaBuilder<SagaContext>();
    builder.addStep(makeStep('step-1', undefined));

    const definition = builder.build();
    // Adding another step to the builder afterwards should NOT change the snapshot.
    builder.addStep(makeStep('step-2', undefined));

    expect(definition.steps).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// SagaBuilder – step metadata
// ---------------------------------------------------------------------------

describe('SagaBuilder – step metadata', () => {
  it('preserves optional metadata on a step', () => {
    const step: SagaStep<string, SagaContext> = {
      name: 'meta-step',
      execute: vi.fn(async () => 'ok'),
      compensate: vi.fn(async () => undefined),
      metadata: {
        description: 'Test step',
        maxRetries: 2,
        compensationRetries: 5,
        skipOnDryRun: true,
        idempotencyKey: 'idem-123',
      },
    };

    const { steps } = new SagaBuilder().addStep(step).build();

    expect(steps[0].metadata).toEqual({
      description: 'Test step',
      maxRetries: 2,
      compensationRetries: 5,
      skipOnDryRun: true,
      idempotencyKey: 'idem-123',
    });
  });

  it('step without metadata has metadata as undefined', () => {
    const step = makeStep('no-meta', 42);
    const { steps } = new SagaBuilder().addStep(step).build();
    expect(steps[0].metadata).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SagaContext interface contract (type-level via runtime check)
// ---------------------------------------------------------------------------

describe('SagaContext', () => {
  it('has a results record', () => {
    const ctx: SagaContext = { results: {} };
    expect(ctx.results).toEqual({});
  });

  it('supports an optional dryRun flag', () => {
    const ctx: SagaContext = { results: {}, dryRun: true };
    expect(ctx.dryRun).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SagaStep interface contract (type-level via runtime check)
// ---------------------------------------------------------------------------

describe('SagaStep', () => {
  it('execute() resolves with the step result', async () => {
    const step = makeStep('my-step', { id: 1 });
    const ctx: SagaContext = { results: {} };
    const result = await step.execute(ctx);
    expect(result).toEqual({ id: 1 });
  });

  it('compensate() is called with ctx and the prior result', async () => {
    const step = makeStep('my-step', 'payload');
    const ctx: SagaContext = { results: {} };

    await step.compensate(ctx, 'payload');

    expect(step.compensate).toHaveBeenCalledWith(ctx, 'payload');
  });

  it('execute() receives the context', async () => {
    const step = makeStep('ctx-step', null);
    const ctx: SagaContext = { results: { prev: 'data' }, dryRun: false };

    await step.execute(ctx);

    expect(step.execute).toHaveBeenCalledWith(ctx);
  });
});
