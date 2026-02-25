import { describe, it, expect, vi } from 'vitest';
import { SagaBuilder } from '../builder.js';
import { SagaExecutor } from '../executor.js';
import { InMemoryAdapter } from '../persistence.js';
import type { SagaStateAdapter, StepState } from '../persistence.js';
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

function makeCtx(): SagaContext {
  return { results: {} };
}

// ---------------------------------------------------------------------------
// InMemoryAdapter – basic contract
// ---------------------------------------------------------------------------

describe('InMemoryAdapter', () => {
  it('returns undefined for an unknown key', async () => {
    const adapter = new InMemoryAdapter();
    const state = await adapter.loadState('no-such-key');
    expect(state).toBeUndefined();
  });

  it('saveState() then loadState() returns the saved state', async () => {
    const adapter = new InMemoryAdapter();
    await adapter.saveState('step-1', { status: 'completed', result: 42 });
    const state = await adapter.loadState('step-1');
    expect(state).toEqual({ status: 'completed', result: 42 });
  });

  it('overwrites an existing state when the same key is saved again', async () => {
    const adapter = new InMemoryAdapter();
    await adapter.saveState('step-1', { status: 'completed', result: 'first' });
    await adapter.saveState('step-1', { status: 'compensated' });
    const state = await adapter.loadState('step-1');
    expect(state).toEqual({ status: 'compensated' });
  });

  it('stores states for multiple independent keys without interference', async () => {
    const adapter = new InMemoryAdapter();
    await adapter.saveState('key-a', { status: 'completed', result: 1 });
    await adapter.saveState('key-b', { status: 'compensated' });

    expect(await adapter.loadState('key-a')).toEqual({ status: 'completed', result: 1 });
    expect(await adapter.loadState('key-b')).toEqual({ status: 'compensated' });
  });

  it('fulfils the SagaStateAdapter interface', () => {
    const adapter: SagaStateAdapter = new InMemoryAdapter();
    expect(typeof adapter.saveState).toBe('function');
    expect(typeof adapter.loadState).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Idempotency key generation
// ---------------------------------------------------------------------------

describe('SagaExecutor – idempotency key generation', () => {
  it('uses step.name as the idempotency key when no metadata key is provided', async () => {
    const adapter = new InMemoryAdapter();
    const step = makeStep('reserve-funds', { ok: true });

    const definition = new SagaBuilder().addStep(step).build();
    await new SagaExecutor(definition, makeCtx(), adapter).run();

    const state = await adapter.loadState('reserve-funds');
    expect(state?.status).toBe('completed');
  });

  it('uses metadata.idempotencyKey when explicitly set', async () => {
    const adapter = new InMemoryAdapter();
    const step: SagaStep<string, SagaContext> = {
      name: 'my-step',
      execute: vi.fn(async () => 'result'),
      compensate: vi.fn(async () => undefined),
      metadata: { idempotencyKey: 'custom-key-xyz' },
    };

    const definition = new SagaBuilder().addStep(step).build();
    await new SagaExecutor(definition, makeCtx(), adapter).run();

    // custom key stored, not the step name
    expect(await adapter.loadState('custom-key-xyz')).toEqual({
      status: 'completed',
      result: 'result',
    });
    expect(await adapter.loadState('my-step')).toBeUndefined();
  });

  it('generates distinct keys for distinct steps', async () => {
    const adapter = new InMemoryAdapter();
    const definition = new SagaBuilder()
      .addStep(makeStep('step-a', 1))
      .addStep(makeStep('step-b', 2))
      .build();

    await new SagaExecutor(definition, makeCtx(), adapter).run();

    const stateA = await adapter.loadState('step-a');
    const stateB = await adapter.loadState('step-b');
    expect(stateA?.status).toBe('completed');
    expect(stateB?.status).toBe('completed');
    // Keys are different objects – no accidental sharing
    expect(stateA).not.toBe(stateB);
  });

  it('compensation key is derived from the execute key with ":compensate" suffix', async () => {
    const adapter = new InMemoryAdapter();
    const step1 = makeStep('step-1', undefined);
    const step2: SagaStep<void, SagaContext> = {
      name: 'step-2',
      execute: vi.fn(async () => {
        throw new Error('fail');
      }),
      compensate: vi.fn(async () => undefined),
    };

    const definition = new SagaBuilder().addStep(step1).addStep(step2).build();
    await expect(new SagaExecutor(definition, makeCtx(), adapter).run()).rejects.toThrow('fail');

    expect(await adapter.loadState('step-1:compensate')).toEqual({ status: 'compensated' });
  });

  it('custom idempotencyKey is used as the base for the compensation key', async () => {
    const adapter = new InMemoryAdapter();
    const step1: SagaStep<void, SagaContext> = {
      name: 'step-1',
      execute: vi.fn(async () => undefined),
      compensate: vi.fn(async () => undefined),
      metadata: { idempotencyKey: 'my-custom-key' },
    };
    const step2: SagaStep<void, SagaContext> = {
      name: 'step-2',
      execute: vi.fn(async () => {
        throw new Error('fail');
      }),
      compensate: vi.fn(async () => undefined),
    };

    const definition = new SagaBuilder().addStep(step1).addStep(step2).build();
    await expect(new SagaExecutor(definition, makeCtx(), adapter).run()).rejects.toThrow('fail');

    expect(await adapter.loadState('my-custom-key:compensate')).toEqual({
      status: 'compensated',
    });
  });
});

// ---------------------------------------------------------------------------
// Checkpointing – saveState called after each success
// ---------------------------------------------------------------------------

describe('SagaExecutor – checkpointing', () => {
  it('calls saveState after every successful step execute', async () => {
    const adapter: SagaStateAdapter = {
      saveState: vi.fn(async () => undefined),
      loadState: vi.fn(async () => undefined),
    };

    const definition = new SagaBuilder()
      .addStep(makeStep('step-1', 'a'))
      .addStep(makeStep('step-2', 'b'))
      .build();

    await new SagaExecutor(definition, makeCtx(), adapter).run();

    expect(adapter.saveState).toHaveBeenCalledWith('step-1', {
      status: 'completed',
      result: 'a',
    });
    expect(adapter.saveState).toHaveBeenCalledWith('step-2', {
      status: 'completed',
      result: 'b',
    });
  });

  it('calls saveState after every successful compensation', async () => {
    const adapter: SagaStateAdapter = {
      saveState: vi.fn(async () => undefined),
      loadState: vi.fn(async () => undefined),
    };

    const step1 = makeStep('step-1', undefined);
    const step2: SagaStep<void, SagaContext> = {
      name: 'step-2',
      execute: vi.fn(async () => {
        throw new Error('step-2 failed');
      }),
      compensate: vi.fn(async () => undefined),
    };

    const definition = new SagaBuilder().addStep(step1).addStep(step2).build();
    await expect(new SagaExecutor(definition, makeCtx(), adapter).run()).rejects.toThrow(
      'step-2 failed',
    );

    expect(adapter.saveState).toHaveBeenCalledWith('step-1:compensate', {
      status: 'compensated',
    });
  });

  it('does not call saveState when a step execute throws', async () => {
    const saved: string[] = [];
    const adapter: SagaStateAdapter = {
      saveState: vi.fn(async (key) => {
        saved.push(key);
      }),
      loadState: vi.fn(async () => undefined),
    };

    const step1: SagaStep<void, SagaContext> = {
      name: 'failing-step',
      execute: vi.fn(async () => {
        throw new Error('oops');
      }),
      compensate: vi.fn(async () => undefined),
    };

    const definition = new SagaBuilder().addStep(step1).build();
    await expect(new SagaExecutor(definition, makeCtx(), adapter).run()).rejects.toThrow('oops');

    // saveState should not have been called for the failed step's execute
    expect(saved).not.toContain('failing-step');
  });
});

// ---------------------------------------------------------------------------
// Idempotency checks – skip if already completed / compensated
// ---------------------------------------------------------------------------

describe('SagaExecutor – idempotency skip on execute', () => {
  it('skips execute() when the step is already marked completed in the adapter', async () => {
    const adapter = new InMemoryAdapter();
    await adapter.saveState('step-1', { status: 'completed', result: 'cached' });

    const executeFn = vi.fn(async () => 'fresh');
    const step: SagaStep<string, SagaContext> = {
      name: 'step-1',
      execute: executeFn,
      compensate: vi.fn(async () => undefined),
    };

    const definition = new SagaBuilder().addStep(step).build();
    const ctx = makeCtx();
    await new SagaExecutor(definition, ctx, adapter).run();

    expect(executeFn).not.toHaveBeenCalled();
    expect(ctx.results['step-1']).toBe('cached');
  });

  it('replays the stored result when a step is skipped due to idempotency', async () => {
    const adapter = new InMemoryAdapter();
    await adapter.saveState('order-step', {
      status: 'completed',
      result: { orderId: 'ord-42' },
    });

    const step: SagaStep<{ orderId: string }, SagaContext> = {
      name: 'order-step',
      execute: vi.fn(async () => ({ orderId: 'ord-NEW' })),
      compensate: vi.fn(async () => undefined),
    };

    const definition = new SagaBuilder().addStep(step).build();
    const ctx = makeCtx();
    await new SagaExecutor(definition, ctx, adapter).run();

    expect((ctx.results['order-step'] as { orderId: string }).orderId).toBe('ord-42');
  });

  it('still runs execute() when existing state is "compensated" (not "completed")', async () => {
    const adapter = new InMemoryAdapter();
    // A "compensated" state on the execute key should NOT block re-execution.
    await adapter.saveState('step-1', { status: 'compensated' });

    const executeFn = vi.fn(async () => 'ran');
    const step: SagaStep<string, SagaContext> = {
      name: 'step-1',
      execute: executeFn,
      compensate: vi.fn(async () => undefined),
    };

    const definition = new SagaBuilder().addStep(step).build();
    await new SagaExecutor(definition, makeCtx(), adapter).run();

    expect(executeFn).toHaveBeenCalledTimes(1);
  });
});

describe('SagaExecutor – idempotency skip on compensate', () => {
  it('skips compensate() when the compensation is already marked in the adapter', async () => {
    const adapter = new InMemoryAdapter();
    // Pre-seed completed execute state and compensated state.
    await adapter.saveState('step-1', { status: 'completed', result: undefined });
    await adapter.saveState('step-1:compensate', { status: 'compensated' });

    const compensateFn = vi.fn(async () => undefined);
    const step1: SagaStep<void, SagaContext> = {
      name: 'step-1',
      execute: vi.fn(async () => undefined),
      compensate: compensateFn,
    };
    const step2: SagaStep<void, SagaContext> = {
      name: 'step-2',
      execute: vi.fn(async () => {
        throw new Error('fail');
      }),
      compensate: vi.fn(async () => undefined),
    };

    const definition = new SagaBuilder().addStep(step1).addStep(step2).build();
    await expect(new SagaExecutor(definition, makeCtx(), adapter).run()).rejects.toThrow('fail');

    expect(compensateFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SagaExecutor – default adapter (no adapter provided)
// ---------------------------------------------------------------------------

describe('SagaExecutor – default InMemoryAdapter', () => {
  it('works correctly without an explicit adapter argument', async () => {
    const step = makeStep('step-1', 'value');
    const definition = new SagaBuilder().addStep(step).build();
    const ctx = makeCtx();
    await new SagaExecutor(definition, ctx).run();
    expect(ctx.results['step-1']).toBe('value');
  });
});

// ---------------------------------------------------------------------------
// StepState – type contract (runtime checks)
// ---------------------------------------------------------------------------

describe('StepState', () => {
  it('accepts status "completed" with a result', () => {
    const state: StepState = { status: 'completed', result: { id: 1 } };
    expect(state.status).toBe('completed');
    expect(state.result).toEqual({ id: 1 });
  });

  it('accepts status "compensated" without a result', () => {
    const state: StepState = { status: 'compensated' };
    expect(state.status).toBe('compensated');
    expect(state.result).toBeUndefined();
  });
});
