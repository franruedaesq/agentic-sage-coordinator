import type { SagaDefinition, SagaContext } from '@agentic-sage/core';
import type { ZodTypeAny, infer as ZodInfer } from 'zod';

/**
 * The shape returned by {@link createVercelTool}.
 *
 * It matches the object accepted by the Vercel AI SDK `tool()` helper so that
 * you can pass the result in directly:
 *
 * ```typescript
 * import { tool } from 'ai';
 * const myTool = tool(createVercelTool(orderSaga, schema, runSaga));
 * ```
 *
 * Because `@agentic-sage/vercel-ai` does **not** import `ai` at runtime, it
 * carries zero dependency on the Vercel AI SDK itself and stays compatible
 * with any version of the SDK that accepts this shape.
 *
 * @template TSchema - A Zod schema that describes the context parameters the
 *   LLM must supply when invoking the tool.
 */
export interface VercelToolSchema<TSchema extends ZodTypeAny> {
  /** Human-readable description surfaced to the LLM. */
  description: string;
  /**
   * Zod schema used by the Vercel AI SDK to validate and parse the tool
   * arguments supplied by the model.
   */
  parameters: TSchema;
  /**
   * Async function invoked by the Vercel AI SDK with the validated, parsed
   * arguments.  Returns the saga execution result.
   */
  execute: (params: ZodInfer<TSchema>) => Promise<unknown>;
}

/**
 * Wraps a {@link SagaDefinition} as a Vercel AI SDK-compatible tool schema.
 *
 * The saga's `metadata.description` is used automatically; an optional
 * `description` override can be provided as the fourth argument.  The Zod
 * `schema` you supply defines the parameters the LLM must provide — these map
 * directly to the saga context properties the tool needs to start execution.
 *
 * ```typescript
 * import { tool } from 'ai';
 * import { z } from 'zod';
 * import { createVercelTool } from '@agentic-sage/vercel-ai';
 *
 * const schema = z.object({ orderId: z.string(), amount: z.number() });
 *
 * const myTool = tool(
 *   createVercelTool(orderSaga, schema, async (params) => {
 *     const ctx = { results: {}, ...params };
 *     const executor = new SagaExecutor(orderSaga, ctx);
 *     return executor.run();
 *   }),
 * );
 * ```
 *
 * @param saga        - The saga definition to expose as a tool.
 * @param schema      - A Zod schema describing the LLM-supplied parameters.
 * @param executeFn   - Called with the validated parameters when the LLM
 *                      invokes the tool.
 * @param description - Optional description override; falls back to
 *                      `saga.metadata.description`.
 *
 * @throws {Error} If neither `description` nor `saga.metadata.description` is set.
 */
export function createVercelTool<TContext extends SagaContext, TSchema extends ZodTypeAny>(
  saga: SagaDefinition<TContext>,
  schema: TSchema,
  executeFn: (params: ZodInfer<TSchema>) => Promise<unknown>,
  description?: string,
): VercelToolSchema<TSchema> {
  const resolvedDescription = description ?? saga.metadata?.description;

  if (!resolvedDescription) {
    throw new Error(
      'createVercelTool: a tool description is required. ' +
        'Provide it as the fourth argument or via saga.metadata.description.',
    );
  }

  return {
    description: resolvedDescription,
    parameters: schema,
    execute: executeFn,
  };
}
