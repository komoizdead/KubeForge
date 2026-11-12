import { createClusterAgent } from "@kubeforge/cluster-agent";
import { createLogger } from "@kubeforge/core";
import { isNode, listWorkloads } from "@kubeforge/kubernetes";
import type { ToolDescriptor } from "@kubeforge/mcp-schemas";
import type { KubeforgeTool, ToolRuntime } from "../types.js";
import { kubernetesFor, optionalString, requireObject } from "./context.js";

function readyStatus(node: { status?: { conditions?: Array<{ type: string; status: string }> } }): boolean {
  return node.status?.conditions?.some(
    (condition) => condition.type === "Ready" && condition.status === "True",
  ) ?? false;
}

export const definition: ToolDescriptor = {
  name: "cluster_status",
  description: "Summarize node readiness and workload health, with diagnostic findings.",
  inputSchema: {
    type: "object",
    properties: {
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

  const nodes = (await client.list("Node")).filter(isNode);
  const workloads = await listWorkloads(client);
  const notReady = nodes.filter((node) => !readyStatus(node)).map((node) => node.metadata.name);
  const namespaces = [
    ...new Set(workloads.map((workload) => workload.metadata.namespace ?? "default")),
  ].sort();

  const report = await createClusterAgent({ client }).run({
    logger: runtime.logger ?? createLogger(definition.name),
  });

  return {
    summary: {
      totalNodes: nodes.length,
      readyNodes: nodes.length - notReady.length,
      notReadyNodes: notReady,
      workloads: workloads.length,
      namespaces,
    },
    findings: report.findings,
  };
}

export function createClusterStatusTool(runtime: ToolRuntime): KubeforgeTool {
  return { definition, execute: (input) => execute(input, runtime) };
}
