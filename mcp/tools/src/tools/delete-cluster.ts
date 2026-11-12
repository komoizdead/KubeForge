import type { ToolDescriptor } from "@kubeforge/mcp-schemas";
import type { KubeforgeTool, ToolRuntime } from "../types.js";
import {
  clustersFor,
  optionalEnum,
  optionalInteger,
  optionalString,
  optionalStringArray,
  requireObject,
  requireString,
} from "./context.js";

const PROVIDERS = ["aks", "eks", "gke", "k3s", "minikube", "docker-desktop"] as const;

export const definition: ToolDescriptor = {
  name: "delete_cluster",
  description: "Delete a Kubernetes cluster from its provider.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Cluster name." },
      provider: { type: "string", enum: PROVIDERS },
      region: { type: "string" },
      resourceGroup: { type: "string" },
      project: { type: "string" },
      context: { type: "string" },
      args: { type: "array", items: { type: "string" }, description: "Extra provider CLI arguments." },
      kubectl: { type: "string" },
      timeoutMs: { type: "integer", minimum: 1 },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

export async function execute(input: unknown, runtime: ToolRuntime): Promise<unknown> {
  const value = requireObject(input, definition.name);
  const name = requireString(value, "name", definition.name);
  const provider = optionalEnum(value, "provider", definition.name, PROVIDERS);
  const region = optionalString(value, "region", definition.name);
  const resourceGroup = optionalString(value, "resourceGroup", definition.name);
  const project = optionalString(value, "project", definition.name);

  const manager = clustersFor(runtime, {
    provider,
    context: optionalString(value, "context", definition.name),
    region,
    resourceGroup,
    project,
    kubectl: optionalString(value, "kubectl", definition.name),
    timeoutMs: optionalInteger(value, "timeoutMs", definition.name),
  });

  await manager.deleteCluster({
    name,
    provider,
    region,
    resourceGroup,
    project,
    args: optionalStringArray(value, "args", definition.name),
  });

  return { deleted: true, name, provider: provider ?? manager.provider ?? null };
}

export function createDeleteClusterTool(runtime: ToolRuntime): KubeforgeTool {
  return { definition, execute: (input) => execute(input, runtime) };
}
