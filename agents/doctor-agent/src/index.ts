import { defineAgent, sortFindings, type Agent, type Finding } from "@kubeforge/core";

export interface DoctorAgentOptions {
  agents: Agent[];
}

export function createDoctorAgent({ agents }: DoctorAgentOptions): Agent {
  return defineAgent("doctor-agent", async (context) => {
    if (agents.length === 0) {
      return [
        {
          id: "doctor.no-agents",
          severity: "warning",
          title: "No diagnostic agents are registered",
          remediation: "Register at least one agent with createDoctorAgent.",
        },
      ];
    }

    const findings: Finding[] = [];

    for (const agent of agents) {
      try {
        const report = await agent.run(context);
        findings.push(...report.findings);
        context.logger.info("agent diagnostic complete", {
          agent: agent.name,
          findings: report.findings.length,
        });
      } catch (error) {
        findings.push({
          id: `doctor.agent-failed:${agent.name}`,
          severity: "error",
          title: `Agent ${agent.name} failed to run`,
          detail: error instanceof Error ? error.message : String(error),
          remediation: "Check the agent configuration and upstream connectivity, then re-run the diagnostic.",
        });
      }
    }

    const actionable = findings.filter((finding) => finding.severity !== "info").length;
    context.logger.info("doctor run complete", {
      agents: agents.length,
      findings: findings.length,
      actionable,
    });

    return sortFindings(findings);
  });
}
