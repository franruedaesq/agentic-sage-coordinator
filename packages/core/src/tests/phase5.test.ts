import { describe, it, expect, vi } from 'vitest';
import { SagaBuilder } from '../builder.js';
import { SagaExecutor } from '../executor.js';
import { InMemoryAdapter } from '../persistence.js';
import { PendingApprovalError } from '../types.js';
import type { SagaContext, SagaStep, DryRunResult, PendingApprovalResult } from '../types.js';

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
// Dry-run mode
// ---------------------------------------------------------------------------

describe('SagaExecutor – dry-run mode', () => {
  it('run({ dryRun: true }) returns a DryRunResult, not the context', async () => {
    const definition = new SagaBuilder().addStep(makeStep('step-1', 'x')).build();
    const result = await new SagaExecutor(definition, makeCtx()).run({ dryRun: true });
    expect((result as DryRunResult).dryRun).toBe(true);
    expect(Array.isArray((result as DryRunResult).plan)).toBe(true);
  });

  it('dry-run result contains every step name in insertion order', async () => {
    const definition = new SagaBuilder()
      .addStep(makeStep('step-1', undefined))
      .addStep(makeStep('step-2', undefined))
      .addStep(makeStep('step-3', undefined))
      .build();

    const result = (await new SagaExecutor(definition, makeCtx()).run({
      dryRun: true,
    })) as DryRunResult;

    expect(result.plan.map((s) => s.name)).toEqual(['step-1', 'step-2', 'step-3']);
  });

  it('dry-run result includes description and skipOnDryRun from step metadata', async () => {
    const step: SagaStep<void, SagaContext> = {
      name: 'described-step',
      execute: vi.fn(async () => undefined),
      compensate: vi.fn(async () => undefined),
      metadata: { description: 'Does something', skipOnDryRun: true },
    };

    const definition = new SagaBuilder().addStep(step).build();
    const result = (await new SagaExecutor(definition, makeCtx()).run({
      dryRun: true,
    })) as DryRunResult;

    expect(result.plan[0].description).toBe('Does something');
    expect(result.plan[0].skipOnDryRun).toBe(true);
  });

  it('does NOT call execute() on any step during a dry-run', async () => {
    const step1 = makeStep('step-1', 'a');
    const step2 = makeStep('step-2', 'b');
    const definition = new SagaBuilder().addStep(step1).addStep(step2).build();

    await new SagaExecutor(definition, makeCtx()).run({ dryRun: true });

    expect(step1.execute).not.toHaveBeenCalled();
    expect(step2.execute).not.toHaveBeenCalled();
  });

  it('does NOT call compensate() on any step during a dry-run', async () => {
    const step1 = makeStep('step-1', undefined);
    const step2 = makeStep('step-2', undefined);
    const definition = new SagaBuilder().addStep(step1).addStep(step2).build();

    await new SagaExecutor(definition, makeCtx()).run({ dryRun: true });

    expect(step1.compensate).not.toHaveBeenCalled();
    expect(step2.compensate).not.toHaveBeenCalled();
  });

  it('does NOT persist any state to the adapter during a dry-run', async () => {
    const adapter = new InMemoryAdapter();
    const definition = new SagaBuilder().addStep(makeStep('step-1', 'val')).build();

    await new SagaExecutor(definition, makeCtx(), adapter).run({ dryRun: true });

    expect(await adapter.loadState('step-1')).toBeUndefined();
  });

  it('a step with no metadata has undefined description and skipOnDryRun in the plan', async () => {
    const definition = new SagaBuilder().addStep(makeStep('plain-step', 1)).build();
    const result = (await new SagaExecutor(definition, makeCtx()).run({
      dryRun: true,
    })) as DryRunResult;

    expect(result.plan[0].description).toBeUndefined();
    expect(result.plan[0].skipOnDryRun).toBeUndefined();
  });

  it('normal run() (without dryRun flag) still returns the context', async () => {
    const definition = new SagaBuilder().addStep(makeStep('step-1', 99)).build();
    const ctx = makeCtx();
    const result = await new SagaExecutor(definition, ctx).run();
    expect(result).toBe(ctx);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

describe('SagaExecutor – lifecycle hooks', () => {
  it('onBeforeStep() hook is called before each step execute()', async () => {
    const beforeLog: string[] = [];
    const step1 = makeStep('step-1', 'a');
    const step2 = makeStep('step-2', 'b');
    const definition = new SagaBuilder().addStep(step1).addStep(step2).build();

    await new SagaExecutor(definition, makeCtx())
      .onBeforeStep((name) => {
        beforeLog.push(name);
      })
      .run();

    expect(beforeLog).toEqual(['step-1', 'step-2']);
  });

  it('onBeforeStep() receives the current context', async () => {
    let capturedCtx: SagaContext | undefined;
    const definition = new SagaBuilder().addStep(makeStep('step-1', 42)).build();
    const ctx = makeCtx();

    await new SagaExecutor(definition, ctx).onBeforeStep((_, c) => {
      capturedCtx = c;
    }).run();

    expect(capturedCtx).toBe(ctx);
  });

  it('onAfterStep() hook is called after each successful step execute()', async () => {
    const afterLog: Array<{ name: string; result: unknown }> = [];
    const definition = new SagaBuilder()
      .addStep(makeStep('step-1', 'res-1'))
      .addStep(makeStep('step-2', 'res-2'))
      .build();

    await new SagaExecutor(definition, makeCtx())
      .onAfterStep((name, result) => {
        afterLog.push({ name, result });
      })
      .run();

    expect(afterLog).toEqual([
      { name: 'step-1', result: 'res-1' },
      { name: 'step-2', result: 'res-2' },
    ]);
  });

  it('onAfterStep() is NOT called when a step throws', async () => {
    const afterLog: string[] = [];
    const step1: SagaStep<void, SagaContext> = {
      name: 'failing-step',
      execute: vi.fn(async () => {
        throw new Error('boom');
      }),
      compensate: vi.fn(async () => undefined),
    };
    const definition = new SagaBuilder().addStep(step1).build();

    await expect(
      new SagaExecutor(definition, makeCtx())
        .onAfterStep((name) => {
          afterLog.push(name);
        })
        .run(),
    ).rejects.toThrow('boom');

    expect(afterLog).toHaveLength(0);
  });

  it('onError() hook is called when a step throws', async () => {
    const errorLog: Array<{ name: string; error: unknown }> = [];
    const boom = new Error('step failed');
    const step1: SagaStep<void, SagaContext> = {
      name: 'bad-step',
      execute: vi.fn(async () => {
        throw boom;
      }),
      compensate: vi.fn(async () => undefined),
    };
    const definition = new SagaBuilder().addStep(step1).build();

    await expect(
      new SagaExecutor(definition, makeCtx())
        .onError((name, err) => {
          errorLog.push({ name, error: err });
        })
        .run(),
    ).rejects.toThrow('step failed');

    expect(errorLog).toHaveLength(1);
    expect(errorLog[0].name).toBe('bad-step');
    expect(errorLog[0].error).toBe(boom);
  });

  it('onCompensation() hook is called for each compensated step during rollback', async () => {
    const compensationLog: string[] = [];
    const step1 = makeStep('step-1', undefined);
    const step2: SagaStep<void, SagaContext> = {
      name: 'step-2',
      execute: vi.fn(async () => {
        throw new Error('fail');
      }),
      compensate: vi.fn(async () => undefined),
    };
    const definition = new SagaBuilder().addStep(step1).addStep(step2).build();

    await expect(
      new SagaExecutor(definition, makeCtx())
        .onCompensation((name) => {
          compensationLog.push(name);
        })
        .run(),
    ).rejects.toThrow('fail');

    expect(compensationLog).toEqual(['step-1']);
  });

  it('onCompensation() receives the step result that was produced at execute-time', async () => {
    const compensationResults: unknown[] = [];
    const step1 = makeStep('step-1', { payload: 'data' });
    const step2: SagaStep<void, SagaContext> = {
      name: 'step-2',
      execute: vi.fn(async () => {
        throw new Error('fail');
      }),
      compensate: vi.fn(async () => undefined),
    };
    const definition = new SagaBuilder().addStep(step1).addStep(step2).build();

    await expect(
      new SagaExecutor(definition, makeCtx())
        .onCompensation((_name, result) => {
          compensationResults.push(result);
        })
        .run(),
    ).rejects.toThrow('fail');

    expect(compensationResults).toEqual([{ payload: 'data' }]);
  });

  it('multiple hooks of the same type are all called in registration order', async () => {
    const log: string[] = [];
    const definition = new SagaBuilder().addStep(makeStep('step-1', undefined)).build();

    await new SagaExecutor(definition, makeCtx())
      .onBeforeStep(() => { log.push('hook-1'); })
      .onBeforeStep(() => { log.push('hook-2'); })
      .run();

    expect(log).toEqual(['hook-1', 'hook-2']);
  });

  it('onBeforeStep() is NOT called for steps that are skipped via idempotency', async () => {
    const adapter = new InMemoryAdapter();
    await adapter.saveState('step-1', { status: 'completed', result: 'cached' });

    const beforeLog: string[] = [];
    const definition = new SagaBuilder().addStep(makeStep('step-1', 'fresh')).build();

    await new SagaExecutor(definition, makeCtx(), adapter)
      .onBeforeStep((name) => { beforeLog.push(name); })
      .run();

    expect(beforeLog).toHaveLength(0);
  });

  it('hook registration methods return `this` for fluent chaining', () => {
    const definition = new SagaBuilder().addStep(makeStep('step-1', undefined)).build();
    const executor = new SagaExecutor(definition, makeCtx());
    expect(executor.onBeforeStep(() => undefined)).toBe(executor);
    expect(executor.onAfterStep(() => undefined)).toBe(executor);
    expect(executor.onError(() => undefined)).toBe(executor);
    expect(executor.onCompensation(() => undefined)).toBe(executor);
  });
});

// ---------------------------------------------------------------------------
// HITL – PendingApprovalError
// ---------------------------------------------------------------------------

describe('PendingApprovalError', () => {
  it('is an instance of Error', () => {
    const err = new PendingApprovalError();
    expect(err).toBeInstanceOf(Error);
  });

  it('has name "PendingApprovalError"', () => {
    const err = new PendingApprovalError();
    expect(err.name).toBe('PendingApprovalError');
  });
});

// ---------------------------------------------------------------------------
// HITL – pause on PendingApprovalError
// ---------------------------------------------------------------------------

describe('SagaExecutor – HITL pause', () => {
  it('run() returns PendingApprovalResult when a step throws PendingApprovalError', async () => {
    const step: SagaStep<void, SagaContext> = {
      name: 'approval-step',
      execute: vi.fn(async () => {
        throw new PendingApprovalError();
      }),
      compensate: vi.fn(async () => undefined),
    };
    const definition = new SagaBuilder().addStep(step).build();
    const result = await new SagaExecutor(definition, makeCtx()).run();

    expect((result as PendingApprovalResult).status).toBe('pending_approval');
    expect((result as PendingApprovalResult).stepName).toBe('approval-step');
  });

  it('does NOT compensate previously completed steps when pausing for approval', async () => {
    const step1 = makeStep('step-1', undefined);
    const step2: SagaStep<void, SagaContext> = {
      name: 'approval-step',
      execute: vi.fn(async () => {
        throw new PendingApprovalError();
      }),
      compensate: vi.fn(async () => undefined),
    };
    const definition = new SagaBuilder().addStep(step1).addStep(step2).build();
    await new SagaExecutor(definition, makeCtx()).run();

    expect(step1.compensate).not.toHaveBeenCalled();
    expect(step2.compensate).not.toHaveBeenCalled();
  });

  it('saves the pending step state to the adapter when pausing', async () => {
    const adapter = new InMemoryAdapter();
    const step: SagaStep<void, SagaContext> = {
      name: 'approval-step',
      execute: vi.fn(async () => {
        throw new PendingApprovalError();
      }),
      compensate: vi.fn(async () => undefined),
    };
    const definition = new SagaBuilder().addStep(step).build();
    await new SagaExecutor(definition, makeCtx(), adapter).run();

    const state = await adapter.loadState('approval-step');
    expect(state?.status).toBe('pending_approval');
  });

  it('calling run() again while step is pending returns PendingApprovalResult again', async () => {
    const adapter = new InMemoryAdapter();
    const step: SagaStep<void, SagaContext> = {
      name: 'approval-step',
      execute: vi.fn(async () => {
        throw new PendingApprovalError();
      }),
      compensate: vi.fn(async () => undefined),
    };
    const definition = new SagaBuilder().addStep(step).build();
    const executor = new SagaExecutor(definition, makeCtx(), adapter);

    const first = await executor.run();
    expect((first as PendingApprovalResult).status).toBe('pending_approval');

    // Second call should not re-execute; step is still pending.
    const second = await executor.run();
    expect((second as PendingApprovalResult).status).toBe('pending_approval');
    expect(step.execute).toHaveBeenCalledTimes(1);
  });

  it('onError() hook is called when a step throws PendingApprovalError', async () => {
    const errorLog: string[] = [];
    const step: SagaStep<void, SagaContext> = {
      name: 'approval-step',
      execute: vi.fn(async () => {
        throw new PendingApprovalError();
      }),
      compensate: vi.fn(async () => undefined),
    };
    const definition = new SagaBuilder().addStep(step).build();

    await new SagaExecutor(definition, makeCtx())
      .onError((name) => { errorLog.push(name); })
      .run();

    expect(errorLog).toContain('approval-step');
  });
});

// ---------------------------------------------------------------------------
// HITL – resume
// ---------------------------------------------------------------------------

describe('SagaExecutor – HITL resume', () => {
  it('resume() continues execution after the paused step', async () => {
    const step1 = makeStep('step-1', 'first');
    const step2: SagaStep<void, SagaContext> = {
      name: 'approval-step',
      execute: vi.fn(async () => {
        throw new PendingApprovalError();
      }),
      compensate: vi.fn(async () => undefined),
    };
    const step3 = makeStep('step-3', 'third');

    const definition = new SagaBuilder()
      .addStep(step1)
      .addStep(step2)
      .addStep(step3)
      .build();

    const adapter = new InMemoryAdapter();
    const ctx = makeCtx();
    const executor = new SagaExecutor(definition, ctx, adapter);

    await executor.run();
    const finalCtx = await executor.resume('approved');

    expect(finalCtx).toBe(ctx);
    expect(ctx.results['approval-step']).toBe('approved');
    expect(ctx.results['step-3']).toBe('third');
    expect(step3.execute).toHaveBeenCalledTimes(1);
  });

  it('resume() stores the approvedResult in the context', async () => {
    const step: SagaStep<void, SagaContext> = {
      name: 'approval-step',
      execute: vi.fn(async () => {
        throw new PendingApprovalError();
      }),
      compensate: vi.fn(async () => undefined),
    };
    const definition = new SagaBuilder().addStep(step).build();
    const adapter = new InMemoryAdapter();
    const ctx = makeCtx();
    const executor = new SagaExecutor(definition, ctx, adapter);

    await executor.run();
    await executor.resume({ decision: 'approved', reviewer: 'alice' });

    expect(ctx.results['approval-step']).toEqual({ decision: 'approved', reviewer: 'alice' });
  });

  it('resume() without an approvedResult stores undefined in the context', async () => {
    const step: SagaStep<void, SagaContext> = {
      name: 'approval-step',
      execute: vi.fn(async () => {
        throw new PendingApprovalError();
      }),
      compensate: vi.fn(async () => undefined),
    };
    const definition = new SagaBuilder().addStep(step).build();
    const adapter = new InMemoryAdapter();
    const ctx = makeCtx();
    const executor = new SagaExecutor(definition, ctx, adapter);

    await executor.run();
    await executor.resume();

    expect(ctx.results['approval-step']).toBeUndefined();
  });

  it('does not re-execute already-completed steps before the paused step on resume()', async () => {
    const step1 = makeStep('step-1', 'val');
    const step2: SagaStep<void, SagaContext> = {
      name: 'approval-step',
      execute: vi.fn(async () => {
        throw new PendingApprovalError();
      }),
      compensate: vi.fn(async () => undefined),
    };
    const definition = new SagaBuilder().addStep(step1).addStep(step2).build();
    const adapter = new InMemoryAdapter();
    const ctx = makeCtx();
    const executor = new SagaExecutor(definition, ctx, adapter);

    await executor.run();
    await executor.resume();

    // step-1's execute should have been called exactly once (not again on resume)
    expect(step1.execute).toHaveBeenCalledTimes(1);
  });

  it('resume() throws if called when no step is pending', async () => {
    const definition = new SagaBuilder().addStep(makeStep('step-1', undefined)).build();
    const executor = new SagaExecutor(definition, makeCtx());

    await expect(executor.resume()).rejects.toThrow(
      'SagaExecutor: no pending step found. Cannot resume.',
    );
  });

  it('marks the pending step as completed in the adapter after resume()', async () => {
    const step: SagaStep<void, SagaContext> = {
      name: 'approval-step',
      execute: vi.fn(async () => {
        throw new PendingApprovalError();
      }),
      compensate: vi.fn(async () => undefined),
    };
    const definition = new SagaBuilder().addStep(step).build();
    const adapter = new InMemoryAdapter();
    const executor = new SagaExecutor(definition, makeCtx(), adapter);

    await executor.run();
    await executor.resume('ok');

    const state = await adapter.loadState('approval-step');
    expect(state?.status).toBe('completed');
    expect(state?.result).toBe('ok');
  });
});
