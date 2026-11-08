import { createInMemoryHelmClient } from "@kubeforge/helm";
import { createInMemoryKubernetesClient } from "@kubeforge/kubernetes";
import type { ToolRuntime } from "@kubeforge/mcp-tools";
import { createInMemoryMonitoringClient } from "@kubeforge/monitoring";

const now = new Date().toISOString();

export function createDemoRuntime(): ToolRuntime {
  const kubernetes = createInMemoryKubernetesClient({
    nodes: [
      {
        metadata: { name: "worker-1", labels: { role: "worker" } },
        status: {
          conditions: [{ type: "Ready", status: "True" }],
          capacity: { cpu: "8", memory: "32Gi" },
        },
      },
      {
        metadata: { name: "worker-2", labels: { role: "worker" } },
        status: { conditions: [{ type: "Ready", status: "False" }] },
      },
    ],
    namespaces: [{ metadata: { name: "storefront" } }, { metadata: { name: "payments" } }],
    workloads: [
      {
        kind: "Deployment",
        metadata: { name: "checkout", namespace: "storefront" },
        spec: {
          replicas: 3,
          template: {
            spec: {
              containers: [
                {
                  name: "web",
                  image: "ghcr.io/example/checkout:1.4.2",
                  resources: { requests: { cpu: "250m", memory: "512Mi" } },
                },
                {
                  name: "sidecar",
                  image: "envoy:latest",
                  securityContext: { privileged: true },
                },
              ],
            },
          },
        },
      },
      {
        kind: "Deployment",
        metadata: { name: "ledger", namespace: "payments" },
        spec: {
          replicas: 2,
          template: {
            spec: {
              containers: [
                {
                  name: "api",
                  image: "ghcr.io/example/ledger:2.0.1",
                  resources: { requests: { cpu: "1", memory: "2Gi" } },
                  securityContext: { privileged: false, runAsNonRoot: true, readOnlyRootFilesystem: true },
                },
              ],
            },
          },
        },
      },
    ],
  });

  const helm = createInMemoryHelmClient([
    {
      name: "storefront",
      namespace: "storefront",
      chart: "storefront",
      chartVersion: "1.4.2",
      status: "deployed",
      updatedAt: now,
    },
    {
      name: "ledger",
      namespace: "payments",
      chart: "ledger",
      chartVersion: "2.0.0",
      status: "failed",
      updatedAt: now,
    },
  ]);

  const monitoring = createInMemoryMonitoringClient([
    {
      metric: "http_requests_total",
      labels: { namespace: "storefront" },
      value: 1250,
      timestamp: now,
    },
  ]);

  return {
    kubernetes,
    helm,
    monitoring,
    desiredReleases: [
      { name: "storefront", namespace: "storefront", chart: "storefront", chartVersion: "1.4.2" },
      { name: "ledger", namespace: "payments", chart: "ledger", chartVersion: "2.0.1" },
    ],
  };
}
