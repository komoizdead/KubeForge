import { defineAgent, type Agent, type Finding } from "@kubeforge/core";
import { listWorkloads, type KubernetesClient, type Workload } from "@kubeforge/kubernetes";

export interface CostRates {
  cpuCoreMonth: number;
  memoryGiBMonth: number;
}

export const defaultRates: CostRates = {
  cpuCoreMonth: 32,
  memoryGiBMonth: 4,
};

export interface CostAgentOptions {
  client: KubernetesClient;
  rates?: CostRates;
  namespaceBudget?: number;
}

export function parseCpu(value: string | undefined): number {
  if (!value) return 0;
  const normalized = value.trim();
  if (normalized.endsWith("m")) {
    return Number.parseFloat(normalized.slice(0, -1)) / 1000;
  }
  const cores = Number.parseFloat(normalized);
  return Number.isFinite(cores) ? cores : 0;
}

const MEMORY_UNITS: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
};

export function parseMemoryBytes(value: string | undefined): number {
  if (!value) return 0;
  const match = /^([0-9.]+)([KMGT]i)?$/.exec(value.trim());
  if (!match) return 0;
  const amount = Number.parseFloat(match[1] ?? "0");
  if (!Number.isFinite(amount)) return 0;
  return amount * (MEMORY_UNITS[match[2] ?? ""] ?? 1);
}

export function estimateWorkloadCost(workload: Workload, rates: CostRates = defaultRates): number {
  const replicas = workload.spec.replicas ?? 1;
  const containers = workload.spec.template?.spec?.containers ?? [];

  const perReplica = containers.reduce((total, container) => {
    const requests = container.resources?.requests;
    const cpuCost = parseCpu(requests?.cpu) * rates.cpuCoreMonth;
    const memoryCost = (parseMemoryBytes(requests?.memory) / 1024 ** 3) * rates.memoryGiBMonth;
    return total + cpuCost + memoryCost;
  }, 0);

  return perReplica * replicas;
}

export function createCostAgent({ client, rates = defaultRates, namespaceBudget }: CostAgentOptions): Agent {
  return defineAgent("cost-agent", async ({ logger }) => {
    const findings: Finding[] = [];
    const workloads = await listWorkloads(client);
    const totals = new Map<string, number>();
    const counts = new Map<string, number>();

    for (const workload of workloads) {
      const namespace = workload.metadata.namespace ?? "default";
      totals.set(namespace, (totals.get(namespace) ?? 0) + estimateWorkloadCost(workload, rates));
      counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
    }

    for (const [namespace, total] of [...totals].sort((a, b) => b[1] - a[1])) {
      const rounded = Math.round(total * 100) / 100;
      const overBudget = namespaceBudget !== undefined && total > namespaceBudget;

      findings.push({
        id: `cost.namespace:${namespace}`,
        severity: overBudget ? "warning" : "info",
        title: `Estimated monthly cost for ${namespace}: $${rounded.toFixed(2)}`,
        detail: `Based on requested CPU and memory across ${counts.get(namespace) ?? 0} workloads.`,
        resource: { kind: "Namespace", name: namespace },
        remediation: overBudget ? `Reduce requests or rebalance workloads to stay under $${namespaceBudget}.` : undefined,
      });
    }

    if (totals.size === 0) {
      findings.push({
        id: "cost.no-workloads",
        severity: "info",
        title: "No workloads found to estimate",
        remediation: "Deploy workloads or check cluster connectivity.",
      });
    }

    logger.info("cost estimate complete", { namespaces: totals.size });
    return findings;
  });
}
