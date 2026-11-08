import { KubeforgeError } from "@kubeforge/core";
import { runCli, type CommandRunner, type CommandOptions } from "./cli.js";
import type {
  ClusterHandle,
  ClusterProviderName,
  ResolvedCreate,
  ResolvedDelete,
  ResolvedScale,
} from "./clusters.js";

export interface DriverContext {
  runner: CommandRunner;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface ClusterDriver {
  readonly name: ClusterProviderName;
  readonly defaultContext?: string;
  create(options: ResolvedCreate, context: DriverContext): Promise<ClusterHandle>;
  remove(options: ResolvedDelete, context: DriverContext): Promise<void>;
  scale(options: ResolvedScale, context: DriverContext): Promise<void>;
}

function command(context: DriverContext, name: string, args: string[], options: CommandOptions = {}) {
  return runCli(context.runner, name, args, {
    timeoutMs: context.timeoutMs,
    env: context.env,
    ...options,
  });
}

function requireSetting(value: string | undefined, label: string, code: string): string {
  if (!value) {
    throw new KubeforgeError(`${label} is required for this provider`, code);
  }
  return value;
}

const aks: ClusterDriver = {
  name: "aks",

  async create(options, context) {
    const resourceGroup = requireSetting(
      options.resourceGroup,
      "A resource group",
      "KUBERNETES_RESOURCE_GROUP_REQUIRED",
    );
    const args = [
      "aks",
      "create",
      "--name",
      options.name,
      "--resource-group",
      resourceGroup,
      "--node-count",
      String(options.nodes),
      "--generate-ssh-keys",
    ];

    if (options.region) args.push("--location", options.region);
    if (options.nodeSize) args.push("--node-vm-size", options.nodeSize);
    if (options.kubernetesVersion) args.push("--kubernetes-version", options.kubernetesVersion);
    args.push(...options.args);

    await command(context, "az", args);

    const credentials = [
      "aks",
      "get-credentials",
      "--name",
      options.name,
      "--resource-group",
      resourceGroup,
      "--overwrite-existing",
    ];
    if (options.context) credentials.push("--context", options.context);
    await command(context, "az", credentials);

    return { provider: "aks", name: options.name, context: options.context ?? options.name };
  },

  async remove(options, context) {
    const resourceGroup = requireSetting(
      options.resourceGroup,
      "A resource group",
      "KUBERNETES_RESOURCE_GROUP_REQUIRED",
    );
    await command(context, "az", [
      "aks",
      "delete",
      "--name",
      options.name,
      "--resource-group",
      resourceGroup,
      "--yes",
      ...options.args,
    ]);
  },

  async scale(options, context) {
    const resourceGroup = requireSetting(
      options.resourceGroup,
      "A resource group",
      "KUBERNETES_RESOURCE_GROUP_REQUIRED",
    );
    const args = options.nodeGroup
      ? [
          "aks",
          "nodepool",
          "scale",
          "--cluster-name",
          options.name,
          "--resource-group",
          resourceGroup,
          "--name",
          options.nodeGroup,
          "--node-count",
          String(options.nodes),
        ]
      : [
          "aks",
          "scale",
          "--name",
          options.name,
          "--resource-group",
          resourceGroup,
          "--node-count",
          String(options.nodes),
        ];
    await command(context, "az", [...args, ...options.args]);
  },
};

const eks: ClusterDriver = {
  name: "eks",

  async create(options, context) {
    const region = requireSetting(options.region, "A region", "KUBERNETES_REGION_REQUIRED");
    const args = ["create", "cluster", "--name", options.name, "--region", region, "--nodes", String(options.nodes)];
    if (options.nodeSize) args.push("--node-type", options.nodeSize);
    if (options.kubernetesVersion) args.push("--version", options.kubernetesVersion);
    if (options.nodeGroup) args.push("--nodegroup-name", options.nodeGroup);
    args.push(...options.args);

    await command(context, "eksctl", args);
    return { provider: "eks", name: options.name, context: options.context };
  },

  async remove(options, context) {
    const region = requireSetting(options.region, "A region", "KUBERNETES_REGION_REQUIRED");
    await command(context, "eksctl", [
      "delete",
      "cluster",
      "--name",
      options.name,
      "--region",
      region,
      ...options.args,
    ]);
  },

  async scale(options, context) {
    const region = requireSetting(options.region, "A region", "KUBERNETES_REGION_REQUIRED");
    const nodeGroup = requireSetting(options.nodeGroup, "A node group", "KUBERNETES_NODEGROUP_REQUIRED");
    await command(context, "eksctl", [
      "scale",
      "nodegroup",
      "--cluster",
      options.name,
      "--name",
      nodeGroup,
      "--nodes",
      String(options.nodes),
      "--region",
      region,
      ...options.args,
    ]);
  },
};

function gkeLocation(region: string): string[] {
  const isZone = /^[a-z]+-[a-z]+\d+-[a-z]$/.test(region);
  return [isZone ? "--zone" : "--region", region];
}

function gkeProject(project: string | undefined): string[] {
  return project ? ["--project", project] : [];
}

const gke: ClusterDriver = {
  name: "gke",

  async create(options, context) {
    const region = requireSetting(options.region, "A region", "KUBERNETES_REGION_REQUIRED");
    const location = gkeLocation(region);
    const project = gkeProject(options.project);

    const args = [
      "container",
      "clusters",
      "create",
      options.name,
      "--num-nodes",
      String(options.nodes),
      ...location,
      ...project,
      "--quiet",
    ];
    if (options.nodeSize) args.push("--machine-type", options.nodeSize);
    if (options.kubernetesVersion) args.push("--cluster-version", options.kubernetesVersion);
    args.push(...options.args);

    await command(context, "gcloud", args);
    await command(context, "gcloud", [
      "container",
      "clusters",
      "get-credentials",
      options.name,
      ...location,
      ...project,
      "--quiet",
    ]);

    return {
      provider: "gke",
      name: options.name,
      context: options.context ?? (options.project ? `gke_${options.project}_${region}_${options.name}` : undefined),
    };
  },

  async remove(options, context) {
    const region = requireSetting(options.region, "A region", "KUBERNETES_REGION_REQUIRED");
    await command(context, "gcloud", [
      "container",
      "clusters",
      "delete",
      options.name,
      ...gkeLocation(region),
      ...gkeProject(options.project),
      "--quiet",
      ...options.args,
    ]);
  },

  async scale(options, context) {
    const region = requireSetting(options.region, "A region", "KUBERNETES_REGION_REQUIRED");
    await command(context, "gcloud", [
      "container",
      "clusters",
      "resize",
      options.name,
      "--num-nodes",
      String(options.nodes),
      ...gkeLocation(region),
      ...gkeProject(options.project),
      "--quiet",
      ...options.args,
    ]);
  },
};

interface K3dNode {
  name?: unknown;
  Name?: unknown;
  role?: unknown;
  Role?: unknown;
  cluster?: unknown;
  Cluster?: unknown;
}

function numericSuffix(name: string): number {
  const match = /(\d+)$/.exec(name);
  return match ? Number(match[1]) : 0;
}

async function k3dAgents(name: string, context: DriverContext): Promise<string[]> {
  const result = await command(context, "k3d", ["node", "list", "-o", "json"]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout || "[]");
  } catch (error) {
    throw new KubeforgeError("k3d returned invalid JSON for node list", "KUBERNETES_PROVIDER_INVALID_RESPONSE", {
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new KubeforgeError("k3d returned an unexpected node list", "KUBERNETES_PROVIDER_INVALID_RESPONSE");
  }

  const agents: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const node = entry as K3dNode;
    const cluster = node.cluster ?? node.Cluster;
    const role = node.role ?? node.Role;
    const nodeName = node.name ?? node.Name;
    if (
      cluster === name &&
      typeof role === "string" &&
      role.toLowerCase() === "agent" &&
      typeof nodeName === "string"
    ) {
      agents.push(nodeName);
    }
  }
  return agents.sort((left, right) => numericSuffix(left) - numericSuffix(right));
}

const k3s: ClusterDriver = {
  name: "k3s",

  async create(options, context) {
    const agents = Math.max(0, options.nodes - 1);
    const args = ["cluster", "create", options.name, "--agents", String(agents)];
    if (options.kubernetesVersion) args.push("--image", `rancher/k3s:${options.kubernetesVersion}`);
    args.push(...options.args);

    await command(context, "k3d", args);
    return { provider: "k3s", name: options.name, context: options.context ?? `k3d-${options.name}` };
  },

  async remove(options, context) {
    await command(context, "k3d", ["cluster", "delete", options.name, ...options.args]);
  },

  async scale(options, context) {
    const desired = Math.max(0, options.nodes - 1);
    const agents = await k3dAgents(options.name, context);
    const delta = desired - agents.length;

    if (delta > 0) {
      let nextIndex = agents.reduce((max, agent) => Math.max(max, numericSuffix(agent)), -1) + 1;
      for (let added = 0; added < delta; added += 1) {
        await command(context, "k3d", [
          "node",
          "create",
          `${options.name}-agent-${nextIndex}`,
          "--cluster",
          options.name,
          "--role",
          "agent",
          ...options.args,
        ]);
        nextIndex += 1;
      }
    } else if (delta < 0) {
      const removable = [...agents].reverse().slice(0, -delta);
      for (const agent of removable) {
        await command(context, "k3d", ["node", "delete", agent, ...options.args]);
      }
    }
  },
};

async function minikubeNodes(name: string, context: DriverContext): Promise<string[]> {
  const result = await command(context, "minikube", ["--profile", name, "node", "list"]);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const minikube: ClusterDriver = {
  name: "minikube",

  async create(options, context) {
    const args = ["start", "--profile", options.name, "--nodes", String(options.nodes)];
    if (options.kubernetesVersion) args.push("--kubernetes-version", options.kubernetesVersion);
    if (options.driver) args.push("--driver", options.driver);
    args.push(...options.args);

    await command(context, "minikube", args);
    return { provider: "minikube", name: options.name, context: options.context ?? options.name };
  },

  async remove(options, context) {
    await command(context, "minikube", ["delete", "--profile", options.name, ...options.args]);
  },

  async scale(options, context) {
    const nodes = await minikubeNodes(options.name, context);
    const delta = options.nodes - nodes.length;

    if (delta > 0) {
      for (let index = 0; index < delta; index += 1) {
        await command(context, "minikube", ["--profile", options.name, "node", "add", ...options.args]);
      }
    } else if (delta < 0) {
      const removable = nodes.filter((node) => node !== options.name).slice(delta);
      if (removable.length < -delta) {
        throw new KubeforgeError(
          "minikube cannot remove the primary node; scale to at least one node",
          "KUBERNETES_INVALID_ARGUMENT",
        );
      }
      for (const node of removable) {
        await command(context, "minikube", ["--profile", options.name, "node", "delete", node, ...options.args]);
      }
    }
  },
};

const DOCKER_DESKTOP_MESSAGE =
  "Docker Desktop Kubernetes is managed by Docker Desktop; enable Kubernetes in its settings and use " +
  'the "docker-desktop" context to list nodes, deploy, or roll back';

const dockerDesktop: ClusterDriver = {
  name: "docker-desktop",
  defaultContext: "docker-desktop",

  async create() {
    throw new KubeforgeError(DOCKER_DESKTOP_MESSAGE, "KUBERNETES_PROVIDER_UNSUPPORTED");
  },

  async remove() {
    throw new KubeforgeError(DOCKER_DESKTOP_MESSAGE, "KUBERNETES_PROVIDER_UNSUPPORTED");
  },

  async scale() {
    throw new KubeforgeError(DOCKER_DESKTOP_MESSAGE, "KUBERNETES_PROVIDER_UNSUPPORTED");
  },
};

const DRIVERS: Record<ClusterProviderName, ClusterDriver> = {
  aks,
  eks,
  gke,
  k3s,
  minikube,
  "docker-desktop": dockerDesktop,
};

export function clusterDriver(name: ClusterProviderName): ClusterDriver {
  const driver = DRIVERS[name];
  if (!driver) {
    throw new KubeforgeError(`Unknown cluster provider "${name}"`, "KUBERNETES_PROVIDER_UNKNOWN");
  }
  return driver;
}
