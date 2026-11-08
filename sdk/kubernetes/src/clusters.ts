import { KubeforgeError } from "@kubeforge/core";
import { parseAllDocuments, stringify } from "yaml";
import { createCommandRunner, runCli, type CommandRunner } from "./cli.js";
import { createKubernetesClient } from "./http-client.js";
import { clusterDriver } from "./providers.js";
import type { KubernetesClient, NodeResource, WorkloadKind } from "./index.js";

export type ClusterProviderName = "aks" | "eks" | "gke" | "k3s" | "minikube" | "docker-desktop";

export interface ClusterManagerOptions {
  provider?: ClusterProviderName;
  context?: string;
  kubeconfig?: string;
  region?: string;
  resourceGroup?: string;
  project?: string;
  nodeGroup?: string;
  kubectl?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  runner?: CommandRunner;
  client?: KubernetesClient;
}

export interface ClusterHandle {
  provider: ClusterProviderName;
  name: string;
  context?: string;
}

export interface CreateClusterOptions {
  name: string;
  provider?: ClusterProviderName;
  nodes?: number;
  nodeSize?: string;
  kubernetesVersion?: string;
  region?: string;
  resourceGroup?: string;
  project?: string;
  nodeGroup?: string;
  context?: string;
  driver?: string;
  args?: string[];
}

export interface DeleteClusterOptions {
  name: string;
  provider?: ClusterProviderName;
  region?: string;
  resourceGroup?: string;
  project?: string;
  args?: string[];
}

export interface ScaleNodesOptions {
  name: string;
  nodes: number;
  provider?: ClusterProviderName;
  region?: string;
  resourceGroup?: string;
  project?: string;
  nodeGroup?: string;
  args?: string[];
}

export interface ListNodesOptions {
  context?: string;
  kubeconfig?: string;
  labelSelector?: Record<string, string>;
}

export type ManifestDocument = string | Record<string, unknown>;
export type ManifestInput = ManifestDocument | ManifestDocument[];

export interface DeployOptions {
  manifests: ManifestInput;
  namespace?: string;
  context?: string;
  kubeconfig?: string;
  wait?: boolean;
  args?: string[];
}

export interface DeployResult {
  applied: number;
  namespace?: string;
  context?: string;
  stdout: string;
}

export interface RollbackOptions {
  kind: WorkloadKind;
  name: string;
  namespace?: string;
  revision?: number;
  context?: string;
  kubeconfig?: string;
  args?: string[];
}

export interface RollbackResult {
  kind: WorkloadKind;
  name: string;
  namespace?: string;
  revision?: number;
  stdout: string;
}

export interface ClusterManager {
  readonly provider?: ClusterProviderName;
  createCluster(options: CreateClusterOptions): Promise<ClusterHandle>;
  deleteCluster(options: DeleteClusterOptions): Promise<void>;
  scaleNodes(options: ScaleNodesOptions): Promise<void>;
  listNodes(options?: ListNodesOptions): Promise<NodeResource[]>;
  deploy(options: DeployOptions): Promise<DeployResult>;
  rollback(options: RollbackOptions): Promise<RollbackResult>;
}

export interface ResolvedCreate {
  name: string;
  nodes: number;
  nodeSize?: string;
  kubernetesVersion?: string;
  region?: string;
  resourceGroup?: string;
  project?: string;
  nodeGroup?: string;
  context?: string;
  driver?: string;
  args: string[];
}

export interface ResolvedDelete {
  name: string;
  region?: string;
  resourceGroup?: string;
  project?: string;
  args: string[];
}

export interface ResolvedScale extends ResolvedDelete {
  nodes: number;
  nodeGroup?: string;
}

const DEFAULT_NODES: Record<ClusterProviderName, number> = {
  aks: 3,
  eks: 3,
  gke: 3,
  k3s: 1,
  minikube: 1,
  "docker-desktop": 1,
};

const PROVIDER_DEFAULT_CONTEXT: Partial<Record<ClusterProviderName, string>> = {
  "docker-desktop": "docker-desktop",
};

function requireName(name: string | undefined): string {
  const trimmed = name?.trim();
  if (!trimmed) {
    throw new KubeforgeError("A cluster name is required", "KUBERNETES_INVALID_ARGUMENT");
  }
  return trimmed;
}

function requireNodes(nodes: number): number {
  if (!Number.isInteger(nodes) || nodes < 1) {
    throw new KubeforgeError(
      `Node count must be a positive integer, received ${nodes}`,
      "KUBERNETES_INVALID_ARGUMENT",
    );
  }
  return nodes;
}

function countDocuments(text: string): number {
  try {
    return parseAllDocuments(text).filter((document) => {
      const value = document.toJS();
      return value !== null && value !== undefined;
    }).length;
  } catch (error) {
    throw new KubeforgeError(
      `Invalid Kubernetes manifest: ${error instanceof Error ? error.message : String(error)}`,
      "KUBERNETES_MANIFEST_INVALID",
      { cause: error },
    );
  }
}

function serializeManifests(manifests: ManifestInput): { text: string; applied: number } {
  const documents = Array.isArray(manifests) ? manifests : [manifests];
  const parts: string[] = [];
  let applied = 0;

  for (const document of documents) {
    if (typeof document === "string") {
      const text = document.trim();
      if (!text) continue;
      applied += countDocuments(text);
      parts.push(text);
    } else {
      applied += 1;
      parts.push(stringify(document).trimEnd());
    }
  }

  if (applied === 0) {
    throw new KubeforgeError("At least one manifest document is required", "KUBERNETES_INVALID_ARGUMENT");
  }

  return { text: `${parts.join("\n---\n")}\n`, applied };
}

function isNodeResource(value: unknown): value is NodeResource {
  return typeof value === "object" && value !== null && "metadata" in value;
}

export function createClusterManager(options: ClusterManagerOptions = {}): ClusterManager {
  const runner = options.runner ?? createCommandRunner();
  const kubectl = options.kubectl ?? "kubectl";

  const providerFor = (explicit: ClusterProviderName | undefined): ClusterProviderName => {
    const provider = explicit ?? options.provider;
    if (!provider) {
      throw new KubeforgeError(
        "A cluster provider is required; pass provider or set it on the cluster manager",
        "KUBERNETES_PROVIDER_REQUIRED",
      );
    }
    return provider;
  };

  const command = (name: string, args: string[], stdin?: string) =>
    runCli(runner, name, args, { timeoutMs: options.timeoutMs, env: options.env, stdin });

  const kubectlArgs = (
    verb: string[],
    target: { context?: string; kubeconfig?: string; namespace?: string; extra?: string[] },
  ): string[] => {
    const args = [...verb];
    const context = target.context ?? options.context;
    const kubeconfig = target.kubeconfig ?? options.kubeconfig;
    if (context) args.push("--context", context);
    if (kubeconfig) args.push("--kubeconfig", kubeconfig);
    if (target.namespace) args.push("--namespace", target.namespace);
    args.push(...(target.extra ?? []));
    return args;
  };

  return {
    provider: options.provider,

    async createCluster(createOptions) {
      const provider = providerFor(createOptions.provider);
      const driver = clusterDriver(provider);
      const nodes = requireNodes(createOptions.nodes ?? DEFAULT_NODES[provider] ?? 1);

      return driver.create(
        {
          name: requireName(createOptions.name),
          nodes,
          nodeSize: createOptions.nodeSize,
          kubernetesVersion: createOptions.kubernetesVersion,
          region: createOptions.region ?? options.region,
          resourceGroup: createOptions.resourceGroup ?? options.resourceGroup,
          project: createOptions.project ?? options.project,
          nodeGroup: createOptions.nodeGroup ?? options.nodeGroup,
          context: createOptions.context ?? options.context,
          driver: createOptions.driver,
          args: createOptions.args ?? [],
        },
        { runner, env: options.env, timeoutMs: options.timeoutMs },
      );
    },

    async deleteCluster(deleteOptions) {
      const provider = providerFor(deleteOptions.provider);
      const driver = clusterDriver(provider);

      await driver.remove(
        {
          name: requireName(deleteOptions.name),
          region: deleteOptions.region ?? options.region,
          resourceGroup: deleteOptions.resourceGroup ?? options.resourceGroup,
          project: deleteOptions.project ?? options.project,
          args: deleteOptions.args ?? [],
        },
        { runner, env: options.env, timeoutMs: options.timeoutMs },
      );
    },

    async scaleNodes(scaleOptions) {
      const provider = providerFor(scaleOptions.provider);
      const driver = clusterDriver(provider);

      await driver.scale(
        {
          name: requireName(scaleOptions.name),
          nodes: requireNodes(scaleOptions.nodes),
          region: scaleOptions.region ?? options.region,
          resourceGroup: scaleOptions.resourceGroup ?? options.resourceGroup,
          project: scaleOptions.project ?? options.project,
          nodeGroup: scaleOptions.nodeGroup ?? options.nodeGroup,
          args: scaleOptions.args ?? [],
        },
        { runner, env: options.env, timeoutMs: options.timeoutMs },
      );
    },

    async listNodes(listOptions = {}) {
      if (!options.client) {
        const context =
          listOptions.context ??
          options.context ??
          (options.provider ? PROVIDER_DEFAULT_CONTEXT[options.provider] : undefined);
        const client = createKubernetesClient({
          kubeconfig: listOptions.kubeconfig ?? options.kubeconfig,
          context,
          timeoutMs: options.timeoutMs,
        });
        const nodes = await client.list("Node", { labelSelector: listOptions.labelSelector });
        return nodes.filter(isNodeResource);
      }

      const nodes = await options.client.list("Node", { labelSelector: listOptions.labelSelector });
      return nodes.filter(isNodeResource);
    },

    async deploy(deployOptions) {
      const { text, applied } = serializeManifests(deployOptions.manifests);
      const args = kubectlArgs(["apply", "-f", "-"], {
        context: deployOptions.context,
        kubeconfig: deployOptions.kubeconfig,
        namespace: deployOptions.namespace,
        extra: [...(deployOptions.wait ? ["--wait"] : []), ...(deployOptions.args ?? [])],
      });
      const result = await command(kubectl, args, text);

      return {
        applied,
        namespace: deployOptions.namespace,
        context: deployOptions.context ?? options.context,
        stdout: result.stdout,
      };
    },

    async rollback(rollbackOptions) {
      const name = requireName(rollbackOptions.name);
      const revision = rollbackOptions.revision;
      if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) {
        throw new KubeforgeError(
          `Revision must be a positive integer, received ${revision}`,
          "KUBERNETES_INVALID_ARGUMENT",
        );
      }

      const args = kubectlArgs(["rollout", "undo", `${rollbackOptions.kind.toLowerCase()}/${name}`], {
        context: rollbackOptions.context,
        kubeconfig: rollbackOptions.kubeconfig,
        namespace: rollbackOptions.namespace,
        extra: [
          ...(revision !== undefined ? ["--to-revision", String(revision)] : []),
          ...(rollbackOptions.args ?? []),
        ],
      });
      const result = await command(kubectl, args);

      return {
        kind: rollbackOptions.kind,
        name,
        namespace: rollbackOptions.namespace,
        revision,
        stdout: result.stdout,
      };
    },
  };
}
