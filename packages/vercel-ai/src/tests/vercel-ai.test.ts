import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { SagaBuilder } from '@agentic-sage/core';
import type { SagaContext } from '@agentic-sage/core';
import { createVercelTool } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface OrderContext extends SagaContext {
  orderId: string;
  amount: number;
}

function buildSaga(withMetadata = true) {
  const step = {
    name: 'reserve-funds',
    execute: vi.fn(async () => 'reserved'),
    compensate: vi.fn(async () => undefined),
  };

  const builder = new SagaBuilder<OrderContext>().addStep(step);

  return withMetadata
    ? builder.build({ name: 'process-order', description: 'Processes a customer order end-to-end.' })
    : builder.build();
}

const orderSchema = z.object({ orderId: z.string(), amount: z.number() });

// ---------------------------------------------------------------------------
// createVercelTool – schema shape
// ---------------------------------------------------------------------------

describe('createVercelTool – schema shape', () => {
  it('returns an object with description, parameters, and execute', () => {
    const saga = buildSaga();
    const tool = createVercelTool(saga, orderSchema, vi.fn(async () => ({})));

    expect(typeof tool.description).toBe('string');
    expect(tool.parameters).toBe(orderSchema);
    expect(typeof tool.execute).toBe('function');
  });

  it('uses saga metadata description by default', () => {
    const saga = buildSaga();
    const tool = createVercelTool(saga, orderSchema, vi.fn(async () => ({})));

    expect(tool.description).toBe('Processes a customer order end-to-end.');
  });

  it('overrides description when provided as fourth argument', () => {
    const saga = buildSaga();
    const tool = createVercelTool(
      saga,
      orderSchema,
      vi.fn(async () => ({})),
      'Custom description.',
    );

    expect(tool.description).toBe('Custom description.');
  });

  it('uses the override even when saga metadata is present', () => {
    const saga = buildSaga(true);
    const tool = createVercelTool(saga, orderSchema, vi.fn(async () => ({})), 'Override');

    expect(tool.description).toBe('Override');
  });

  it('exposes the exact Zod schema passed in', () => {
    const saga = buildSaga();
    const tool = createVercelTool(saga, orderSchema, vi.fn(async () => ({})));

    expect(tool.parameters).toBe(orderSchema);
  });
});

// ---------------------------------------------------------------------------
// createVercelTool – error cases
// ---------------------------------------------------------------------------

describe('createVercelTool – error cases', () => {
  it('throws when no description is available', () => {
    const saga = buildSaga(false);
    expect(() => createVercelTool(saga, orderSchema, vi.fn(async () => ({})))).toThrow(
      'tool description is required',
    );
  });
});

// ---------------------------------------------------------------------------
// createVercelTool – execute invocation
// ---------------------------------------------------------------------------

describe('createVercelTool – execute invocation', () => {
  it('passes validated params to executeFn', async () => {
    const saga = buildSaga();
    const executeFn = vi.fn(async (_p: { orderId: string; amount: number }) => ({ success: true }));
    const tool = createVercelTool(saga, orderSchema, executeFn);

    const params = { orderId: 'ord-1', amount: 99 };
    await tool.execute(params);

    expect(executeFn).toHaveBeenCalledWith(params);
  });

  it('returns the executeFn result', async () => {
    const saga = buildSaga();
    const executeFn = vi.fn(async () => ({ status: 'completed', orderId: 'ord-1' }));
    const tool = createVercelTool(saga, orderSchema, executeFn);

    const result = await tool.execute({ orderId: 'ord-1', amount: 50 });

    expect(result).toEqual({ status: 'completed', orderId: 'ord-1' });
  });

  it('propagates errors thrown by executeFn', async () => {
    const saga = buildSaga();
    const executeFn = vi.fn(async () => {
      throw new Error('saga failed');
    });
    const tool = createVercelTool(saga, orderSchema, executeFn);

    await expect(tool.execute({ orderId: 'ord-1', amount: 0 })).rejects.toThrow('saga failed');
  });
});

// ---------------------------------------------------------------------------
// createVercelTool – Zod schema integration
// ---------------------------------------------------------------------------

describe('createVercelTool – Zod schema integration', () => {
  it('the parameters field is a valid Zod schema that can parse correct input', () => {
    const saga = buildSaga();
    const tool = createVercelTool(saga, orderSchema, vi.fn(async () => ({})));

    const parsed = tool.parameters.parse({ orderId: 'ord-42', amount: 100 });
    expect(parsed).toEqual({ orderId: 'ord-42', amount: 100 });
  });

  it('the parameters Zod schema rejects invalid input', () => {
    const saga = buildSaga();
    const tool = createVercelTool(saga, orderSchema, vi.fn(async () => ({})));

    expect(() => tool.parameters.parse({ orderId: 42, amount: 'not-a-number' })).toThrow();
  });
});
