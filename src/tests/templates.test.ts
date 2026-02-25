import { describe, it, expect } from 'vitest';
import { StripeChargeStep } from '../templates/StripeChargeStep.js';
import { DbInsertStep } from '../templates/DbInsertStep.js';
import type { StripeChargeContext, StripeChargeResult } from '../templates/StripeChargeStep.js';
import type { DbInsertContext, DbInsertResult } from '../templates/DbInsertStep.js';

// ---------------------------------------------------------------------------
// StripeChargeStep template
// ---------------------------------------------------------------------------

describe('StripeChargeStep template', () => {
  it('has the correct step name', () => {
    expect(StripeChargeStep.name).toBe('stripe-charge');
  });

  it('has metadata with description and compensationRetries', () => {
    expect(StripeChargeStep.metadata?.description).toBe('Charge a customer via Stripe');
    expect(StripeChargeStep.metadata?.compensationRetries).toBe(3);
  });

  it('execute() resolves with a mocked charge result', async () => {
    const ctx: StripeChargeContext = {
      results: {},
      customerId: 'cus_test123',
      amount: 5000,
      currency: 'usd',
    };
    const result = await StripeChargeStep.execute(ctx);
    expect(result.chargeId).toMatch(/^ch_mock_/);
    expect(result.amount).toBe(5000);
    expect(result.currency).toBe('usd');
  });

  it('execute() reflects the amount and currency from context', async () => {
    const ctx: StripeChargeContext = {
      results: {},
      customerId: 'cus_test',
      amount: 1099,
      currency: 'eur',
    };
    const result = await StripeChargeStep.execute(ctx);
    expect(result.amount).toBe(1099);
    expect(result.currency).toBe('eur');
  });

  it('compensate() resolves without throwing', async () => {
    const ctx: StripeChargeContext = {
      results: {},
      customerId: 'cus_test',
      amount: 5000,
      currency: 'usd',
    };
    const result: StripeChargeResult = { chargeId: 'ch_test', amount: 5000, currency: 'usd' };
    await expect(StripeChargeStep.compensate(ctx, result)).resolves.toBeUndefined();
  });

  it('implements the SagaStep interface (execute and compensate are functions)', () => {
    expect(typeof StripeChargeStep.execute).toBe('function');
    expect(typeof StripeChargeStep.compensate).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// DbInsertStep template
// ---------------------------------------------------------------------------

describe('DbInsertStep template', () => {
  it('has the correct step name', () => {
    expect(DbInsertStep.name).toBe('db-insert');
  });

  it('has metadata with description and compensationRetries', () => {
    expect(DbInsertStep.metadata?.description).toBe('Insert a record into the database');
    expect(DbInsertStep.metadata?.compensationRetries).toBe(3);
  });

  it('execute() resolves with a mocked insert result', async () => {
    const ctx: DbInsertContext = {
      results: {},
      tableName: 'users',
      record: { name: 'Alice', email: 'alice@example.com' },
    };
    const result = await DbInsertStep.execute(ctx);
    expect(result.insertedId).toMatch(/^id_mock_/);
    expect(result.tableName).toBe('users');
  });

  it('execute() reflects the tableName from context', async () => {
    const ctx: DbInsertContext = {
      results: {},
      tableName: 'orders',
      record: { item: 'widget', qty: 2 },
    };
    const result = await DbInsertStep.execute(ctx);
    expect(result.tableName).toBe('orders');
  });

  it('compensate() resolves without throwing', async () => {
    const ctx: DbInsertContext = {
      results: {},
      tableName: 'users',
      record: { name: 'Alice' },
    };
    const result: DbInsertResult = { insertedId: 'id_test', tableName: 'users' };
    await expect(DbInsertStep.compensate(ctx, result)).resolves.toBeUndefined();
  });

  it('implements the SagaStep interface (execute and compensate are functions)', () => {
    expect(typeof DbInsertStep.execute).toBe('function');
    expect(typeof DbInsertStep.compensate).toBe('function');
  });
});
