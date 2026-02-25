import { describe, it, expect, vi } from 'vitest';
import { SagaBuilder } from '../builder.js';
import { SagaExecutor } from '../executor.js';
import type { SagaContext, SagaStep } from '../types.js';
import { SagaCompensationError } from '../types.js';

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

function makeCtx(): SagaContext {
  return { results: {} };
}

// ---------------------------------------------------------------------------
// SagaExecutor – skeleton / construction
// ---------------------------------------------------------------------------

describe('SagaExecutor', () => {
  it('returns a SagaExecutor instance from the constructor', () => {
    const definition = new SagaBuilder().addStep(makeStep('step-1', undefined)).build();
    const executor = new SagaExecutor(definition, makeCtx());
    expect(executor).toBeInstanceOf(SagaExecutor);
  });

  it('run() resolves with the context object', async () => {
    const definition = new SagaBuilder().addStep(makeStep('step-1', undefined)).build();
    const ctx = makeCtx();
    const executor = new SagaExecutor(definition, ctx);
    const result = await executor.run();
    expect(result).toBe(ctx);
  });
});

// ---------------------------------------------------------------------------
// SagaExecutor – sequential execution order
// ---------------------------------------------------------------------------

describe('SagaExecutor – sequential execution', () => {
  it('calls execute() on every step exactly once', async () => {
    const step1 = makeStep('step-1', 'a');
    const step2 = makeStep('step-2', 'b');
    const step3 = makeStep('step-3', 'c');

    const definition = new SagaBuilder()
      .addStep(step1)
      .addStep(step2)
      .addStep(step3)
      .build();

    await new SagaExecutor(definition, makeCtx()).run();

    expect(step1.execute).toHaveBeenCalledTimes(1);
    expect(step2.execute).toHaveBeenCalledTimes(1);
    expect(step3.execute).toHaveBeenCalledTimes(1);
  });

  it('calls steps in insertion order', async () => {
    const order: string[] = [];
    const makeOrderedStep = (name: string): SagaStep<void, SagaContext> => ({
      name,
      execute: vi.fn(async () => {
        order.push(name);
      }),
      compensate: vi.fn(async () => undefined),
    });

    const definition = new SagaBuilder()
      .addStep(makeOrderedStep('first'))
      .addStep(makeOrderedStep('second'))
      .addStep(makeOrderedStep('third'))
      .build();

    await new SagaExecutor(definition, makeCtx()).run();

    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('awaits each step before calling the next', async () => {
    const resolved: string[] = [];

    const makeAsyncStep = (name: string, delayMs: number): SagaStep<void, SagaContext> => ({
      name,
      execute: vi.fn(
        () =>
          new Promise<void>((resolve) =>
            setTimeout(() => {
              resolved.push(name);
              resolve();
            }, delayMs),
          ),
      ),
      compensate: vi.fn(async () => undefined),
    });

    // step-1 takes longer but must still finish before step-2 starts
    const definition = new SagaBuilder()
      .addStep(makeAsyncStep('step-1', 20))
      .addStep(makeAsyncStep('step-2', 5))
      .build();

    await new SagaExecutor(definition, makeCtx()).run();

    expect(resolved).toEqual(['step-1', 'step-2']);
  });
});

// ---------------------------------------------------------------------------
// SagaExecutor – context accumulation
// ---------------------------------------------------------------------------

describe('SagaExecutor – context passing', () => {
  it('stores each step result in context.results keyed by step name', async () => {
    const step1 = makeStep('reserve-funds', { reserved: true });
    const step2 = makeStep('charge-card', { charged: true });

    const definition = new SagaBuilder().addStep(step1).addStep(step2).build();
    const ctx = makeCtx();

    await new SagaExecutor(definition, ctx).run();

    expect(ctx.results['reserve-funds']).toEqual({ reserved: true });
    expect(ctx.results['charge-card']).toEqual({ charged: true });
  });

  it('passes the accumulated context to every step', async () => {
    const step1 = makeStep('step-1', 42);

    let ctxSeenByStep2: SagaContext | undefined;
    const step2: SagaStep<void, SagaContext> = {
      name: 'step-2',
      execute: vi.fn(async (ctx) => {
        ctxSeenByStep2 = ctx;
      }),
      compensate: vi.fn(async () => undefined),
    };

    const definition = new SagaBuilder().addStep(step1).addStep(step2).build();
    const ctx = makeCtx();

    await new SagaExecutor(definition, ctx).run();

    // By the time step-2 runs, step-1's result should already be in context
    expect(ctxSeenByStep2?.results['step-1']).toBe(42);
  });

  it('output of step-1 is accessible in step-2 via context.results', async () => {
    const step1: SagaStep<{ orderId: string }, SagaContext> = {
      name: 'create-order',
      execute: vi.fn(async () => ({ orderId: 'order-99' })),
      compensate: vi.fn(async () => undefined),
    };

    let capturedOrderId: string | undefined;
    const step2: SagaStep<void, SagaContext> = {
      name: 'send-confirmation',
      execute: vi.fn(async (ctx) => {
        const prev = ctx.results['create-order'] as { orderId: string };
        capturedOrderId = prev.orderId;
      }),
      compensate: vi.fn(async () => undefined),
    };

    const definition = new SagaBuilder().addStep(step1).addStep(step2).build();
    await new SagaExecutor(definition, makeCtx()).run();

    expect(capturedOrderId).toBe('order-99');
  });

  it('each step receives the same context reference', async () => {
    const seenContexts: SagaContext[] = [];
    const makeCapturingStep = (name: string): SagaStep<void, SagaContext> => ({
      name,
      execute: vi.fn(async (ctx) => {
        seenContexts.push(ctx);
      }),
      compensate: vi.fn(async () => undefined),
    });

    const definition = new SagaBuilder()
      .addStep(makeCapturingStep('step-1'))
      .addStep(makeCapturingStep('step-2'))
      .addStep(makeCapturingStep('step-3'))
      .build();

    const ctx = makeCtx();
    await new SagaExecutor(definition, ctx).run();

    expect(seenContexts).toHaveLength(3);
    expect(seenContexts[0]).toBe(ctx);
    expect(seenContexts[1]).toBe(ctx);
    expect(seenContexts[2]).toBe(ctx);
  });
});

// ---------------------------------------------------------------------------
// SagaExecutor – rollback (compensation) on step failure
// ---------------------------------------------------------------------------

describe('SagaExecutor – rollback on failure', () => {
  it('compensates completed steps in reverse order when a step throws', async () => {
    const compensateOrder: string[] = [];

    const makeRollbackStep = (name: string): SagaStep<void, SagaContext> => ({
      name,
      execute: vi.fn(async () => undefined),
      compensate: vi.fn(async () => {
        compensateOrder.push(name);
      }),
    });

    const step1 = makeRollbackStep('step-1');
    const step2 = makeRollbackStep('step-2');
    const step3: SagaStep<void, SagaContext> = {
      name: 'step-3',
      execute: vi.fn(async () => {
        throw new Error('step-3 failed');
      }),
      compensate: vi.fn(async () => undefined),
    };
    const step4 = makeRollbackStep('step-4');

    const definition = new SagaBuilder()
      .addStep(step1)
      .addStep(step2)
      .addStep(step3)
      .addStep(step4)
      .build();

    await expect(new SagaExecutor(definition, makeCtx()).run()).rejects.toThrow('step-3 failed');

    // step-2 compensated before step-1; step-3 and step-4 not compensated
    expect(compensateOrder).toEqual(['step-2', 'step-1']);
    expect(step3.compensate).not.toHaveBeenCalled();
    expect(step4.compensate).not.toHaveBeenCalled();
  });

  it('does not call compensate on any step when the first step fails', async () => {
    const step1: SagaStep<void, SagaContext> = {
      name: 'step-1',
      execute: vi.fn(async () => {
        throw new Error('first step failed');
      }),
      compensate: vi.fn(async () => undefined),
    };
    const step2 = makeStep('step-2', undefined);

    const definition = new SagaBuilder().addStep(step1).addStep(step2).build();

    await expect(new SagaExecutor(definition, makeCtx()).run()).rejects.toThrow(
      'first step failed',
    );

    expect(step1.compensate).not.toHaveBeenCalled();
    expect(step2.execute).not.toHaveBeenCalled();
    expect(step2.compensate).not.toHaveBeenCalled();
  });

  it('passes the step result to compensate()', async () => {
    const step1: SagaStep<{ id: number }, SagaContext> = {
      name: 'step-1',
      execute: vi.fn(async () => ({ id: 42 })),
      compensate: vi.fn(async () => undefined),
    };
    const step2: SagaStep<void, SagaContext> = {
      name: 'step-2',
      execute: vi.fn(async () => {
        throw new Error('oops');
      }),
      compensate: vi.fn(async () => undefined),
    };

    const definition = new SagaBuilder().addStep(step1).addStep(step2).build();
    await expect(new SagaExecutor(definition, makeCtx()).run()).rejects.toThrow('oops');

    expect(step1.compensate).toHaveBeenCalledWith(expect.anything(), { id: 42 });
  });

  it('re-throws the original step error after rollback', async () => {
    const originalError = new Error('original failure');
    const step1 = makeStep('step-1', undefined);
    const step2: SagaStep<void, SagaContext> = {
      name: 'step-2',
      execute: vi.fn(async () => {
        throw originalError;
      }),
      compensate: vi.fn(async () => undefined),
    };

    const definition = new SagaBuilder().addStep(step1).addStep(step2).build();
    await expect(new SagaExecutor(definition, makeCtx()).run()).rejects.toBe(originalError);
  });
});

// ---------------------------------------------------------------------------
// SagaExecutor – compensation failures and retries
// ---------------------------------------------------------------------------

describe('SagaExecutor – compensation failure handling', () => {
  it('throws SagaCompensationError when compensate() always fails', async () => {
    const step1: SagaStep<void, SagaContext> = {
      name: 'step-1',
      execute: vi.fn(async () => undefined),
      compensate: vi.fn(async () => {
        throw new Error('compensation failed');
      }),
      metadata: { compensationRetries: 0 },
    };
    const step2: SagaStep<void, SagaContext> = {
      name: 'step-2',
      execute: vi.fn(async () => {
        throw new Error('step-2 execute failed');
      }),
      compensate: vi.fn(async () => undefined),
    };

    const definition = new SagaBuilder().addStep(step1).addStep(step2).build();
    const err = await new SagaExecutor(definition, makeCtx()).run().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SagaCompensationError);
    expect((err as SagaCompensationError).stepName).toBe('step-1');
  });

  it('SagaCompensationError has the correct name', async () => {
    const err = new SagaCompensationError('my-step', new Error('cause'));
    expect(err.name).toBe('SagaCompensationError');
    expect(err).toBeInstanceOf(Error);
  });

  it('retries compensation the configured number of times before throwing SagaCompensationError', async () => {
    const compensateFn = vi.fn(async () => {
      throw new Error('always fails');
    });

    const step1: SagaStep<void, SagaContext> = {
      name: 'step-1',
      execute: vi.fn(async () => undefined),
      compensate: compensateFn,
      metadata: { compensationRetries: 2 },
    };
    const step2: SagaStep<void, SagaContext> = {
      name: 'step-2',
      execute: vi.fn(async () => {
        throw new Error('step-2 failed');
      }),
      compensate: vi.fn(async () => undefined),
    };

    const definition = new SagaBuilder().addStep(step1).addStep(step2).build();
    await expect(new SagaExecutor(definition, makeCtx()).run()).rejects.toBeInstanceOf(
      SagaCompensationError,
    );

    // 1 initial attempt + 2 retries = 3 total calls
    expect(compensateFn).toHaveBeenCalledTimes(3);
  });

  it('succeeds without throwing when compensation succeeds on a retry', async () => {
    let callCount = 0;
    const compensateFn = vi.fn(async () => {
      callCount++;
      if (callCount < 3) throw new Error('transient');
    });

    const step1: SagaStep<void, SagaContext> = {
      name: 'step-1',
      execute: vi.fn(async () => undefined),
      compensate: compensateFn,
      metadata: { compensationRetries: 3 },
    };
    const step2: SagaStep<void, SagaContext> = {
      name: 'step-2',
      execute: vi.fn(async () => {
        throw new Error('step-2 failed');
      }),
      compensate: vi.fn(async () => undefined),
    };

    const definition = new SagaBuilder().addStep(step1).addStep(step2).build();

    // Should reject with the original step error, NOT a SagaCompensationError,
    // because compensation eventually succeeded.
    const err = await new SagaExecutor(definition, makeCtx()).run().catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SagaCompensationError);
    expect((err as Error).message).toBe('step-2 failed');
    expect(compensateFn).toHaveBeenCalledTimes(3);
  });
});
