import { createLogger, type Agent, type Logger } from "@kubeforge/core";
import { createClusterAgent } from "@kubeforge/cluster-agent";
import { createCostAgent } from "@kubeforge/cost-agent";
import { createDoctorAgent } from "@kubeforge/doctor-agent";
import { createGitopsAgent } from "@kubeforge/gitops-agent";
import { noInputSchema } from "@kubeforge/mcp-schemas";
import { createObservabilityAgent } from "@kubeforge/observability-agent";
import { createSecurityAgent } from "@kubeforge/security-agent";
import type { KubeforgeTool, ToolOptions, ToolRuntime } from "./types.js";
import { createClusterStatusTool } from "./tools/cluster-status.js";
import { createCostReportTool } from "./tools/cost-report.js";
import { createCreateClusterTool } from "./tools/create-cluster.js";
import { createDeleteClusterTool } from "./tools/delete-cluster.js";
import { createDeployAppTool } from "./tools/deploy-app.js";
import { createListNodesTool } from "./tools/list-nodes.js";
import { createRollbackAppTool } from "./tools/rollback-app.js";
import { createScanSecurityTool } from "./tools/scan-security.js";

export type { KubeforgeTool, ToolOptions, ToolRuntime } from "./types.js";

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
  const toolRuntime: ToolRuntime = { ...runtime, logger: providedLogger ?? runtime.logger };

  const cluster = () => createClusterAgent({ client: runtime.kubernetes });
  const security = () => createSecurityAgent({ client: runtime.kubernetes });
  const observability = () =>
    createObservabilityAgent({ client: runtime.kubernetes, monitoring: runtime.monitoring });
  const gitops = () => createGitopsAgent({ helm: runtime.helm, desired: runtime.desiredReleases });
  const cost = () => createCostAgent({ client: runtime.kubernetes });
  const doctor = () => createDoctorAgent({ agents: [cluster(), security(), observability(), gitops(), cost()] });

  return [
    createCreateClusterTool(toolRuntime),
    createDeleteClusterTool(toolRuntime),
    createDeployAppTool(toolRuntime),
    createRollbackAppTool(toolRuntime),
    createScanSecurityTool(toolRuntime),
    createListNodesTool(toolRuntime),
    createClusterStatusTool(toolRuntime),
    createCostReportTool(toolRuntime),
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
