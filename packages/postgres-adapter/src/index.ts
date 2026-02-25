import type { SagaStateAdapter, StepState } from '@agentic-sage/core';
import { pgTable, text, jsonb } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

// ---------------------------------------------------------------------------
// Drizzle schema
// ---------------------------------------------------------------------------

/**
 * Drizzle table definition for saga step state.
 * Export this if you need to include it in your own Drizzle schema object
 * (e.g. to run `drizzle-kit push` or `drizzle-kit generate`).
 *
 * @example
 * ```typescript
 * import { sagaStepStates } from '@agentic-sage/postgres-adapter';
 * // Include in your schema for migrations:
 * export { sagaStepStates };
 * ```
 */
export const sagaStepStates = pgTable('saga_step_states', {
  /** The idempotency key – unique identifier for a step execution or compensation. */
  key: text('key').primaryKey(),
  /** Execution status of the operation. */
  status: text('status').notNull(),
  /** JSON-serialised result value (only set for completed execute steps). */
  result: jsonb('result'),
});

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * PostgreSQL-backed implementation of {@link SagaStateAdapter}, powered by
 * Drizzle ORM.
 *
 * Persists each saga step's state as a row in the `saga_step_states` table,
 * providing an auditable, durable record of every idempotency key that has
 * fired.  Ideal for mission-critical workflows (e.g. payments) that require
 * persistent, relational storage.
 *
 * ### Setup
 *
 * 1. Add `sagaStepStates` to your Drizzle schema and run `drizzle-kit push`
 *    (or generate + apply a migration) to create the table.
 * 2. Pass your Drizzle `db` instance to `PostgresAdapter`.
 *
 * @example
 * ```typescript
 * import { drizzle } from 'drizzle-orm/node-postgres';
 * import { Pool } from 'pg';
 * import { PostgresAdapter, sagaStepStates } from '@agentic-sage/postgres-adapter';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const db = drizzle(pool);
 *
 * const adapter = new PostgresAdapter(db);
 * const executor = new SagaExecutor(definition, ctx, adapter);
 * await executor.run();
 * ```
 */
export class PostgresAdapter implements SagaStateAdapter {
  private readonly _db: NodePgDatabase;

  constructor(db: NodePgDatabase) {
    this._db = db;
  }

  async saveState(key: string, state: StepState): Promise<void> {
    await this._db
      .insert(sagaStepStates)
      .values({
        key,
        status: state.status,
        result: state.result !== undefined ? (state.result as Record<string, unknown>) : null,
      })
      .onConflictDoUpdate({
        target: sagaStepStates.key,
        set: {
          status: state.status,
          result: state.result !== undefined ? (state.result as Record<string, unknown>) : null,
        },
      });
  }

  async loadState(key: string): Promise<StepState | undefined> {
    const rows = await this._db
      .select()
      .from(sagaStepStates)
      .where(eq(sagaStepStates.key, key))
      .limit(1);

    if (rows.length === 0) {
      return undefined;
    }

    const row = rows[0];
    return {
      status: row.status as StepState['status'],
      ...(row.result !== null ? { result: row.result } : {}),
    };
  }
}
