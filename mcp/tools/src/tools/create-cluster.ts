import type { CreateClusterOptions } from "@kubeforge/kubernetes";
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
  name: "create_cluster",
  description: "Create a Kubernetes cluster on AKS, EKS, GKE, k3s, Minikube, or Docker Desktop.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Cluster name." },
      provider: { type: "string", enum: PROVIDERS },
      nodes: { type: "integer", minimum: 1, description: "Number of nodes to provision." },
      nodeSize: { type: "string", description: "Provider-specific node size or machine type." },
      kubernetesVersion: { type: "string" },
      region: { type: "string" },
      resourceGroup: { type: "string" },
      project: { type: "string" },
      nodeGroup: { type: "string" },
      context: { type: "string", description: "kubeconfig context to use." },
      driver: { type: "string", description: "k3d or Minikube driver override." },
      args: { type: "array", items: { type: "string" }, description: "Extra provider CLI arguments." },
      kubectl: { type: "string", description: "kubectl binary to invoke." },
      timeoutMs: { type: "integer", minimum: 1 },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

export async function execute(input: unknown, runtime: ToolRuntime): Promise<unknown> {
  const value = requireObject(input, definition.name);
  const options: CreateClusterOptions = {
    name: requireString(value, "name", definition.name),
    provider: optionalEnum(value, "provider", definition.name, PROVIDERS),
    nodes: optionalInteger(value, "nodes", definition.name),
    nodeSize: optionalString(value, "nodeSize", definition.name),
    kubernetesVersion: optionalString(value, "kubernetesVersion", definition.name),
    region: optionalString(value, "region", definition.name),
    resourceGroup: optionalString(value, "resourceGroup", definition.name),
    project: optionalString(value, "project", definition.name),
    nodeGroup: optionalString(value, "nodeGroup", definition.name),
    context: optionalString(value, "context", definition.name),
    driver: optionalString(value, "driver", definition.name),
    args: optionalStringArray(value, "args", definition.name),
  };

  const manager = clustersFor(runtime, {
    provider: options.provider,
    context: options.context,
    region: options.region,
    resourceGroup: options.resourceGroup,
    project: options.project,
    nodeGroup: options.nodeGroup,
    kubectl: optionalString(value, "kubectl", definition.name),
    timeoutMs: optionalInteger(value, "timeoutMs", definition.name),
  });

  return manager.createCluster(options);
}

export function createCreateClusterTool(runtime: ToolRuntime): KubeforgeTool {
  return { definition, execute: (input) => execute(input, runtime) };
}
