import { KubeforgeError } from "@kubeforge/core";
import type { ManifestInput } from "@kubeforge/kubernetes";
import type { ToolDescriptor } from "@kubeforge/mcp-schemas";
import type { KubeforgeTool, ToolRuntime } from "../types.js";
import {
  clustersFor,
  optionalBoolean,
  optionalInteger,
  optionalString,
  optionalStringArray,
  requireObject,
} from "./context.js";

const MANIFEST_SCHEMA = {
  oneOf: [
    { type: "string", description: "One or more YAML documents." },
    { type: "object", description: "A manifest object." },
    {
      type: "array",
      items: { oneOf: [{ type: "string" }, { type: "object" }] },
      description: "A list of YAML strings and/or manifest objects.",
    },
  ],
};

function readManifests(input: Record<string, unknown>, tool: string): ManifestInput {
  const value = input.manifests;

  if (typeof value === "string") {
    if (!value.trim()) {
      throw new KubeforgeError(`${tool} requires at least one manifest document`, "MCP_INVALID_ARGUMENT");
    }
    return value;
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new KubeforgeError(`${tool} requires at least one manifest document`, "MCP_INVALID_ARGUMENT");
    }
    for (const document of value) {
      const valid =
        (typeof document === "string" && document.trim().length > 0) ||
        (typeof document === "object" && document !== null && !Array.isArray(document));
      if (!valid) {
        throw new KubeforgeError(
          `${tool} received an invalid manifest document`,
          "MCP_INVALID_ARGUMENT",
        );
      }
    }
    return value as ManifestInput;
  }

  throw new KubeforgeError(
    `${tool} requires "manifests" as YAML text, an object, or an array of either`,
    "MCP_INVALID_ARGUMENT",
  );
}

export const definition: ToolDescriptor = {
  name: "deploy_app",
  description: "Apply Kubernetes manifests with kubectl apply.",
  inputSchema: {
    type: "object",
    properties: {
      manifests: MANIFEST_SCHEMA,
      namespace: { type: "string" },
      context: { type: "string" },
      kubeconfig: { type: "string" },
      wait: { type: "boolean", description: "Wait for resources to become ready." },
      args: { type: "array", items: { type: "string" }, description: "Extra kubectl arguments." },
      kubectl: { type: "string" },
      timeoutMs: { type: "integer", minimum: 1 },
    },
    required: ["manifests"],
    additionalProperties: false,
  },
};

export async function execute(input: unknown, runtime: ToolRuntime): Promise<unknown> {
  const value = requireObject(input, definition.name);
  const context = optionalString(value, "context", definition.name);
  const kubeconfig = optionalString(value, "kubeconfig", definition.name);

  const manager = clustersFor(runtime, {
    context,
    kubeconfig,
    kubectl: optionalString(value, "kubectl", definition.name),
    timeoutMs: optionalInteger(value, "timeoutMs", definition.name),
  });

  return manager.deploy({
    manifests: readManifests(value, definition.name),
    namespace: optionalString(value, "namespace", definition.name),
    context,
    kubeconfig,
    wait: optionalBoolean(value, "wait", definition.name),
    args: optionalStringArray(value, "args", definition.name),
  });
}

export function createDeployAppTool(runtime: ToolRuntime): KubeforgeTool {
  return { definition, execute: (input) => execute(input, runtime) };
}
