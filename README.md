# AgentSaga — agentic-sage-coordinator

> A zero-dependency, pure TypeScript control flow library that implements the **Saga pattern** for safe, compensatable multi-step AI agent workflows.

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Table of Contents

- [Description](#description)
- [Objectives](#objectives)
- [Core Capabilities](#core-capabilities)
- [Non-Goals](#non-goals)
- [Technical Constraints](#technical-constraints)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
  - [SagaContext](#sagacontext)
  - [SagaStep\<TResult, TContext\>](#sagasteptresult-tcontext)
  - [SagaStepMetadata](#sagastepmetadata)
  - [SagaBuilder\<TContext\>](#sagabuildertcontext)
  - [SagaDefinition\<TContext\>](#sagadefinitiontcontext)
- [Project Structure](#project-structure)
- [Development](#development)

---

## Description

AgentSaga is an agnostic, highly reliable TypeScript library that provides a **Saga executor wrapper** around any agent-generated plan or graph, turning brittle LLM-driven action sequences into safe, consistent workflows.

Modern AI agents interact with the real world: they write to databases, call payment APIs, provision cloud resources, and send emails. When a five-step plan fails at step three, naive implementations leave the system in a corrupted, partially-executed state. AgentSaga solves this by separating two concerns:

1. **Non-deterministic planning** — done by the LLM (outside this library).
2. **Deterministic execution & rollback** — handled entirely by AgentSaga.

For every step the developer provides an `execute()` action **and** a `compensate()` rollback. If any step fails, AgentSaga automatically triggers all compensation functions in reverse order, cleanly restoring the system to its prior state.

---

## Objectives

- Provide a clean, composable DSL for defining multi-step workflows with built-in compensation.
- Guarantee that partial execution never leaves the system in an inconsistent state.
- Remain completely framework-agnostic — usable with LangChain, LlamaIndex, custom routers, or any TypeScript project.
- Follow a **Test-Driven Development (TDD)** approach for maximum reliability and confidence.

---

## Core Capabilities

| Capability | Description |
|---|---|
| **Saga Definition DSL** | A clean, developer-friendly `SagaBuilder` API for chaining steps that contain `execute()`, `compensate()`, and metadata. |
| **Execution & Orchestration** | Sequential step processing with success/failure monitoring and automatic halt on errors. |
| **Automated Compensation** | Reverse traversal on failure — all previously successful steps have their `compensate()` function invoked automatically. |
| **Idempotency & Safety** | Built-in idempotency key support per step to prevent double-execution, configurable retry logic for failing compensations, and a dry-run mode. |
| **Pluggable Persistence** | Durable state checkpointing (in-memory by default, pluggable for DB or workflow engines like Temporal) to resume or rollback across process restarts. |
| **Integration Hooks** | Extensible middleware for Causal Provenance Tracing (logging), Resource Governor (budgeting), and Human-In-The-Loop (HITL) approval gates. |

---

## Non-Goals

- **No Internal LLMs.** AgentSaga handles pure control flow. It does not generate, plan, or modify steps — only executes them.
- **No Tied Frameworks.** The library imposes zero framework dependencies. It works seamlessly alongside LangChain, LlamaIndex, Vercel AI SDK, or any custom agent router.
- **No Opinionated Transport.** AgentSaga does not dictate how steps communicate. They are plain async TypeScript functions.

---

## Technical Constraints

- **100% TypeScript** with strict mode enabled (`strict: true` in `tsconfig.json`).
- **Zero core runtime dependencies** — the production bundle is pure TypeScript/JavaScript.
- **Test-Driven Development (TDD)** — every public API surface is covered by unit tests.
- **Immutable definitions** — a `SagaDefinition` produced by `SagaBuilder.build()` is frozen and cannot be mutated after creation.

---

## Installation

```bash
npm install agentic-sage-coordinator
```

> **Requirements:** Node.js ≥ 18 and TypeScript ≥ 5.0 (in consuming projects).

---

## Quick Start

```typescript
import { SagaBuilder, SagaContext, SagaStep } from 'agentic-sage-coordinator';

// 1. Define your domain context
interface OrderContext extends SagaContext {
  orderId: string;
  userId: string;
}

// 2. Define individual steps
const reserveInventoryStep: SagaStep<{ reservationId: string }, OrderContext> = {
  name: 'reserve-inventory',
  async execute(ctx) {
    // Call your inventory service
    const reservationId = await inventoryService.reserve(ctx.orderId);
    ctx.results['reserve-inventory'] = { reservationId };
    return { reservationId };
  },
  async compensate(ctx, result) {
    // Roll back if a later step fails
    await inventoryService.release(result.reservationId);
  },
  metadata: {
    description: 'Reserve items in the warehouse',
    maxRetries: 2,
  },
};

const chargePaymentStep: SagaStep<{ chargeId: string }, OrderContext> = {
  name: 'charge-payment',
  async execute(ctx) {
    const chargeId = await paymentService.charge(ctx.userId, 99.99);
    ctx.results['charge-payment'] = { chargeId };
    return { chargeId };
  },
  async compensate(_ctx, result) {
    await paymentService.refund(result.chargeId);
  },
  metadata: { description: 'Charge the customer\'s card' },
};

// 3. Build the saga definition (immutable once built)
const orderSaga = new SagaBuilder<OrderContext>()
  .addStep(reserveInventoryStep)
  .addStep(chargePaymentStep)
  .build();

// 4. Execute (using your own executor or the built-in one once shipped)
console.log(orderSaga.steps.map((s) => s.name));
// => ['reserve-inventory', 'charge-payment']
```

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

### `SagaStep<TResult, TContext>`

The core unit of work in a Saga.

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
  description?: string;       // Human-readable step description
  maxRetries?: number;        // Retry attempts for execute() (default: 0)
  compensationRetries?: number; // Retry attempts for compensate() (default: 3)
  skipOnDryRun?: boolean;     // Skip real side-effects in dry-run mode
  idempotencyKey?: string;    // Prevent double-execution
}
```

---

### `SagaBuilder<TContext>`

Fluent builder that assembles an ordered, immutable list of steps.

```typescript
class SagaBuilder<TContext extends SagaContext = SagaContext> {
  addStep<TResult>(step: SagaStep<TResult, TContext>): this;
  build(): SagaDefinition<TContext>;
}
```

#### `addStep(step)`
Appends a step to the saga. Returns `this` for fluent chaining.
Throws if a step with the same `name` has already been added.

#### `build()`
Finalises the builder and returns a frozen `SagaDefinition`.
Throws if no steps have been added.

---

### `SagaDefinition<TContext>`

An immutable snapshot of the ordered steps, ready to be handed to an executor.

```typescript
interface SagaDefinition<TContext extends SagaContext = SagaContext> {
  readonly steps: ReadonlyArray<SagaStep<unknown, TContext>>;
}
```

---

## Project Structure

```
agentic-sage-coordinator/
├── src/
│   ├── index.ts          # Public API barrel export
│   ├── types.ts          # Core interfaces: SagaStep, SagaContext, SagaStepMetadata
│   ├── builder.ts        # SagaBuilder implementation & SagaDefinition interface
│   └── tests/
│       └── builder.test.ts  # Unit tests (Vitest)
├── dist/                 # Compiled output (generated by `npm run build`)
├── package.json
├── tsconfig.json
└── README.md
```

---

## Development

```bash
# Install dependencies
npm install

# Run unit tests
npm test

# Run tests in watch mode
npm run test:watch

# Type-check without emitting
npm run lint

# Build to dist/
npm run build
```

### Running Tests

```
 ✓ src/tests/builder.test.ts (14 tests)

 Test Files  1 passed (1)
      Tests  14 passed (14)
```

All tests are written using [Vitest](https://vitest.dev/) and cover:
- `SagaBuilder` construction and fluent chaining
- Step ordering and immutability guarantees
- Duplicate step name detection
- Empty saga detection
- Metadata preservation
- `SagaContext` interface contract
- `SagaStep` execute/compensate contract

---

## License

MIT
