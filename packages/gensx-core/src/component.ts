import type {
  DeepJSXElement,
  ExecutableValue,
  GsxComponent,
  GsxStreamComponent,
  MaybePromise,
  Streamable,
} from "./types.js";

import { serializeError } from "serialize-error";

import { getCurrentContext } from "./context.js";
import { JSX, jsx } from "./jsx-runtime.js";
import { resolveDeep } from "./resolve.js";

export const STREAMING_PLACEHOLDER = "[streaming in progress]";

export interface ComponentOpts {
  secretProps?: string[]; // Property paths to mask in checkpoints
  secretOutputs?: boolean; // Whether to mask the output of the component
  name?: string; // Allows you to override the name of the component
  metadata?: Record<string, unknown>; // Metadata to attach to the component
}

// omit name from ComponentOpts
export type DefaultOpts = Omit<ComponentOpts, "name">;

export type WithComponentOpts<P> = P & {
  componentOpts?: ComponentOpts;
};

export function Component<P extends object & { length?: never }, O>(
  name: string,
  fn: (props: P) => MaybePromise<O | DeepJSXElement<O> | JSX.Element>,
  defaultOpts?: DefaultOpts,
): GsxComponent<WithComponentOpts<P>, O> {
  const GsxComponent = async (props: WithComponentOpts<P>) => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (typeof props !== "object" || Array.isArray(props) || props === null) {
      throw new Error(`Component ${name} received non-object props.`);
    }

    const context = getCurrentContext();
    const workflowContext = context.getWorkflowContext();
    const { checkpointManager } = workflowContext;
    const currentNodeId = context.getCurrentNodeId();

    // Merge component opts with unique secrets
    const mergedOpts = {
      ...defaultOpts,
      ...props.componentOpts,
      ...{
        ...defaultOpts?.metadata,
        ...props.componentOpts?.metadata,
      },
      secretProps: Array.from(
        new Set([
          ...(defaultOpts?.secretProps ?? []),
          ...(props.componentOpts?.secretProps ?? []),
        ]),
      ),
      secretOutputs:
        defaultOpts?.secretOutputs ?? props.componentOpts?.secretOutputs,
    };

    // Create checkpoint node for this component execution
    const nodeId = checkpointManager.addNode(
      {
        componentName: props.componentOpts?.name ?? name,
        props: Object.fromEntries(
          Object.entries(props).filter(([key]) => key !== "children"),
        ),
        componentOpts: mergedOpts,
      },
      currentNodeId,
    );

    try {
      const result = await context.withCurrentNode(nodeId, async () => {
        const { componentOpts, ...componentProps } = props;
        const fnResult = await fn(componentProps as P);
        return resolveDeep<O | DeepJSXElement<O> | ExecutableValue<O>>(
          fnResult,
        );
      });

      // Complete the checkpoint node with the result
      checkpointManager.completeNode(nodeId, result);

      return result;
    } catch (error) {
      // Record error in checkpoint
      if (error instanceof Error) {
        checkpointManager.addMetadata(nodeId, { error: serializeError(error) });
        checkpointManager.completeNode(nodeId, undefined);
      }
      throw error;
    }
  };

  GsxComponent.run = (props: WithComponentOpts<P>) => {
    return jsx(GsxComponent, props)();
  };

  if (name) {
    Object.defineProperty(GsxComponent, "name", {
      value: name,
    });
  }

  Object.defineProperty(GsxComponent, "__gsxFramework", {
    value: true,
  });

  // Brand the component with its output type
  return GsxComponent as GsxComponent<WithComponentOpts<P>, O>;
}

export function StreamComponent<P>(
  name: string,
  fn: (
    props: P & { stream?: boolean },
  ) => MaybePromise<Streamable | JSX.Element>,
  defaultOpts?: DefaultOpts,
): GsxStreamComponent<WithComponentOpts<P & { stream?: boolean }>> {
  const GsxStreamComponent = async (
    props: WithComponentOpts<P & { stream?: boolean }>,
  ) => {
    const context = getCurrentContext();
    const workflowContext = context.getWorkflowContext();
    const { checkpointManager } = workflowContext;

    // Merge component opts with unique secrets
    const mergedOpts = {
      ...defaultOpts,
      ...props.componentOpts,
      ...{
        ...defaultOpts?.metadata,
        ...props.componentOpts?.metadata,
      },
      secretProps: Array.from(
        new Set([
          ...(defaultOpts?.secretProps ?? []),
          ...(props.componentOpts?.secretProps ?? []),
        ]),
      ),
      secretOutputs:
        defaultOpts?.secretOutputs ?? props.componentOpts?.secretOutputs,
    };

    // Create checkpoint node for this component execution
    const nodeId = checkpointManager.addNode(
      {
        componentName: props.componentOpts?.name ?? name,
        props: Object.fromEntries(
          Object.entries(props).filter(([key]) => key !== "children"),
        ),
        componentOpts: mergedOpts,
      },
      context.getCurrentNodeId(),
    );

    try {
      const iterator: Streamable = await context.withCurrentNode(nodeId, () => {
        const { componentOpts, ...componentProps } = props;
        return resolveDeep(fn(componentProps as P & { stream?: boolean }));
      });

      if (props.stream) {
        // Mark as streaming immediately
        checkpointManager.completeNode(nodeId, STREAMING_PLACEHOLDER);

        // Create a wrapper iterator that captures the output while streaming
        const wrappedIterator = async function* () {
          let accumulated = "";
          try {
            for await (const token of iterator) {
              accumulated += token;
              yield token;
            }
            // Update with final content if stream completes
            checkpointManager.updateNode(nodeId, {
              output: accumulated,
              metadata: { streamCompleted: true },
            });
          } catch (error) {
            if (error instanceof Error) {
              checkpointManager.updateNode(nodeId, {
                output: accumulated,
                metadata: {
                  error: error.message,
                  streamCompleted: false,
                },
              });
            }
            throw error;
          }
        };
        return wrappedIterator();
      }

      // Non-streaming case - accumulate all output then checkpoint
      let result = "";
      for await (const token of iterator) {
        result += token;
      }
      checkpointManager.completeNode(nodeId, result);
      return result;
    } catch (error) {
      // Record error in checkpoint
      if (error instanceof Error) {
        checkpointManager.addMetadata(nodeId, { error: error.message });
        checkpointManager.completeNode(nodeId, undefined);
      }
      throw error;
    }
  };

  GsxStreamComponent.run = <T extends P & { stream?: boolean }>(
    props: WithComponentOpts<T>,
  ) => {
    return jsx(GsxStreamComponent, props)();
  };

  if (name) {
    Object.defineProperty(GsxStreamComponent, "name", {
      value: name,
    });
  }

  Object.defineProperty(GsxStreamComponent, "__gsxFramework", {
    value: true,
  });

  Object.defineProperty(GsxStreamComponent, "__gsxStreamComponent", {
    value: true,
  });

  return GsxStreamComponent as GsxStreamComponent<
    WithComponentOpts<P & { stream?: boolean }>
  >;
}
