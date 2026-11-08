export interface ObjectMeta {
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
}

export interface ResourceRequirements {
  cpu?: string;
  memory?: string;
}

export interface ContainerSpec {
  name: string;
  image: string;
  resources?: {
    requests?: ResourceRequirements;
    limits?: ResourceRequirements;
  };
  securityContext?: {
    privileged?: boolean;
    runAsNonRoot?: boolean;
    readOnlyRootFilesystem?: boolean;
    allowPrivilegeEscalation?: boolean;
    capabilities?: {
      add?: string[];
      drop?: string[];
    };
  };
}

export interface PodSpec {
  containers: ContainerSpec[];
}

export interface VolumeSpec {
  name?: string;
  hostPath?: { path?: string };
}

export interface Workload {
  kind: "Deployment" | "StatefulSet" | "DaemonSet";
  metadata: ObjectMeta;
  spec: {
    replicas?: number;
    hostNetwork?: boolean;
    hostPID?: boolean;
    hostIPC?: boolean;
    volumes?: VolumeSpec[];
    template?: { spec?: PodSpec };
  };
}

export interface NodeResource {
  kind?: "Node";
  metadata: ObjectMeta;
  status?: {
    conditions?: Array<{ type: string; status: "True" | "False" | "Unknown" }>;
    capacity?: ResourceRequirements;
    allocatable?: ResourceRequirements;
  };
}

export interface SecretResource {
  kind?: "Secret";
  metadata: ObjectMeta;
  type?: string;
  data?: Record<string, string>;
  stringData?: Record<string, string>;
}

export type RoleKind = "Role" | "ClusterRole";

export interface RbacPolicyRule {
  apiGroups?: string[];
  resources?: string[];
  verbs?: string[];
  nonResourceURLs?: string[];
  resourceNames?: string[];
}

export interface RbacRoleResource {
  kind: RoleKind;
  metadata: ObjectMeta;
  rules?: RbacPolicyRule[];
}

export interface RbacSubject {
  kind: "User" | "Group" | "ServiceAccount";
  name: string;
  namespace?: string;
}

export interface RbacBindingResource {
  kind: "RoleBinding" | "ClusterRoleBinding";
  metadata: ObjectMeta;
  roleRef: { apiGroup?: string; kind: RoleKind; name: string };
  subjects?: RbacSubject[];
}

export type WorkloadKind = Workload["kind"];
export type KubernetesKind =
  | "Node"
  | "Namespace"
  | WorkloadKind
  | "Pod"
  | "Secret"
  | "Role"
  | "ClusterRole"
  | "RoleBinding"
  | "ClusterRoleBinding";

export interface ListOptions {
  namespace?: string;
  labelSelector?: Record<string, string>;
}

export interface KubernetesClient {
  list(kind: KubernetesKind, options?: ListOptions): Promise<unknown[]>;
  get(kind: KubernetesKind, name: string, options?: { namespace?: string }): Promise<unknown | undefined>;
}

export interface ClusterSeed {
  nodes?: NodeResource[];
  namespaces?: Array<{ metadata: ObjectMeta }>;
  pods?: unknown[];
  workloads?: Workload[];
  secrets?: SecretResource[];
  roles?: RbacRoleResource[];
  clusterRoles?: RbacRoleResource[];
  roleBindings?: RbacBindingResource[];
  clusterRoleBindings?: RbacBindingResource[];
}

function metadataOf(value: unknown): ObjectMeta | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as { metadata?: ObjectMeta }).metadata;
}

function matchesSelector(item: unknown, options: ListOptions): boolean {
  const metadata = metadataOf(item);
  if (!metadata) return false;
  if (options.namespace && metadata.namespace !== options.namespace) return false;
  for (const [key, expected] of Object.entries(options.labelSelector ?? {})) {
    if (metadata.labels?.[key] !== expected) return false;
  }
  return true;
}

export function createInMemoryKubernetesClient(seed: ClusterSeed = {}): KubernetesClient {
  const objects: Record<KubernetesKind, unknown[]> = {
    Node: seed.nodes ?? [],
    Namespace: seed.namespaces ?? [],
    Pod: seed.pods ?? [],
    Secret: seed.secrets ?? [],
    Role: seed.roles ?? [],
    ClusterRole: seed.clusterRoles ?? [],
    RoleBinding: seed.roleBindings ?? [],
    ClusterRoleBinding: seed.clusterRoleBindings ?? [],
    Deployment: [],
    StatefulSet: [],
    DaemonSet: [],
  };

  for (const workload of seed.workloads ?? []) {
    objects[workload.kind].push(workload);
  }

  return {
    async list(kind, options = {}) {
      return objects[kind].filter((item) => matchesSelector(item, options));
    },
    async get(kind, name, options = {}) {
      return objects[kind].find((item) => {
        const metadata = metadataOf(item);
        return metadata?.name === name && (!options.namespace || metadata.namespace === options.namespace);
      });
    },
  };
}

export function isWorkload(value: unknown): value is Workload {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "Deployment" || kind === "StatefulSet" || kind === "DaemonSet";
}

export function isNode(value: unknown): value is NodeResource {
  if (typeof value !== "object" || value === null || !("metadata" in value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === undefined || kind === "Node";
}

export async function listWorkloads(client: KubernetesClient, options?: ListOptions): Promise<Workload[]> {
  const kinds: WorkloadKind[] = ["Deployment", "StatefulSet", "DaemonSet"];
  const results = await Promise.all(kinds.map((kind) => client.list(kind, options)));
  return results.flat().filter(isWorkload);
}

export function podSpecOf(workload: Workload): PodSpec | undefined {
  return workload.spec.template?.spec;
}

export function workloadRef(workload: Workload): string {
  const namespace = workload.metadata.namespace ?? "default";
  return `${workload.kind}/${namespace}/${workload.metadata.name}`;
}

export {
  loadInClusterConfig,
  loadKubeconfig,
  parseKubeconfig,
  resolveKubeconfigPaths,
  type InClusterOptions,
  type KubeconfigLoadOptions,
  type KubernetesConnection,
  type ParseKubeconfigOptions,
} from "./kubeconfig.js";
export {
  createKubernetesClient,
  createKubernetesHttpClient,
  type KubernetesClientOptions,
} from "./http-client.js";
export {
  createExecCredentialProvider,
  type ExecClusterInfo,
  type ExecCredential,
  type ExecCredentialProvider,
  type ExecCredentialSource,
  type ExecPluginConfig,
} from "./exec.js";
export {
  createCommandRunner,
  runCli,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
} from "./cli.js";
export {
  createClusterManager,
  type ClusterHandle,
  type ClusterManager,
  type ClusterManagerOptions,
  type ClusterProviderName,
  type CreateClusterOptions,
  type DeleteClusterOptions,
  type DeployOptions,
  type DeployResult,
  type ListNodesOptions,
  type ManifestDocument,
  type ManifestInput,
  type RollbackOptions,
  type RollbackResult,
  type ScaleNodesOptions,
} from "./clusters.js";
export {
  clusterDriver,
  type ClusterDriver,
  type DriverContext,
} from "./providers.js";
