import { KubeforgeError } from "@kubeforge/core";
import {
  listWorkloads,
  type RbacBindingResource,
  type RbacRoleResource,
  type SecretResource,
} from "@kubeforge/kubernetes";
import type { ToolDescriptor } from "@kubeforge/mcp-schemas";
import { scanPolicies, scanRBAC, scanSecrets, scanWorkloads } from "@kubeforge/security";
import type { Finding } from "@kubeforge/core";
import type { KubeforgeTool, ToolRuntime } from "../types.js";
import {
  kubernetesFor,
  optionalInteger,
  optionalString,
  optionalStringArray,
  requireObject,
} from "./context.js";

const CHECKS = ["workloads", "rbac", "secrets", "policies"] as const;
type CheckName = (typeof CHECKS)[number];

function selectedChecks(value: Record<string, unknown>): Set<CheckName> {
  const requested = optionalStringArray(value, "checks", definition.name) ?? [...CHECKS];
  const selected = new Set<CheckName>();

  for (const check of requested) {
    if (!(CHECKS as readonly string[]).includes(check)) {
      throw new KubeforgeError(
        `${definition.name} received unsupported check: ${check}`,
        "MCP_INVALID_ARGUMENT",
      );
    }
    selected.add(check as CheckName);
  }

  return selected;
}

function countBySeverity(findings: Finding[]): Record<Finding["severity"], number> {
  const counts: Record<Finding["severity"], number> = {
    critical: 0,
    error: 0,
    warning: 0,
    info: 0,
  };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

export const definition: ToolDescriptor = {
  name: "scan_security",
  description: "Scan workloads, RBAC, Secrets, and pod policies for security issues.",
  inputSchema: {
    type: "object",
    properties: {
      checks: {
        type: "array",
        items: { type: "string", enum: CHECKS },
        description: "Checks to run; defaults to all of them.",
      },
      namespace: { type: "string", description: "Limit the scan to one namespace." },
      context: { type: "string" },
      kubeconfig: { type: "string" },
      weakValues: {
        type: "array",
        items: { type: "string" },
        description: "Additional Secret values treated as weak.",
      },
      minimumLength: {
        type: "integer",
        minimum: 1,
        description: "Minimum acceptable Secret value length.",
      },
    },
    additionalProperties: false,
  },
};

export async function execute(input: unknown, runtime: ToolRuntime): Promise<unknown> {
  const value = requireObject(input, definition.name);
  const checks = selectedChecks(value);
  const namespace = optionalString(value, "namespace", definition.name);
  const client = kubernetesFor(runtime, {
    context: optionalString(value, "context", definition.name),
    kubeconfig: optionalString(value, "kubeconfig", definition.name),
  });
  const listOptions = namespace ? { namespace } : undefined;

  const findings: Finding[] = [];

  if (checks.has("workloads") || checks.has("policies")) {
    const workloads = await listWorkloads(client, listOptions);
    if (checks.has("workloads")) findings.push(...scanWorkloads(workloads));
    if (checks.has("policies")) findings.push(...scanPolicies(workloads));
  }

  if (checks.has("rbac")) {
    const [roles, clusterRoles, roleBindings, clusterRoleBindings] = await Promise.all([
      client.list("Role", listOptions),
      client.list("ClusterRole"),
      client.list("RoleBinding", listOptions),
      client.list("ClusterRoleBinding"),
    ]);
    findings.push(
      ...scanRBAC({
        roles: roles as RbacRoleResource[],
        clusterRoles: clusterRoles as RbacRoleResource[],
        roleBindings: roleBindings as RbacBindingResource[],
        clusterRoleBindings: clusterRoleBindings as RbacBindingResource[],
      }),
    );
  }

  if (checks.has("secrets")) {
    const secrets = (await client.list("Secret", listOptions)) as SecretResource[];
    findings.push(
      ...scanSecrets(secrets, {
        weakValues: optionalStringArray(value, "weakValues", definition.name),
        minimumLength: optionalInteger(value, "minimumLength", definition.name),
      }),
    );
  }

  return {
    checks: [...checks],
    summary: {
      total: findings.length,
      bySeverity: countBySeverity(findings),
    },
    findings,
  };
}

export function createScanSecurityTool(runtime: ToolRuntime): KubeforgeTool {
  return { definition, execute: (input) => execute(input, runtime) };
}
