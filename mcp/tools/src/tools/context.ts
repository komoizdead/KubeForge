import { KubeforgeError } from "@kubeforge/core";
import {
  createClusterManager,
  createKubernetesClient,
  type ClusterManager,
  type ClusterProviderName,
  type KubernetesClient,
} from "@kubeforge/kubernetes";
import type { ToolRuntime } from "../types.js";

export interface ConnectionInput {
  context?: string;
  kubeconfig?: string;
}

export interface ClusterConnectionInput extends ConnectionInput {
  provider?: ClusterProviderName;
  region?: string;
  resourceGroup?: string;
  project?: string;
  nodeGroup?: string;
  kubectl?: string;
  timeoutMs?: number;
}

export function requireObject(input: unknown, tool: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new KubeforgeError(`${tool} requires an object input`, "MCP_INVALID_ARGUMENT");
  }
  return input as Record<string, unknown>;
}

function invalid(tool: string, key: string, expected: string): never {
  throw new KubeforgeError(`${tool} requires "${key}" to be ${expected}`, "MCP_INVALID_ARGUMENT");
}

export function requireString(input: Record<string, unknown>, key: string, tool: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) invalid(tool, key, "a non-empty string");
  return value.trim();
}

export function optionalString(
  input: Record<string, unknown>,
  key: string,
  tool: string,
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") invalid(tool, key, "a string");
  return value;
}

export function optionalInteger(
  input: Record<string, unknown>,
  key: string,
  tool: string,
  minimum = 1,
): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    invalid(tool, key, `an integer greater than or equal to ${minimum}`);
  }
  return value;
}

export function optionalNumber(
  input: Record<string, unknown>,
  key: string,
  tool: string,
  minimum = 0,
): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    invalid(tool, key, `a number greater than or equal to ${minimum}`);
  }
  return value;
}

export function optionalBoolean(
  input: Record<string, unknown>,
  key: string,
  tool: string,
): boolean | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") invalid(tool, key, "a boolean");
  return value;
}

export function optionalStringArray(
  input: Record<string, unknown>,
  key: string,
  tool: string,
): string[] | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    invalid(tool, key, "an array of strings");
  }
  return value as string[];
}

export function optionalStringMap(
  input: Record<string, unknown>,
  key: string,
  tool: string,
): Record<string, string> | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((entry) => typeof entry !== "string")
  ) {
    invalid(tool, key, "an object with string values");
  }
  return value as Record<string, string>;
}

export function requireEnum<T extends string>(
  input: Record<string, unknown>,
  key: string,
  tool: string,
  allowed: readonly T[],
): T {
  const value = requireString(input, key, tool);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new KubeforgeError(
      `${tool} received unsupported "${key}": ${value}`,
      "MCP_INVALID_ARGUMENT",
    );
  }
  return value as T;
}

export function optionalEnum<T extends string>(
  input: Record<string, unknown>,
  key: string,
  tool: string,
  allowed: readonly T[],
): T | undefined {
  const value = optionalString(input, key, tool);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new KubeforgeError(
      `${tool} received unsupported "${key}": ${value}`,
      "MCP_INVALID_ARGUMENT",
    );
  }
  return value as T;
}

export function kubernetesFor(runtime: ToolRuntime, input: ConnectionInput): KubernetesClient {
  if (input.context || input.kubeconfig) {
    return createKubernetesClient({ context: input.context, kubeconfig: input.kubeconfig });
  }
  return runtime.kubernetes;
}

export function clustersFor(runtime: ToolRuntime, input: ClusterConnectionInput = {}): ClusterManager {
  if (runtime.clusters) return runtime.clusters;

  return createClusterManager({
    provider: input.provider,
    context: input.context,
    kubeconfig: input.kubeconfig,
    region: input.region,
    resourceGroup: input.resourceGroup,
    project: input.project,
    nodeGroup: input.nodeGroup,
    kubectl: input.kubectl,
    timeoutMs: input.timeoutMs,
  });
}
