import type { Logger } from "@kubeforge/core";
import type { DesiredRelease } from "@kubeforge/gitops-agent";
import type { HelmClient } from "@kubeforge/helm";
import type { ClusterManager, KubernetesClient } from "@kubeforge/kubernetes";
import type { ToolDescriptor } from "@kubeforge/mcp-schemas";
import type { MonitoringClient } from "@kubeforge/monitoring";

export interface ToolRuntime {
  kubernetes: KubernetesClient;
  helm: HelmClient;
  monitoring: MonitoringClient;
  desiredReleases: DesiredRelease[];
  clusters?: ClusterManager;
  logger?: Logger;
}

export interface KubeforgeTool {
  definition: ToolDescriptor;
  execute(input?: unknown): Promise<unknown>;
}

export interface ToolOptions {
  logger?: Logger;
}
