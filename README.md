# AgentSaga — agentic-sage-coordinator

> A pure TypeScript control flow library that implements the **Saga pattern** for safe, compensatable multi-step AI agent workflows.

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Table of Contents

- [Why AgentSaga?](#why-agentsaga)
- [Packages](#packages)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Use Cases & Examples](#use-cases--examples)
  - [E-commerce Order Flow](#e-commerce-order-flow)
  - [Parallel Steps](#parallel-steps)
  - [Dry-Run Mode](#dry-run-mode)
  - [Human-in-the-Loop (HITL)](#human-in-the-loop-hitl)
  - [Persistent State with Redis](#persistent-state-with-redis)
  - [Persistent State with PostgreSQL](#persistent-state-with-postgresql)
  - [LangChain Integration](#langchain-integration)
  - [Vercel AI SDK Integration](#vercel-ai-sdk-integration)
  - [Step Templates](#step-templates)
- [API Reference](#api-reference)
  - [SagaContext](#sagacontext)
  - [SagaStep](#sagastep)
  - [SagaStepMetadata](#sagastepmetadata)
  - [SagaBuilder](#sagabuilder)
  - [SagaDefinition](#sagadefinition)
  - [SagaExecutor](#sagaexecutor)
  - [Lifecycle Hooks](#lifecycle-hooks)
  - [Persistence Adapters](#persistence-adapters)
- [Project Structure](#project-structure)
- [Development](#development)

---

## Why AgentSaga?

Modern AI agents interact with the real world: they write to databases, call payment APIs, provision cloud resources, and send emails. When a five-step plan fails at step three, naive implementations leave the system in a **corrupted, partially-executed state**.

AgentSaga solves this by separating two concerns:

1. **Non-deterministic planning** — done by the LLM (outside this library).
2. **Deterministic execution & rollback** — handled entirely by AgentSaga.

For every step you provide an `execute()` action **and** a `compensate()` rollback. If any step fails, AgentSaga automatically triggers all compensation functions in reverse order, cleanly restoring the system to its prior state.

**Key capabilities at a glance:**

| Capability | Description |
|---|---|
| **Automated Rollback** | Reverse compensation on failure — all previously completed steps are rolled back automatically. |
| **Parallel Execution** | Run independent steps concurrently via `addParallelSteps()`. |
| **Idempotency** | Per-step idempotency keys prevent double-execution on retries. |
| **Pluggable Persistence** | In-memory (default), Redis, or PostgreSQL adapters for durable state across restarts. |
| **Dry-Run Mode** | Preview the execution plan without running any side-effects. |
| **Human-in-the-Loop** | Pause a saga mid-execution for human approval, then resume it. |
| **Lifecycle Hooks** | `onBeforeStep` / `onAfterStep` / `onError` / `onCompensation` for observability. |
| **AI Framework Wrappers** | First-class LangChain and Vercel AI SDK integrations. |

---

## Packages

This repository is a monorepo. Install only the packages you need:

| Package | Description |
|---|---|
| [`@agentic-sage/core`](packages/core) | Core library — `SagaBuilder`, `SagaExecutor`, types, and adapters |
| [`@agentic-sage/langchain`](packages/langchain) | Wraps a saga as a native LangChain `DynamicTool` |
| [`@agentic-sage/vercel-ai`](packages/vercel-ai) | Wraps a saga as a native Vercel AI SDK `tool` |
| [`@agentic-sage/postgres-adapter`](packages/postgres-adapter) | PostgreSQL-backed state adapter (Drizzle ORM) |
| [`@agentic-sage/redis-adapter`](packages/redis-adapter) | Redis-backed state adapter (ioredis) |

---

## Installation

```bash
# Core library (required)
npm install @agentic-sage/core

# Optional integrations
npm install @agentic-sage/langchain
npm install @agentic-sage/vercel-ai
npm install @agentic-sage/postgres-adapter
npm install @agentic-sage/redis-adapter
```

> **Requirements:** Node.js ≥ 18 and TypeScript ≥ 5.0.

---

## Quick Start

```typescript
import {
  SagaBuilder,
  SagaExecutor,
  SagaContext,
  SagaStep,
} from '@agentic-sage/core';

// 1. Define your domain context
interface OrderContext extends SagaContext {
  orderId: string;
  userId: string;
}

// 2. Define steps — each has an execute() and a compensate()
const reserveInventoryStep: SagaStep<{ reservationId: string }, OrderContext> = {
  name: 'reserve-inventory',
  async execute(ctx) {
    const reservationId = await inventoryService.reserve(ctx.orderId);
    return { reservationId };
  },
  async compensate(_ctx, result) {
    await inventoryService.release(result.reservationId);
  },
  metadata: { description: 'Reserve items in the warehouse', maxRetries: 2 },
};

const chargePaymentStep: SagaStep<{ chargeId: string }, OrderContext> = {
  name: 'charge-payment',
  async execute(ctx) {
    const chargeId = await paymentService.charge(ctx.userId, 99.99);
    return { chargeId };
  },
  async compensate(_ctx, result) {
    await paymentService.refund(result.chargeId);
  },
  metadata: { description: "Charge the customer's card" },
};

// 3. Build the saga definition (immutable once built)
const orderSaga = new SagaBuilder<OrderContext>()
  .addStep(reserveInventoryStep)
  .addStep(chargePaymentStep)
  .build();

// 4. Execute — if charge-payment fails, reserve-inventory is automatically rolled back
const ctx: OrderContext = { results: {}, orderId: 'order-123', userId: 'user-456' };
const executor = new SagaExecutor(orderSaga, ctx);
const finalCtx = await executor.run();

console.log(finalCtx.results);
// => { 'reserve-inventory': { reservationId: '...' }, 'charge-payment': { chargeId: '...' } }
```

---

## Use Cases & Examples

### E-commerce Order Flow

A complete order saga with inventory reservation, payment charging, and receipt sending. If payment fails, the inventory reservation is automatically released.

```typescript
import { SagaBuilder, SagaExecutor, SagaContext, SagaStep } from '@agentic-sage/core';

interface OrderContext extends SagaContext {
  orderId: string;
  userId: string;
  amount: number;
}

const reserveInventory: SagaStep<{ reservationId: string }, OrderContext> = {
  name: 'reserve-inventory',
  async execute(ctx) {
    const reservationId = await inventoryService.reserve(ctx.orderId);
    return { reservationId };
  },
  async compensate(_ctx, result) {
    await inventoryService.release(result.reservationId);
  },
};

const chargePayment: SagaStep<{ chargeId: string }, OrderContext> = {
  name: 'charge-payment',
  async execute(ctx) {
    const chargeId = await paymentService.charge(ctx.userId, ctx.amount);
    return { chargeId };
  },
  async compensate(_ctx, result) {
    await paymentService.refund(result.chargeId);
  },
};

const sendReceipt: SagaStep<void, OrderContext> = {
  name: 'send-receipt',
  async execute(ctx) {
    const charge = ctx.results['charge-payment'] as { chargeId: string };
    await emailService.sendReceipt(ctx.userId, charge.chargeId);
  },
  async compensate() {
    // Email cannot be recalled — no-op compensation
  },
};

const orderSaga = new SagaBuilder<OrderContext>()
  .addStep(reserveInventory)
  .addStep(chargePayment)
  .addStep(sendReceipt)
  .build();

const ctx: OrderContext = { results: {}, orderId: 'order-123', userId: 'user-456', amount: 4999 };
const finalCtx = await new SagaExecutor(orderSaga, ctx).run();
```

---

### Parallel Steps

Use `addParallelSteps()` to run independent side-effects concurrently. If any step in the group fails, all successfully completed steps (within the group and all prior sequential steps) are compensated in reverse order.

```typescript
import { SagaBuilder, SagaExecutor, SagaContext, SagaStep } from '@agentic-sage/core';

interface OrderContext extends SagaContext {
  orderId: string;
  userId: string;
}

const sendConfirmationEmail: SagaStep<void, OrderContext> = {
  name: 'send-email',
  async execute(ctx) { await emailService.send(ctx.userId, 'Order confirmed'); },
  async compensate() { /* email cannot be recalled */ },
};

const syncCrm: SagaStep<{ crmId: string }, OrderContext> = {
  name: 'sync-crm',
  async execute(ctx) {
    const crmId = await crmService.upsert(ctx.userId, ctx.orderId);
    return { crmId };
  },
  async compensate(_ctx, result) {
    await crmService.remove(result.crmId);
  },
};

const orderSaga = new SagaBuilder<OrderContext>()
  .addStep(chargePayment)                          // sequential first
  .addParallelSteps([sendConfirmationEmail, syncCrm]) // then parallel
  .build();

const ctx: OrderContext = { results: {}, orderId: 'order-123', userId: 'user-456' };
await new SagaExecutor(orderSaga, ctx).run();
```

---

### Dry-Run Mode

Preview the execution plan without invoking any `execute()` or `compensate()` functions. Useful for validation, audit logging, or UI previews.

```typescript
import { SagaBuilder, SagaExecutor, SagaContext } from '@agentic-sage/core';

const ctx: OrderContext = { results: {}, orderId: 'order-123', userId: 'user-456', amount: 4999 };
const executor = new SagaExecutor(orderSaga, ctx);

const result = await executor.run({ dryRun: true });

if ('dryRun' in result) {
  console.log('Execution plan:');
  result.plan.forEach((step, i) => {
    console.log(`  ${i + 1}. ${step.name} — ${step.description ?? 'no description'}`);
  });
}
// Execution plan:
//   1. reserve-inventory — Reserve items in the warehouse
//   2. charge-payment — Charge the customer's card
//   3. send-receipt — (no description)
```

---

### Human-in-the-Loop (HITL)

A step can pause the saga by throwing `PendingApprovalError`. The saga saves its state and returns a `pending_approval` result. Once a human approves, call `executor.resume()` to continue from where it left off. Combine with a Redis or Postgres adapter so the state survives across server restarts.

```typescript
import {
  SagaBuilder,
  SagaExecutor,
  SagaContext,
  SagaStep,
  PendingApprovalError,
} from '@agentic-sage/core';
import { RedisAdapter } from '@agentic-sage/redis-adapter';
import Redis from 'ioredis';

interface RefundContext extends SagaContext {
  orderId: string;
  amount: number;
}

const requestManagerApproval: SagaStep<{ approved: boolean }, RefundContext> = {
  name: 'manager-approval',
  async execute(ctx) {
    // Notify the manager and wait — throw to pause the saga
    await notificationService.notifyManager(ctx.orderId, ctx.amount);
    throw new PendingApprovalError();
  },
  async compensate() { /* nothing to roll back */ },
};

const processRefund: SagaStep<{ refundId: string }, RefundContext> = {
  name: 'process-refund',
  async execute(ctx) {
    const approval = ctx.results['manager-approval'] as { approved: boolean };
    if (!approval.approved) throw new Error('Refund denied by manager.');
    const refundId = await paymentService.refund(ctx.orderId);
    return { refundId };
  },
  async compensate(_ctx, result) {
    await paymentService.voidRefund(result.refundId);
  },
};

const refundSaga = new SagaBuilder<RefundContext>()
  .addStep(requestManagerApproval)
  .addStep(processRefund)
  .build();

const redis = new Redis();
const adapter = new RedisAdapter(redis, { keyPrefix: 'saga:refund:', ttlSeconds: 86400 });
const ctx: RefundContext = { results: {}, orderId: 'order-123', amount: 4999 };
const executor = new SagaExecutor(refundSaga, ctx, adapter);

// --- First run (pauses at manager-approval) ---
const result = await executor.run();
if ('status' in result && result.status === 'pending_approval') {
  console.log(`Saga paused, waiting for approval of step: ${result.stepName}`);
}

// --- Later, once the manager approves ---
const finalCtx = await executor.resume({ approved: true });
```

---

### Persistent State with Redis

Use `@agentic-sage/redis-adapter` to persist saga state in Redis. This allows sagas to survive process restarts and enables HITL workflows in distributed deployments.

```typescript
import { SagaExecutor } from '@agentic-sage/core';
import { RedisAdapter } from '@agentic-sage/redis-adapter';
import Redis from 'ioredis';

const redis = new Redis({ host: 'localhost', port: 6379 });
const adapter = new RedisAdapter(redis, {
  keyPrefix: 'saga:order:',
  ttlSeconds: 3600, // auto-expire keys after 1 hour
});

const executor = new SagaExecutor(orderSaga, ctx, adapter);
await executor.run();
```

---

### Persistent State with PostgreSQL

Use `@agentic-sage/postgres-adapter` to persist saga state in a PostgreSQL database via Drizzle ORM. Ideal for mission-critical workflows that require an auditable, relational record.

```typescript
import { SagaExecutor } from '@agentic-sage/core';
import { PostgresAdapter, sagaStepStates } from '@agentic-sage/postgres-adapter';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

// 1. Create the table (run once via drizzle-kit or migration)
// export { sagaStepStates }; // include in your drizzle schema

// 2. Set up Drizzle
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

const adapter = new PostgresAdapter(db);
const executor = new SagaExecutor(orderSaga, ctx, adapter);
await executor.run();
```

---

### LangChain Integration

Wrap any saga as a native LangChain `DynamicTool` so an LLM agent can invoke it as a single atomic action.

```typescript
import { SagaBuilder, SagaExecutor } from '@agentic-sage/core';
import { createLangchainTool } from '@agentic-sage/langchain';
import { DynamicTool } from '@langchain/core/tools';

const orderSaga = new SagaBuilder<OrderContext>()
  .addStep(reserveInventory)
  .addStep(chargePayment)
  .build({
    name: 'place-order',
    description: 'Reserve inventory, charge payment, and send a receipt for an order.',
  });

const schema = createLangchainTool(orderSaga, async (ctx) => {
  const executor = new SagaExecutor(orderSaga, ctx);
  return executor.run();
});

// Pass to a LangChain agent
const tool = new DynamicTool(schema);
agent.bindTools([tool]);
```

The LLM supplies a JSON-encoded context string as input; the tool parses it, runs the saga, and returns the final context as a JSON string.

---

### Vercel AI SDK Integration

Wrap a saga as a native Vercel AI `tool` with a Zod schema describing the parameters the model must supply.

```typescript
import { SagaBuilder, SagaExecutor } from '@agentic-sage/core';
import { createVercelTool } from '@agentic-sage/vercel-ai';
import { tool, generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

const orderSaga = new SagaBuilder<OrderContext>()
  .addStep(reserveInventory)
  .addStep(chargePayment)
  .build({
    name: 'place-order',
    description: 'Reserve inventory, charge payment, and send a receipt for an order.',
  });

const orderSchema = z.object({
  orderId: z.string(),
  userId: z.string(),
  amount: z.number(),
});

const placeOrderTool = tool(
  createVercelTool(orderSaga, orderSchema, async (params) => {
    const ctx: OrderContext = { results: {}, ...params };
    return new SagaExecutor(orderSaga, ctx).run();
  }),
);

const { text } = await generateText({
  model: openai('gpt-4o'),
  tools: { placeOrder: placeOrderTool },
  prompt: 'Place an order for user user-456, order order-123, amount 4999 cents.',
});
```

---

### Step Templates

`@agentic-sage/core` ships copy-and-customise templates for common operations:

```typescript
import { SagaBuilder, SagaExecutor } from '@agentic-sage/core';
import { StripeChargeStep, DbInsertStep } from '@agentic-sage/core/templates';

// Use as-is for quick prototyping, or copy and replace the TODO bodies
// with real Stripe / database calls.
const saga = new SagaBuilder()
  .addStep(StripeChargeStep)
  .addStep(DbInsertStep)
  .build();
```

Available templates:

| Template | Description |
|---|---|
| `StripeChargeStep` | Models a Stripe `charges.create` + `refunds.create` rollback |
| `DbInsertStep` | Models a database `INSERT` + `DELETE` rollback |

---

## API Reference

### `SagaContext`

The shared context object threaded through every step. Extend it with domain-specific fields.

```typescript
interface SagaContext {
  /** Accumulated results from completed steps, keyed by step name. */
  results: Record<string, unknown>;
  /** When true, steps should skip real side-effects. */
  dryRun?: boolean;
}
```

---

### `SagaStep`

The core unit of work in a saga.

```typescript
interface SagaStep<TResult = unknown, TContext extends SagaContext = SagaContext> {
  name: string;
  execute(ctx: TContext): Promise<TResult>;
  compensate(ctx: TContext, result: TResult): Promise<void>;
  metadata?: SagaStepMetadata;
}
```

| Property | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | ✅ | Unique identifier within the saga. |
| `execute` | `(ctx) => Promise<TResult>` | ✅ | Primary action to perform. |
| `compensate` | `(ctx, result) => Promise<void>` | ✅ | Rollback action if a later step fails. |
| `metadata` | `SagaStepMetadata` | ❌ | Optional execution configuration. |

---

### `SagaStepMetadata`

Fine-grained configuration for an individual step.

```typescript
interface SagaStepMetadata {
  description?: string;         // Human-readable step description
  maxRetries?: number;          // Retry attempts for execute() — default 0
  compensationRetries?: number; // Retry attempts for compensate() — default 3
  skipOnDryRun?: boolean;       // Skip this step in dry-run mode
  idempotencyKey?: string;      // Prevent double-execution (auto-generated if omitted)
}
```

---

### `SagaBuilder`

Fluent builder that assembles an ordered, immutable list of steps.

```typescript
class SagaBuilder<TContext extends SagaContext = SagaContext> {
  addStep<TResult>(step: SagaStep<TResult, TContext>): this;
  addParallelSteps<TResult>(steps: Array<SagaStep<TResult, TContext>>): this;
  build(metadata?: SagaMetadata): SagaDefinition<TContext>;
}
```

| Method | Description |
|---|---|
| `addStep(step)` | Append a sequential step. Throws if the name is already used. |
| `addParallelSteps(steps)` | Append a group of steps to run concurrently via `Promise.allSettled()`. Throws if empty or if any name is already used. |
| `build(metadata?)` | Return an immutable `SagaDefinition`. Throws if no steps have been added. `metadata.name` and `metadata.description` are used by AI framework wrappers. |

---

### `SagaDefinition`

An immutable snapshot of the ordered steps, ready to be handed to `SagaExecutor`.

```typescript
interface SagaDefinition<TContext extends SagaContext = SagaContext> {
  readonly steps: ReadonlyArray<SagaStep<unknown, TContext> | ParallelStepGroup<TContext>>;
  readonly metadata?: SagaMetadata; // { name: string; description: string }
}
```

---

### `SagaExecutor`

Executes a `SagaDefinition` step-by-step. On failure it rolls back all completed steps in reverse order with exponential backoff retries.

```typescript
class SagaExecutor<TContext extends SagaContext = SagaContext> {
  constructor(
    definition: SagaDefinition<TContext>,
    context: TContext,
    adapter?: SagaStateAdapter, // defaults to InMemoryAdapter
    logger?: Logger,
  );

  run(options?: { dryRun?: boolean }): Promise<TContext | DryRunResult | PendingApprovalResult>;
  resume(approvedResult?: unknown): Promise<TContext | DryRunResult | PendingApprovalResult>;

  // Lifecycle hooks — return `this` for fluent chaining
  onBeforeStep(hook: BeforeStepHook<TContext>): this;
  onAfterStep(hook: AfterStepHook<TContext>): this;
  onError(hook: ErrorHook<TContext>): this;
  onCompensation(hook: CompensationHook<TContext>): this;
}
```

**`run(options?)`** — Execute all steps in order. Returns:
- `TContext` — the final context after all steps complete successfully.
- `DryRunResult` — when `options.dryRun` is `true`; contains the ordered execution plan.
- `PendingApprovalResult` — when a step throws `PendingApprovalError`.

Throws the original step error (after rolling back) or `SagaCompensationError` if a compensation function fails after all retries.

**`resume(approvedResult?)`** — Continue a saga that was paused by `PendingApprovalError`. Marks the pending step as completed with `approvedResult` and re-runs from the next step.

---

### Lifecycle Hooks

Register hooks on a `SagaExecutor` instance for observability, auditing, or custom side-effects:

```typescript
const executor = new SagaExecutor(saga, ctx)
  .onBeforeStep((stepName, ctx) => {
    console.log(`Starting step: ${stepName}`);
  })
  .onAfterStep((stepName, result, ctx) => {
    console.log(`Completed step: ${stepName}`, result);
  })
  .onError((stepName, error, ctx) => {
    console.error(`Step failed: ${stepName}`, error);
  })
  .onCompensation((stepName, result, ctx) => {
    console.warn(`Rolling back step: ${stepName}`);
  });

await executor.run();
```

You can also pass a `Logger` (compatible with Pino, Winston, etc.) as the fourth constructor argument for structured logging:

```typescript
import pino from 'pino';

const executor = new SagaExecutor(saga, ctx, adapter, pino());
```

---

### Persistence Adapters

| Adapter | Package | Description |
|---|---|---|
| `InMemoryAdapter` | `@agentic-sage/core` | Default in-memory adapter. State is lost when the process exits. |
| `RedisAdapter` | `@agentic-sage/redis-adapter` | Persists state in Redis via ioredis. Supports key prefix and TTL. |
| `PostgresAdapter` | `@agentic-sage/postgres-adapter` | Persists state in PostgreSQL via Drizzle ORM. |

Implement `SagaStateAdapter` to plug in any other storage backend:

```typescript
import type { SagaStateAdapter, StepState } from '@agentic-sage/core';

class MyCustomAdapter implements SagaStateAdapter {
  async saveState(key: string, state: StepState): Promise<void> { /* ... */ }
  async loadState(key: string): Promise<StepState | undefined> { /* ... */ }
}
```

---

## Project Structure

```
agentic-sage-coordinator/          # Monorepo root
├── packages/
│   ├── core/                      # @agentic-sage/core
│   │   └── src/
│   │       ├── index.ts           # Public API barrel export
│   │       ├── types.ts           # Core interfaces & error classes
│   │       ├── builder.ts         # SagaBuilder + SagaDefinition
│   │       ├── executor.ts        # SagaExecutor
│   │       ├── persistence.ts     # SagaStateAdapter + InMemoryAdapter
│   │       ├── serialization.ts   # JSON serialization guardrails
│   │       ├── templates/         # StripeChargeStep, DbInsertStep
│   │       └── tests/             # Vitest unit tests
│   ├── langchain/                 # @agentic-sage/langchain
│   ├── vercel-ai/                 # @agentic-sage/vercel-ai
│   ├── postgres-adapter/          # @agentic-sage/postgres-adapter
│   └── redis-adapter/             # @agentic-sage/redis-adapter
├── package.json                   # Workspace root (npm workspaces)
└── README.md
```

---

## Development

```bash
# Install all workspace dependencies
npm install

# Run all tests across all packages
npm test

# Build all packages
npm run build

# Lint all packages
npm run lint

# Format source files
npm run format
```

To work on a single package:

```bash
cd packages/core

npm test          # Run unit tests (Vitest)
npm run test:watch  # Watch mode
npm run build     # Compile ESM + CJS output to dist/
```

---

## License

MIT
