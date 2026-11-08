import { defineAgent, type Agent, type Finding } from "@kubeforge/core";
import { listWorkloads, type KubernetesClient } from "@kubeforge/kubernetes";
import type { MonitoringClient } from "@kubeforge/monitoring";

export interface ObservabilityAgentOptions {
  client: KubernetesClient;
  monitoring: MonitoringClient;
  requiredMetric?: string;
  maxAgeMinutes?: number;
}

export function createObservabilityAgent({
  client,
  monitoring,
  requiredMetric = "http_requests_total",
  maxAgeMinutes = 15,
}: ObservabilityAgentOptions): Agent {
  return defineAgent("observability-agent", async ({ logger }) => {
    const findings: Finding[] = [];
    const workloads = await listWorkloads(client);
    const namespaces = [...new Set(workloads.map((workload) => workload.metadata.namespace ?? "default"))].sort();

    for (const namespace of namespaces) {
      const samples = await monitoring.query({ metric: requiredMetric, match: { namespace } });

      if (samples.length === 0) {
        findings.push({
          id: `observability.missing-metrics:${namespace}`,
          severity: "warning",
          title: `No ${requiredMetric} samples for namespace ${namespace}`,
          detail: "Workloads exist but no metrics were returned for this namespace.",
          resource: { kind: "Namespace", name: namespace },
          remediation: "Verify ServiceMonitor/PodMonitor configuration and the metrics pipeline.",
        });
        continue;
      }

      const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();
      const latest = samples
        .map((sample) => sample.timestamp)
        .sort()
        .at(-1);

      if (!latest || latest < cutoff) {
        findings.push({
          id: `observability.stale-metrics:${namespace}`,
          severity: "warning",
          title: `Metrics for namespace ${namespace} are stale`,
          detail: `Latest sample is ${latest ?? "missing"}, expected within ${maxAgeMinutes} minutes.`,
          resource: { kind: "Namespace", name: namespace },
          remediation: "Check scrape targets and metric ingestion lag.",
        });
      }
    }

    logger.info("observability check complete", {
      namespaces: namespaces.length,
      findings: findings.length,
    });

    return findings;
  });
}
