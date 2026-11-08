import { defineAgent, type Agent, type Finding } from "@kubeforge/core";
import { isNode, listWorkloads, type KubernetesClient } from "@kubeforge/kubernetes";

export interface ClusterAgentOptions {
  client: KubernetesClient;
}

export function createClusterAgent({ client }: ClusterAgentOptions): Agent {
  return defineAgent("cluster-agent", async ({ logger }) => {
    const findings: Finding[] = [];
    const nodes = (await client.list("Node")).filter(isNode);

    if (nodes.length === 0) {
      findings.push({
        id: "cluster.no-nodes",
        severity: "critical",
        title: "No nodes are registered in the cluster",
        remediation: "Verify kubelet registration and the cluster control plane.",
      });
    }

    for (const node of nodes) {
      const ready = node.status?.conditions?.find((condition) => condition.type === "Ready");
      if (ready?.status !== "True") {
        findings.push({
          id: `cluster.node-not-ready:${node.metadata.name}`,
          severity: "error",
          title: `Node ${node.metadata.name} is not Ready`,
          detail: `Ready condition is ${ready?.status ?? "missing"}.`,
          resource: { kind: "Node", name: node.metadata.name },
          remediation: "Inspect kubelet, the container runtime, and node network connectivity.",
        });
      }
    }

    const workloads = await listWorkloads(client);
    for (const workload of workloads.filter((candidate) => candidate.spec.replicas === 0)) {
      const namespace = workload.metadata.namespace ?? "default";
      findings.push({
        id: `cluster.scaled-to-zero:${workload.kind}:${namespace}/${workload.metadata.name}`,
        severity: "warning",
        title: `${workload.kind} ${workload.metadata.name} is scaled to zero`,
        resource: { kind: workload.kind, name: workload.metadata.name, namespace },
        remediation: "Scale the workload back up or remove it if it is no longer needed.",
      });
    }

    logger.info("cluster inspection complete", {
      nodes: nodes.length,
      workloads: workloads.length,
      findings: findings.length,
    });

    return findings;
  });
}
