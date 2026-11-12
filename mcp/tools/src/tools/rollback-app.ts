import type { WorkloadKind } from "@kubeforge/kubernetes";
import type { ToolDescriptor } from "@kubeforge/mcp-schemas";
import type { KubeforgeTool, ToolRuntime } from "../types.js";
import {
  clustersFor,
  optionalInteger,
  optionalString,
  optionalStringArray,
  requireEnum,
  requireObject,
  requireString,
} from "./context.js";

const WORKLOAD_KINDS = ["Deployment", "StatefulSet", "DaemonSet"] as const satisfies readonly WorkloadKind[];

export const definition: ToolDescriptor = {
  name: "rollback_app",
  description: "Roll a Deployment, StatefulSet, or DaemonSet back to a previous revision.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: WORKLOAD_KINDS },
      name: { type: "string" },
      namespace: { type: "string" },
      revision: { type: "integer", minimum: 1, description: "Target revision; defaults to the previous one." },
      context: { type: "string" },
      kubeconfig: { type: "string" },
      args: { type: "array", items: { type: "string" }, description: "Extra kubectl arguments." },
      kubectl: { type: "string" },
      timeoutMs: { type: "integer", minimum: 1 },
    },
    required: ["kind", "name"],
    additionalProperties: false,
  },
};

export async function execute(input: unknown, runtime: ToolRuntime): Promise<unknown> {
  const value = requireObject(input, definition.name);
  const kind = requireEnum(value, "kind", definition.name, WORKLOAD_KINDS);

  const context = optionalString(value, "context", definition.name);
  const kubeconfig = optionalString(value, "kubeconfig", definition.name);

  const manager = clustersFor(runtime, {
    context,
    kubeconfig,
    kubectl: optionalString(value, "kubectl", definition.name),
    timeoutMs: optionalInteger(value, "timeoutMs", definition.name),
  });

  return manager.rollback({
    kind,
    name: requireString(value, "name", definition.name),
    namespace: optionalString(value, "namespace", definition.name),
    revision: optionalInteger(value, "revision", definition.name),
    context,
    kubeconfig,
    args: optionalStringArray(value, "args", definition.name),
  });
}

export function createRollbackAppTool(runtime: ToolRuntime): KubeforgeTool {
  return { definition, execute: (input) => execute(input, runtime) };
}
