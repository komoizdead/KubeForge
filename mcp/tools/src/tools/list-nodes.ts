import type { ToolDescriptor } from "@kubeforge/mcp-schemas";
import type { KubeforgeTool, ToolRuntime } from "../types.js";
import {
  kubernetesFor,
  optionalString,
  optionalStringMap,
  requireObject,
} from "./context.js";

export const definition: ToolDescriptor = {
  name: "list_nodes",
  description: "List cluster nodes, optionally filtered by labels.",
  inputSchema: {
    type: "object",
    properties: {
      labelSelector: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Node labels that must match, for example { \"role\": \"worker\" }.",
      },
      context: { type: "string" },
      kubeconfig: { type: "string" },
    },
    additionalProperties: false,
  },
};

export async function execute(input: unknown, runtime: ToolRuntime): Promise<unknown> {
  const value = requireObject(input, definition.name);
  const client = kubernetesFor(runtime, {
    context: optionalString(value, "context", definition.name),
    kubeconfig: optionalString(value, "kubeconfig", definition.name),
  });

  const nodes = await client.list("Node", {
    labelSelector: optionalStringMap(value, "labelSelector", definition.name),
  });

  return { count: nodes.length, nodes };
}

export function createListNodesTool(runtime: ToolRuntime): KubeforgeTool {
  return { definition, execute: (input) => execute(input, runtime) };
}
