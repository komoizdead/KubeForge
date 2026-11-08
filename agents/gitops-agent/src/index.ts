import { defineAgent, type Agent, type Finding } from "@kubeforge/core";
import type { HelmClient } from "@kubeforge/helm";

export interface DesiredRelease {
  name: string;
  namespace: string;
  chart: string;
  chartVersion: string;
}

export interface GitopsAgentOptions {
  helm: HelmClient;
  desired: DesiredRelease[];
}

function releaseKey(release: { name: string; namespace: string }): string {
  return `${release.namespace}/${release.name}`;
}

export function createGitopsAgent({ helm, desired }: GitopsAgentOptions): Agent {
  return defineAgent("gitops-agent", async ({ logger }) => {
    const findings: Finding[] = [];
    const releases = await helm.listReleases();
    const desiredByKey = new Map(desired.map((release) => [releaseKey(release), release]));
    const installedKeys = new Set(releases.map(releaseKey));

    for (const release of releases) {
      const key = releaseKey(release);
      const target = desiredByKey.get(key);

      if (!target) {
        findings.push({
          id: `gitops.untracked:${key}`,
          severity: "info",
          title: `Release ${key} is not tracked in Git`,
          resource: { kind: "HelmRelease", name: release.name, namespace: release.namespace },
          remediation: "Import the release into Git or remove it if it was created manually.",
        });
        continue;
      }

      if (release.status !== "deployed") {
        findings.push({
          id: `gitops.bad-status:${key}`,
          severity: "error",
          title: `Release ${key} is ${release.status}`,
          resource: { kind: "HelmRelease", name: release.name, namespace: release.namespace },
          remediation: "Inspect the release history and reconcile it with the GitOps controller.",
        });
      }

      if (release.chartVersion !== target.chartVersion) {
        findings.push({
          id: `gitops.drift:${key}`,
          severity: "warning",
          title: `Release ${key} drifted from Git`,
          detail: `Cluster has ${release.chartVersion}, Git declares ${target.chartVersion}.`,
          resource: { kind: "HelmRelease", name: release.name, namespace: release.namespace },
          remediation: "Reconcile the release with the GitOps controller or apply the version declared in Git.",
        });
      }
    }

    for (const target of desired) {
      if (!installedKeys.has(releaseKey(target))) {
        findings.push({
          id: `gitops.missing:${releaseKey(target)}`,
          severity: "error",
          title: `Release ${releaseKey(target)} is declared in Git but not installed`,
          resource: { kind: "HelmRelease", name: target.name, namespace: target.namespace },
          remediation: "Sync the GitOps controller and confirm it can reach the cluster.",
        });
      }
    }

    logger.info("gitops drift check complete", {
      releases: releases.length,
      desired: desired.length,
      findings: findings.length,
    });

    return findings;
  });
}
