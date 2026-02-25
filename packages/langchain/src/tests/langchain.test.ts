import { describe, it, expect, vi } from 'vitest';
import { SagaBuilder } from '@agentic-sage/core';
import type { SagaContext } from '@agentic-sage/core';
import { createLangchainTool } from '../index.js';

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

// ---------------------------------------------------------------------------
// createLangchainTool – schema shape
// ---------------------------------------------------------------------------

describe('createLangchainTool – schema shape', () => {
  it('returns an object with name, description, and func', () => {
    const saga = buildSaga();
    const schema = createLangchainTool(saga, vi.fn(async () => ({})));

    expect(typeof schema.name).toBe('string');
    expect(typeof schema.description).toBe('string');
    expect(typeof schema.func).toBe('function');
  });

  it('uses saga metadata name and description', () => {
    const saga = buildSaga();
    const schema = createLangchainTool(saga, vi.fn(async () => ({})));

    expect(schema.name).toBe('process-order');
    expect(schema.description).toBe('Processes a customer order end-to-end.');
  });

  it('overrides name and description via options', () => {
    const saga = buildSaga();
    const schema = createLangchainTool(saga, vi.fn(async () => ({})), {
      name: 'custom-name',
      description: 'Custom description.',
    });

    expect(schema.name).toBe('custom-name');
    expect(schema.description).toBe('Custom description.');
  });

  it('uses options.name even when saga metadata is present', () => {
    const saga = buildSaga();
    const schema = createLangchainTool(saga, vi.fn(async () => ({})), { name: 'override' });

    expect(schema.name).toBe('override');
    expect(schema.description).toBe('Processes a customer order end-to-end.');
  });
});

// ---------------------------------------------------------------------------
// createLangchainTool – error cases
// ---------------------------------------------------------------------------

describe('createLangchainTool – error cases', () => {
  it('throws when no name is available', () => {
    const saga = buildSaga(false);
    expect(() => createLangchainTool(saga, vi.fn(async () => ({})))).toThrow(
      'tool name is required',
    );
  });

  it('throws when no description is available', () => {
    const saga = buildSaga(false);
    expect(() =>
      createLangchainTool(saga, vi.fn(async () => ({})), { name: 'my-tool' }),
    ).toThrow('tool description is required');
  });
});

// ---------------------------------------------------------------------------
// createLangchainTool – func execution
// ---------------------------------------------------------------------------

describe('createLangchainTool – func execution', () => {
  it('deserialises input JSON and passes it to executeFn', async () => {
    const saga = buildSaga();
    const executeFn = vi.fn(async (_ctx: OrderContext) => ({ success: true }));
    const schema = createLangchainTool(saga, executeFn);

    const ctx: OrderContext = { results: {}, orderId: 'ord-1', amount: 99 };
    await schema.func(JSON.stringify(ctx));

    expect(executeFn).toHaveBeenCalledWith(ctx);
  });

  it('returns a JSON-encoded string of the executeFn result', async () => {
    const saga = buildSaga();
    const executeFn = vi.fn(async () => ({ orderId: 'ord-1', status: 'complete' }));
    const schema = createLangchainTool(saga, executeFn);

    const result = await schema.func(JSON.stringify({ results: {}, orderId: 'ord-1', amount: 0 }));

    expect(JSON.parse(result)).toEqual({ orderId: 'ord-1', status: 'complete' });
  });

  it('propagates errors thrown by executeFn', async () => {
    const saga = buildSaga();
    const executeFn = vi.fn(async () => {
      throw new Error('saga failed');
    });
    const schema = createLangchainTool(saga, executeFn);

    await expect(schema.func(JSON.stringify({ results: {} }))).rejects.toThrow('saga failed');
  });
});
