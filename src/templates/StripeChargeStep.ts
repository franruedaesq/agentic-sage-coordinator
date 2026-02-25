import type { SagaContext, SagaStep } from '../types.js';

/**
 * Result returned by the {@link StripeChargeStep} `execute()` method.
 */
export interface StripeChargeResult {
  /** The Stripe charge identifier (e.g. `ch_3Mxxx...`). */
  chargeId: string;
  /** The charged amount in the smallest currency unit (e.g. cents). */
  amount: number;
  /** The ISO 4217 currency code (e.g. `"usd"`). */
  currency: string;
}

/**
 * Saga context required by {@link StripeChargeStep}.
 * Extend this interface to add more domain-specific fields.
 */
export interface StripeChargeContext extends SagaContext {
  /** The Stripe customer ID to charge. */
  customerId: string;
  /** The amount to charge in the smallest currency unit (e.g. cents). */
  amount: number;
  /** The ISO 4217 currency code (e.g. `"usd"`). */
  currency: string;
}

/**
 * A template {@link SagaStep} that models a Stripe charge operation.
 *
 * **Usage**: Copy this object and replace the `execute` and `compensate`
 * bodies with real Stripe SDK calls.
 *
 * @example
 * ```typescript
 * import { SagaBuilder } from 'agentic-sage-coordinator';
 * import { StripeChargeStep } from 'agentic-sage-coordinator/templates';
 *
 * const saga = new SagaBuilder<StripeChargeContext>()
 *   .addStep(StripeChargeStep)
 *   .build();
 * ```
 */
export const StripeChargeStep: SagaStep<StripeChargeResult, StripeChargeContext> = {
  name: 'stripe-charge',
  metadata: {
    description: 'Charge a customer via Stripe',
    compensationRetries: 3,
  },
  async execute(ctx) {
    // TODO: replace with a real Stripe API call, e.g.:
    // const charge = await stripe.charges.create({
    //   amount: ctx.amount,
    //   currency: ctx.currency,
    //   customer: ctx.customerId,
    // });
    // return { chargeId: charge.id, amount: ctx.amount, currency: ctx.currency };
    return {
      chargeId: `ch_mock_${Date.now()}`,
      amount: ctx.amount,
      currency: ctx.currency,
    };
  },
  async compensate(_ctx, _result) {
    // TODO: replace with a real Stripe refund, e.g.:
    // await stripe.refunds.create({ charge: _result.chargeId });
  },
};
