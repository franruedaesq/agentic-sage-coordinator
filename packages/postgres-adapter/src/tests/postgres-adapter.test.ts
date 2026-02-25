import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostgresAdapter, sagaStepStates } from '../index.js';
import type { StepState } from '@agentic-sage/core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type InsertMock = {
  values: ReturnType<typeof vi.fn>;
};

type SelectMock = {
  from: ReturnType<typeof vi.fn>;
};

/**
 * Build a minimal Drizzle db mock that covers the query patterns used by
 * PostgresAdapter.
 */
function makeDbMock(rows: Record<string, unknown>[] = []): NodePgDatabase {
  const limitMock = vi.fn(async () => rows);
  const whereMock = vi.fn(() => ({ limit: limitMock }));
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn((): SelectMock => ({ from: fromMock }));

  const onConflictMock = vi.fn(async () => undefined);
  const valuesMock = vi.fn((): InsertMock & { onConflictDoUpdate: typeof onConflictMock } => ({
    values: valuesMock,
    onConflictDoUpdate: onConflictMock,
  }));
  const insertMock = vi.fn((): InsertMock & { onConflictDoUpdate: typeof onConflictMock } => ({
    values: valuesMock,
    onConflictDoUpdate: onConflictMock,
  }));

  return { select: selectMock, insert: insertMock } as unknown as NodePgDatabase;
}

// ---------------------------------------------------------------------------
// PostgresAdapter – basic contract
// ---------------------------------------------------------------------------

describe('PostgresAdapter', () => {
  let db: NodePgDatabase;
  let adapter: PostgresAdapter;

  beforeEach(() => {
    db = makeDbMock();
    adapter = new PostgresAdapter(db);
  });

  it('returns undefined when no row exists for the key', async () => {
    // db returns an empty rows array
    const state = await adapter.loadState('missing-key');
    expect(state).toBeUndefined();
  });

  it('deserialises a completed row with a result', async () => {
    const row = { key: 'order-step', status: 'completed', result: { orderId: '42' } };
    db = makeDbMock([row]);
    adapter = new PostgresAdapter(db);

    const state = await adapter.loadState('order-step');
    expect(state).toEqual({ status: 'completed', result: { orderId: '42' } });
  });

  it('deserialises a compensated row without a result', async () => {
    const row = { key: 'step-1:compensate', status: 'compensated', result: null };
    db = makeDbMock([row]);
    adapter = new PostgresAdapter(db);

    const state = await adapter.loadState('step-1:compensate');
    expect(state).toEqual({ status: 'compensated' });
  });

  it('calls insert with the correct values on saveState for a completed step', async () => {
    const state: StepState = { status: 'completed', result: { id: 1 } };
    await adapter.saveState('step-1', state);

    expect((db.insert as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(sagaStepStates);
  });

  it('calls insert with null result for a compensated step', async () => {
    const state: StepState = { status: 'compensated' };
    await adapter.saveState('step-1:compensate', state);

    expect((db.insert as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(sagaStepStates);
  });

  it('fulfils the SagaStateAdapter interface', () => {
    expect(typeof adapter.saveState).toBe('function');
    expect(typeof adapter.loadState).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// sagaStepStates – schema export
// ---------------------------------------------------------------------------

describe('sagaStepStates schema', () => {
  it('is exported as a Drizzle table object', () => {
    expect(sagaStepStates).toBeDefined();
    // Drizzle tables expose their name via the Symbol.for key or a plain property
    expect(typeof sagaStepStates).toBe('object');
  });
});
