import { describe, it, expect, vi } from 'vitest';
import { SagaBuilder } from '../builder.js';
import { SagaExecutor } from '../executor.js';
import { InMemoryAdapter } from '../persistence.js';
import { SagaCompensationError } from '../types.js';
import { SerializationError, isJsonSerializable, assertJsonSerializable } from '../serialization.js';
import type { SagaContext, SagaStep, Logger, DryRunResult } from '../types.js';

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
// Step 2.1 – SagaBuilder.addParallelSteps()
// ---------------------------------------------------------------------------

describe('SagaBuilder – addParallelSteps()', () => {
  it('addParallelSteps() returns the same builder instance (supports chaining)', () => {
    const builder = new SagaBuilder();
    const returned = builder.addParallelSteps([makeStep('step-1', undefined)]);
    expect(returned).toBe(builder);
  });

  it('throws when called with an empty array', () => {
    expect(() => new SagaBuilder().addParallelSteps([])).toThrowError(
      'SagaBuilder: addParallelSteps() requires at least one step.',
    );
  });

  it('throws when a step in the group duplicates an existing sequential step name', () => {
    const builder = new SagaBuilder().addStep(makeStep('step-1', undefined));
    expect(() => builder.addParallelSteps([makeStep('step-1', undefined)])).toThrowError(
      'SagaBuilder: a step named "step-1" has already been added. Step names must be unique.',
    );
  });

  it('throws when addStep() is called with a name already in a parallel group', () => {
    const builder = new SagaBuilder().addParallelSteps([makeStep('par-step', undefined)]);
    expect(() => builder.addStep(makeStep('par-step', undefined))).toThrowError(
      'SagaBuilder: a step named "par-step" has already been added. Step names must be unique.',
    );
  });

  it('build() includes the parallel group in the steps array', () => {
    const step1 = makeStep('email', undefined);
    const step2 = makeStep('crm', undefined);
    const { steps } = new SagaBuilder().addParallelSteps([step1, step2]).build();

    expect(steps).toHaveLength(1);
    const group = steps[0] as { parallel: true; steps: SagaStep<unknown, SagaContext>[] };
    expect(group.parallel).toBe(true);
    expect(group.steps).toHaveLength(2);
    expect(group.steps[0].name).toBe('email');
    expect(group.steps[1].name).toBe('crm');
  });

  it('parallel group is interleaved with sequential steps correctly', () => {
    const { steps } = new SagaBuilder()
      .addStep(makeStep('before', undefined))
      .addParallelSteps([makeStep('par-a', undefined), makeStep('par-b', undefined)])
      .addStep(makeStep('after', undefined))
      .build();

    expect(steps).toHaveLength(3);
    expect((steps[0] as SagaStep).name).toBe('before');
    expect('parallel' in steps[1] && steps[1].parallel).toBe(true);
    expect((steps[2] as SagaStep).name).toBe('after');
  });
});

// ---------------------------------------------------------------------------
// Step 2.1 – SagaExecutor – parallel execution
// ---------------------------------------------------------------------------

describe('SagaExecutor – parallel step execution', () => {
  it('executes all steps in a parallel group', async () => {
    const emailStep = makeStep('email', 'email-ok');
    const crmStep = makeStep('crm', 'crm-ok');

    const definition = new SagaBuilder()
      .addParallelSteps([emailStep, crmStep])
      .build();

    const ctx = makeCtx();
    await new SagaExecutor(definition, ctx).run();

    expect(emailStep.execute).toHaveBeenCalledTimes(1);
    expect(crmStep.execute).toHaveBeenCalledTimes(1);
    expect(ctx.results['email']).toBe('email-ok');
    expect(ctx.results['crm']).toBe('crm-ok');
  });

  it('runs parallel steps concurrently (faster than sequential)', async () => {
    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const step1: SagaStep<string, SagaContext> = {
      name: 'slow-a',
      execute: vi.fn(async () => {
        await delay(30);
        return 'a';
      }),
      compensate: vi.fn(async () => undefined),
    };
    const step2: SagaStep<string, SagaContext> = {
      name: 'slow-b',
      execute: vi.fn(async () => {
        await delay(30);
        return 'b';
      }),
      compensate: vi.fn(async () => undefined),
    };

    const definition = new SagaBuilder().addParallelSteps([step1, step2]).build();
    const start = Date.now();
    await new SagaExecutor(definition, makeCtx()).run();
    const elapsed = Date.now() - start;

    // If truly parallel, both 30ms steps finish in ~30ms, not ~60ms.
    expect(elapsed).toBeLessThan(55);
  });

  it('stores results from all parallel steps in context', async () => {
    const definition = new SagaBuilder()
      .addParallelSteps([makeStep('s1', { id: 1 }), makeStep('s2', { id: 2 })])
      .build();

    const ctx = makeCtx();
    await new SagaExecutor(definition, ctx).run();

    expect(ctx.results['s1']).toEqual({ id: 1 });
    expect(ctx.results['s2']).toEqual({ id: 2 });
  });

  it('compensates all successfully completed parallel steps when one fails', async () => {
    const emailStep = makeStep('email', 'sent');
    const failStep: SagaStep<void, SagaContext> = {
      name: 'crm',
      execute: vi.fn(async () => {
        throw new Error('crm-failed');
      }),
      compensate: vi.fn(async () => undefined),
    };

    const definition = new SagaBuilder()
      .addParallelSteps([emailStep, failStep])
      .build();

    await expect(new SagaExecutor(definition, makeCtx()).run()).rejects.toThrow('crm-failed');

    // email step succeeded and must be compensated; crm never completed so no compensate
    expect(emailStep.compensate).toHaveBeenCalledTimes(1);
    expect(failStep.compensate).not.toHaveBeenCalled();
  });

  it('compensates prior sequential steps when a parallel group fails', async () => {
    const seqStep = makeStep('seq', 'seq-result');
    const failStep: SagaStep<void, SagaContext> = {
      name: 'par-fail',
      execute: vi.fn(async () => {
        throw new Error('par-fail');
      }),
      compensate: vi.fn(async () => undefined),
    };

    const definition = new SagaBuilder()
      .addStep(seqStep)
      .addParallelSteps([failStep])
      .build();

    await expect(new SagaExecutor(definition, makeCtx()).run()).rejects.toThrow('par-fail');

    expect(seqStep.compensate).toHaveBeenCalledTimes(1);
  });

  it('executes sequential steps after a successful parallel group', async () => {
    const afterStep = makeStep('after', 'done');

    const definition = new SagaBuilder()
      .addParallelSteps([makeStep('p1', 'x'), makeStep('p2', 'y')])
      .addStep(afterStep)
      .build();

    const ctx = makeCtx();
    await new SagaExecutor(definition, ctx).run();

    expect(afterStep.execute).toHaveBeenCalledTimes(1);
    expect(ctx.results['after']).toBe('done');
  });

  it('dry-run includes parallel steps in the plan with parallel: true', async () => {
    const definition = new SagaBuilder()
      .addStep(makeStep('seq', undefined))
      .addParallelSteps([makeStep('par-a', undefined), makeStep('par-b', undefined)])
      .build();

    const result = (await new SagaExecutor(definition, makeCtx()).run({
      dryRun: true,
    })) as DryRunResult;

    expect(result.plan).toHaveLength(3);
    expect(result.plan[0].name).toBe('seq');
    expect(result.plan[0].parallel).toBeUndefined();
    expect(result.plan[1].name).toBe('par-a');
    expect(result.plan[1].parallel).toBe(true);
    expect(result.plan[2].name).toBe('par-b');
    expect(result.plan[2].parallel).toBe(true);
  });

  it('onBeforeStep hook fires for each parallel step', async () => {
    const beforeLog: string[] = [];
    const definition = new SagaBuilder()
      .addParallelSteps([makeStep('p1', undefined), makeStep('p2', undefined)])
      .build();

    await new SagaExecutor(definition, makeCtx())
      .onBeforeStep((name) => { beforeLog.push(name); })
      .run();

    expect(beforeLog).toContain('p1');
    expect(beforeLog).toContain('p2');
  });

  it('onError hook fires for the failing parallel step', async () => {
    const errorLog: string[] = [];
    const definition = new SagaBuilder()
      .addParallelSteps([
        makeStep('p-ok', undefined),
        {
          name: 'p-fail',
          execute: vi.fn(async () => { throw new Error('fail'); }),
          compensate: vi.fn(async () => undefined),
        },
      ])
      .build();

    await expect(
      new SagaExecutor(definition, makeCtx())
        .onError((name) => { errorLog.push(name); })
        .run(),
    ).rejects.toThrow('fail');

    expect(errorLog).toContain('p-fail');
  });

  it('parallel step state is persisted via the adapter (idempotency)', async () => {
    const adapter = new InMemoryAdapter();
    const step = makeStep('par-step', 'value');
    const definition = new SagaBuilder().addParallelSteps([step]).build();

    await new SagaExecutor(definition, makeCtx(), adapter).run();

    const state = await adapter.loadState('par-step');
    expect(state?.status).toBe('completed');
    expect(state?.result).toBe('value');
  });

  it('compensates parallel steps in context of SagaCompensationError', async () => {
    const step1: SagaStep<void, SagaContext> = {
      name: 'p-compensate-fail',
      execute: vi.fn(async () => undefined),
      compensate: vi.fn(async () => { throw new Error('compensate-failed'); }),
      metadata: { compensationRetries: 0 },
    };
    const step2: SagaStep<void, SagaContext> = {
      name: 'p-fail',
      execute: vi.fn(async () => { throw new Error('execute-failed'); }),
      compensate: vi.fn(async () => undefined),
    };

    const definition = new SagaBuilder().addParallelSteps([step1, step2]).build();
    const err = await new SagaExecutor(definition, makeCtx()).run().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SagaCompensationError);
    expect((err as SagaCompensationError).stepName).toBe('p-compensate-fail');
  });
});

// ---------------------------------------------------------------------------
// Step 2.2 – Serialization guardrails
// ---------------------------------------------------------------------------

describe('isJsonSerializable()', () => {
  it('returns true for plain objects', () => {
    expect(isJsonSerializable({ id: 1, name: 'Alice' })).toBe(true);
  });

  it('returns true for primitives', () => {
    expect(isJsonSerializable(42)).toBe(true);
    expect(isJsonSerializable('hello')).toBe(true);
    expect(isJsonSerializable(null)).toBe(true);
    expect(isJsonSerializable(true)).toBe(true);
  });

  it('returns true for arrays', () => {
    expect(isJsonSerializable([1, 'two', { three: 3 }])).toBe(true);
  });

  it('returns false for circular references', () => {
    const obj: Record<string, unknown> = {};
    obj['self'] = obj;
    expect(isJsonSerializable(obj)).toBe(false);
  });
});

describe('assertJsonSerializable()', () => {
  it('does not throw for serializable values', () => {
    expect(() => assertJsonSerializable({ ok: true }, 'my-step')).not.toThrow();
  });

  it('throws SerializationError for circular objects', () => {
    const obj: Record<string, unknown> = {};
    obj['self'] = obj;
    expect(() => assertJsonSerializable(obj, 'my-step')).toThrowError(SerializationError);
  });

  it('SerializationError includes the step name', () => {
    const obj: Record<string, unknown> = {};
    obj['self'] = obj;
    let caught: unknown;
    try {
      assertJsonSerializable(obj, 'bad-step');
    } catch (e) {
      caught = e;
    }
    expect((caught as SerializationError).stepName).toBe('bad-step');
  });

  it('SerializationError has name "SerializationError"', () => {
    const obj: Record<string, unknown> = {};
    obj['self'] = obj;
    let caught: unknown;
    try {
      assertJsonSerializable(obj, 'step');
    } catch (e) {
      caught = e;
    }
    expect((caught as SerializationError).name).toBe('SerializationError');
    expect(caught).toBeInstanceOf(Error);
  });
});

describe('SagaExecutor – serialization guardrail', () => {
  it('throws SerializationError when a step returns a circular object', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    const step: SagaStep<unknown, SagaContext> = {
      name: 'bad-step',
      execute: vi.fn(async () => circular),
      compensate: vi.fn(async () => undefined),
    };

    const definition = new SagaBuilder().addStep(step).build();
    const err = await new SagaExecutor(definition, makeCtx()).run().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SerializationError);
    expect((err as SerializationError).stepName).toBe('bad-step');
  });

  it('triggers rollback when a step returns a non-serializable value', async () => {
    const step1 = makeStep('step-1', 'ok');
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const step2: SagaStep<unknown, SagaContext> = {
      name: 'step-2',
      execute: vi.fn(async () => circular),
      compensate: vi.fn(async () => undefined),
    };

    const definition = new SagaBuilder().addStep(step1).addStep(step2).build();
    const err = await new SagaExecutor(definition, makeCtx()).run().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SerializationError);
    // step-1 completed and must be compensated
    expect(step1.compensate).toHaveBeenCalledTimes(1);
  });

  it('does NOT throw for JSON-serializable step results', async () => {
    const step = makeStep('step-1', { id: 1, items: ['a', 'b'] });
    const definition = new SagaBuilder().addStep(step).build();
    const ctx = makeCtx();
    const result = await new SagaExecutor(definition, ctx).run();
    expect(result).toBe(ctx);
  });
});

// ---------------------------------------------------------------------------
// Step 2.3 – Logger interface
// ---------------------------------------------------------------------------

describe('SagaExecutor – logger', () => {
  function makeLogger(): Logger {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
  }

  it('accepts a logger as the 4th constructor argument without error', () => {
    const definition = new SagaBuilder().addStep(makeStep('s', undefined)).build();
    expect(
      () => new SagaExecutor(definition, makeCtx(), undefined, makeLogger()),
    ).not.toThrow();
  });

  it('calls logger.info for saga:start and saga:complete', async () => {
    const logger = makeLogger();
    const definition = new SagaBuilder().addStep(makeStep('step-1', 'x')).build();
    await new SagaExecutor(definition, makeCtx(), undefined, logger).run();

    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(infoCalls).toContain('saga:start');
    expect(infoCalls).toContain('saga:complete');
  });

  it('calls logger.info for step:complete after a successful step', async () => {
    const logger = makeLogger();
    const definition = new SagaBuilder().addStep(makeStep('my-step', 42)).build();
    await new SagaExecutor(definition, makeCtx(), undefined, logger).run();

    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const stepComplete = infoCalls.find(
      (c: unknown[]) => c[0] === 'step:complete' && (c[1] as { stepName: string }).stepName === 'my-step',
    );
    expect(stepComplete).toBeDefined();
  });

  it('calls logger.error for step:error when a step throws', async () => {
    const logger = makeLogger();
    const step: SagaStep<void, SagaContext> = {
      name: 'bad-step',
      execute: vi.fn(async () => { throw new Error('boom'); }),
      compensate: vi.fn(async () => undefined),
    };
    const definition = new SagaBuilder().addStep(step).build();
    await expect(
      new SagaExecutor(definition, makeCtx(), undefined, logger).run(),
    ).rejects.toThrow('boom');

    const errorCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls;
    const stepError = errorCalls.find(
      (c: unknown[]) => c[0] === 'step:error' && (c[1] as { stepName: string }).stepName === 'bad-step',
    );
    expect(stepError).toBeDefined();
  });

  it('calls logger.info for step:compensate during rollback', async () => {
    const logger = makeLogger();
    const step1 = makeStep('step-1', undefined);
    const step2: SagaStep<void, SagaContext> = {
      name: 'step-2',
      execute: vi.fn(async () => { throw new Error('fail'); }),
      compensate: vi.fn(async () => undefined),
    };
    const definition = new SagaBuilder().addStep(step1).addStep(step2).build();
    await expect(
      new SagaExecutor(definition, makeCtx(), undefined, logger).run(),
    ).rejects.toThrow('fail');

    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const compensateCall = infoCalls.find(
      (c: unknown[]) => c[0] === 'step:compensate' && (c[1] as { stepName: string }).stepName === 'step-1',
    );
    expect(compensateCall).toBeDefined();
  });

  it('works correctly when no logger is provided (undefined)', async () => {
    const definition = new SagaBuilder().addStep(makeStep('step-1', 'val')).build();
    const ctx = makeCtx();
    // Should not throw even without a logger
    const result = await new SagaExecutor(definition, ctx).run();
    expect(result).toBe(ctx);
  });

  it('calls logger.debug for step:start before each step', async () => {
    const logger = makeLogger();
    const definition = new SagaBuilder().addStep(makeStep('my-step', 1)).build();
    await new SagaExecutor(definition, makeCtx(), undefined, logger).run();

    const debugCalls = (logger.debug as ReturnType<typeof vi.fn>).mock.calls;
    const stepStart = debugCalls.find(
      (c: unknown[]) => c[0] === 'step:start' && (c[1] as { stepName: string }).stepName === 'my-step',
    );
    expect(stepStart).toBeDefined();
  });

  it('calls logger for parallel group steps', async () => {
    const logger = makeLogger();
    const definition = new SagaBuilder()
      .addParallelSteps([makeStep('p1', 'a'), makeStep('p2', 'b')])
      .build();
    await new SagaExecutor(definition, makeCtx(), undefined, logger).run();

    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const p1Complete = infoCalls.find(
      (c: unknown[]) => c[0] === 'step:complete' && (c[1] as { stepName: string }).stepName === 'p1',
    );
    const p2Complete = infoCalls.find(
      (c: unknown[]) => c[0] === 'step:complete' && (c[1] as { stepName: string }).stepName === 'p2',
    );
    expect(p1Complete).toBeDefined();
    expect(p2Complete).toBeDefined();
  });
});
