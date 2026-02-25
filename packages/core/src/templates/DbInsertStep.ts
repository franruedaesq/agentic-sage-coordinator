import type { SagaContext, SagaStep } from '../types.js';

/**
 * Result returned by the {@link DbInsertStep} `execute()` method.
 */
export interface DbInsertResult {
  /** The auto-generated primary key of the inserted row. */
  insertedId: string;
  /** The name of the table where the row was inserted. */
  tableName: string;
}

/**
 * Saga context required by {@link DbInsertStep}.
 * Extend this interface to add more domain-specific fields.
 */
export interface DbInsertContext extends SagaContext {
  /** The target table name. */
  tableName: string;
  /** The column/value pairs to insert. */
  record: Record<string, unknown>;
}

/**
 * A template {@link SagaStep} that models a database INSERT operation.
 *
 * **Usage**: Copy this object and replace the `execute` and `compensate`
 * bodies with real database calls.
 *
 * @example
 * ```typescript
 * import { SagaBuilder } from 'agentic-sage-coordinator';
 * import { DbInsertStep } from 'agentic-sage-coordinator/templates';
 *
 * const saga = new SagaBuilder<DbInsertContext>()
 *   .addStep(DbInsertStep)
 *   .build();
 * ```
 */
export const DbInsertStep: SagaStep<DbInsertResult, DbInsertContext> = {
  name: 'db-insert',
  metadata: {
    description: 'Insert a record into the database',
    compensationRetries: 3,
  },
  async execute(ctx) {
    // TODO: replace with a real database call, e.g.:
    // const result = await db.table(ctx.tableName).insert(ctx.record);
    // return { insertedId: String(result.insertId), tableName: ctx.tableName };
    return {
      insertedId: `id_mock_${Date.now()}`,
      tableName: ctx.tableName,
    };
  },
  async compensate(_ctx, _result) {
    // TODO: replace with a real database delete, e.g.:
    // await db.table(_result.tableName).where('id', _result.insertedId).delete();
  },
};
