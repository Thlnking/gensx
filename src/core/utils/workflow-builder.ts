import React from "react";

import { Step } from "../components/Step";
import { createWorkflowOutput } from "../hooks/useWorkflowOutput";
import { renderWorkflow } from "./renderWorkflow";

type WorkflowRenderFunction<T> = (value: T) => React.ReactElement | null;

type WorkflowImplementation<TProps, TOutput> = (
  props: ResolvedProps<TProps>,
  render: WorkflowRenderFunction<TOutput>,
) =>
  | React.ReactElement
  | Promise<React.ReactElement>
  | null
  | Promise<React.ReactElement | null>;

type WorkflowComponentProps<TProps, TOutput> = TProps & {
  children?: (output: TOutput) => React.ReactNode;
  setOutput?: (value: TOutput) => void;
};

// Type to convert a props type to allow promises
type PromiseProps<TProps> = {
  [K in keyof TProps]: TProps[K] | Promise<TProps[K]>;
};

// Type to ensure implementation gets resolved props
type ResolvedProps<TProps> = {
  [K in keyof TProps]: TProps[K] extends Promise<infer U> ? U : TProps[K];
};

async function resolveValue<T>(value: T | Promise<T>): Promise<T> {
  return value instanceof Promise ? await value : value;
}

// Keep track of processed results to prevent infinite loops
const processedResults = new Set<string>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createWorkflow<TProps extends Record<string, any>, TOutput>(
  implementation: WorkflowImplementation<TProps, TOutput>,
): React.ComponentType<WorkflowComponentProps<PromiseProps<TProps>, TOutput>> {
  const WorkflowComponent = (
    props: WorkflowComponentProps<PromiseProps<TProps>, TOutput>,
  ): React.ReactElement | null => {
    const { children, setOutput, ...componentProps } = props;
    const [, setWorkflowOutput] = createWorkflowOutput<TOutput>(
      null as unknown as TOutput,
    );

    const step: Step = {
      async execute(context) {
        try {
          // Resolve all props in parallel
          const resolvedProps = {} as ResolvedProps<TProps>;
          await Promise.all(
            Object.entries(componentProps).map(async ([key, value]) => {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              resolvedProps[key as keyof TProps] = await resolveValue(value);
            }),
          );

          // Create render function that sets output and returns element
          const render: WorkflowRenderFunction<TOutput> = value => {
            setWorkflowOutput(value);
            if (setOutput) {
              setOutput(value);
            }
            if (children) {
              return children(value) as React.ReactElement;
            }
            return null;
          };

          // Get the workflow result with resolved props
          const element = await Promise.resolve(
            implementation(resolvedProps, render),
          );

          // Process the element chain
          if (element) {
            const elementSteps = renderWorkflow(element);
            // Execute steps sequentially to ensure proper chaining
            for (const step of elementSteps) {
              await step.execute(context);
            }
          }

          return [];
        } catch (error) {
          console.error("Error in workflow step:", error);
          throw error;
        }
      },
    };

    return React.createElement("div", {
      "data-workflow-step": true,
      step,
    });
  };

  // For execution phase, we need a way to get the workflow result without React
  WorkflowComponent.getWorkflowResult = async (
    props: WorkflowComponentProps<PromiseProps<TProps>, TOutput>,
  ): Promise<React.ReactElement | null> => {
    const { children, setOutput, ...componentProps } = props;

    // Generate a unique key for this result
    const resultKey = JSON.stringify(componentProps);
    if (processedResults.has(resultKey)) {
      return null;
    }
    processedResults.add(resultKey);

    const [, setWorkflowOutput] = createWorkflowOutput<TOutput>(
      null as unknown as TOutput,
    );

    try {
      // Resolve all props before passing to implementation
      const resolvedProps = {} as ResolvedProps<TProps>;
      for (const [key, value] of Object.entries(componentProps)) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        resolvedProps[key as keyof TProps] = await resolveValue(value);
      }

      // Create render function that sets output and returns element
      const render: WorkflowRenderFunction<TOutput> = value => {
        setWorkflowOutput(value);
        if (setOutput) {
          setOutput(value);
        }
        if (children) {
          return children(value) as React.ReactElement;
        }
        return null;
      };

      // Get the workflow result
      const implementationResult = await implementation(resolvedProps, render);
      return implementationResult;
    } catch (error) {
      console.error("Error in getWorkflowResult:", error);
      throw error;
    } finally {
      processedResults.delete(resultKey);
    }
  };

  WorkflowComponent.displayName = "Workflow";
  return WorkflowComponent;
}
