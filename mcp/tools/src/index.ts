import { createLogger, type Agent, type AgentReport, type Logger } from "@kubeforge/core";
import { createClusterAgent } from "@kubeforge/cluster-agent";
import { createCostAgent } from "@kubeforge/cost-agent";
import { createDoctorAgent } from "@kubeforge/doctor-agent";
import { createGitopsAgent, type DesiredRelease } from "@kubeforge/gitops-agent";
import type { HelmClient } from "@kubeforge/helm";
import type { KubernetesClient } from "@kubeforge/kubernetes";
import { noInputSchema, type ToolDescriptor } from "@kubeforge/mcp-schemas";
import type { MonitoringClient } from "@kubeforge/monitoring";
import { createObservabilityAgent } from "@kubeforge/observability-agent";
import { createSecurityAgent } from "@kubeforge/security-agent";

export interface ToolRuntime {
  kubernetes: KubernetesClient;
  helm: HelmClient;
  monitoring: MonitoringClient;
  desiredReleases: DesiredRelease[];
}

export interface KubeforgeTool {
  definition: ToolDescriptor;
  execute(): Promise<AgentReport>;
}

export interface ToolOptions {
  logger?: Logger;
}

function tool(name: string, description: string, factory: () => Agent, loggerFor: (name: string) => Logger): KubeforgeTool {
  return {
    definition: { name, description, inputSchema: noInputSchema },
    execute: () => factory().run({ logger: loggerFor(name) }),
  };
}

export function createKubeforgeTools(
  runtime: ToolRuntime,
  options: ToolOptions = {},
): KubeforgeTool[] {
  const providedLogger = options.logger;
  const loggerFor = providedLogger ? () => providedLogger : (name: string) => createLogger(name);

  const cluster = () => createClusterAgent({ client: runtime.kubernetes });
  const security = () => createSecurityAgent({ client: runtime.kubernetes });
  const observability = () =>
    createObservabilityAgent({ client: runtime.kubernetes, monitoring: runtime.monitoring });
  const gitops = () => createGitopsAgent({ helm: runtime.helm, desired: runtime.desiredReleases });
  const cost = () => createCostAgent({ client: runtime.kubernetes });
  const doctor = () => createDoctorAgent({ agents: [cluster(), security(), observability(), gitops(), cost()] });

  return [
    tool("kubeforge_cluster_inspect", "Inspect node readiness and workload health.", cluster, loggerFor),
    tool("kubeforge_security_scan", "Scan workloads against the default security rules.", security, loggerFor),
    tool(
      "kubeforge_observability_check",
      "Check metric coverage and freshness for namespaces with workloads.",
      observability,
      loggerFor,
    ),
    tool("kubeforge_gitops_drift", "Compare installed Helm releases with the desired state from Git.", gitops, loggerFor),
    tool("kubeforge_cost_estimate", "Estimate monthly cost from workload resource requests.", cost, loggerFor),
    tool("kubeforge_doctor_report", "Run every diagnostic agent and return a merged report.", doctor, loggerFor),
  ];
}
