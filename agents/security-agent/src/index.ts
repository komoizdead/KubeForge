import { defineAgent, type Agent } from "@kubeforge/core";
import { listWorkloads, type KubernetesClient } from "@kubeforge/kubernetes";
import { scanWorkloads, type SecurityRule } from "@kubeforge/security";

export interface SecurityAgentOptions {
  client: KubernetesClient;
  rules?: SecurityRule[];
}

export function createSecurityAgent({ client, rules }: SecurityAgentOptions): Agent {
  return defineAgent("security-agent", async ({ logger }) => {
    const workloads = await listWorkloads(client);
    const findings = rules ? scanWorkloads(workloads, rules) : scanWorkloads(workloads);

    logger.info("security scan complete", {
      workloads: workloads.length,
      findings: findings.length,
    });

    return findings;
  });
}
