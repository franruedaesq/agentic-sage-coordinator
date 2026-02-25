import type { SagaDefinition, SagaContext } from '@agentic-sage/core';

/**
 * The shape returned by {@link createLangchainTool}.
 *
 * It is intentionally kept as a plain object so that this package carries
 * zero runtime dependencies on `@langchain/core`.  The fields map 1-to-1
 * onto the `DynamicTool` constructor options accepted by LangChain, so you
 * can pass the result directly:
 *
 * ```typescript
 * import { DynamicTool } from '@langchain/core/tools';
 * const tool = new DynamicTool(createLangchainTool(saga, runSaga));
 * agent.bindTools([tool]);
 * ```
 */
export interface LangchainToolSchema {
  /** Tool name passed to the LLM (sourced from saga metadata or override). */
  name: string;
  /** Tool description passed to the LLM (sourced from saga metadata or override). */
  description: string;
  /**
   * Async function invoked by the LangChain agent.
   * The raw string `input` is the JSON-encoded context supplied by the LLM.
   * Returns a JSON string containing the saga execution result.
   */
  func: (input: string) => Promise<string>;
}

/**
 * Optional overrides / extra configuration for {@link createLangchainTool}.
 */
export interface LangchainToolOptions {
  /**
   * Override the tool name that is shown to the LLM.
   * Falls back to `saga.metadata.name` when omitted.
   */
  name?: string;
  /**
   * Override the tool description that is shown to the LLM.
   * Falls back to `saga.metadata.description` when omitted.
   */
  description?: string;
}

/**
 * Wraps a {@link SagaDefinition} as a LangChain-compatible tool schema.
 *
 * The saga's `metadata.name` and `metadata.description` are used to populate
 * the LangChain tool schema automatically, making it trivial to expose a
 * complex, rollback-safe workflow as a single LLM-callable action:
 *
 * ```typescript
 * import { DynamicTool } from '@langchain/core/tools';
 * import { createLangchainTool } from '@agentic-sage/langchain';
 *
 * const schema = createLangchainTool(orderSaga, async (ctx) => {
 *   const executor = new SagaExecutor(orderSaga, ctx);
 *   return executor.run();
 * });
 *
 * const tool = new DynamicTool(schema);
 * agent.bindTools([tool]);
 * ```
 *
 * @param saga       - The saga definition to expose as a tool.
 * @param executeFn  - Called with the parsed context when the LLM invokes the
 *                     tool.  Should create a {@link SagaExecutor} and call
 *                     `run()`, returning its result.
 * @param options    - Optional name / description overrides.
 *
 * @throws {Error} If neither `options.name` nor `saga.metadata.name` is set.
 * @throws {Error} If neither `options.description` nor `saga.metadata.description` is set.
 */
export function createLangchainTool<TContext extends SagaContext>(
  saga: SagaDefinition<TContext>,
  executeFn: (context: TContext) => Promise<unknown>,
  options?: LangchainToolOptions,
): LangchainToolSchema {
  const name = options?.name ?? saga.metadata?.name;
  const description = options?.description ?? saga.metadata?.description;

  if (!name) {
    throw new Error(
      'createLangchainTool: a tool name is required. ' +
        'Provide it via options.name or saga.metadata.name.',
    );
  }

  if (!description) {
    throw new Error(
      'createLangchainTool: a tool description is required. ' +
        'Provide it via options.description or saga.metadata.description.',
    );
  }

  return {
    name,
    description,
    func: async (input: string): Promise<string> => {
      const context = JSON.parse(input) as TContext;
      const result = await executeFn(context);
      return JSON.stringify(result);
    },
  };
}
