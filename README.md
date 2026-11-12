# KubeForge

Kubernetes operations toolkit: shared SDK adapters, six diagnostic agents, and a dependency-free
MCP server that exposes the agents as tools.

## Layout

| Path | Purpose |
| --- | --- |
| `sdk/core` | Findings, agent contract, logger, result types |
| `sdk/kubernetes` | Kubernetes types, in-memory client, and real HTTP adapter |
| `sdk/helm` | Helm release types, in-memory client, and Helm CLI adapter |
| `sdk/docker` | Image reference parsing and container client interface |
| `sdk/monitoring` | Metric sample query interface |
| `sdk/security` | Workload, RBAC, Secret, and policy scanners |
| `agents/cluster-agent` | Node readiness and workload health |
| `agents/security-agent` | Security rule findings for workloads |
| `agents/observability-agent` | Metric coverage and staleness per namespace |
| `agents/gitops-agent` | Helm release drift against desired state |
| `agents/cost-agent` | Monthly cost estimate from resource requests |
| `agents/doctor-agent` | Runs all agents and merges findings |
| `mcp/schemas` | Tool descriptor and JSON Schema types |
| `mcp/tools` | Tool registry wiring agents to a runtime |
| `mcp/servers` | JSON-RPC 2.0 dispatcher and stdio MCP entry point |
| `plugins/`, `extensions/`, `hooks/` | Extension points (see their READMEs) |
| `tests/` | Cross-package smoke tests |
| `docs/` | Architecture notes |

## Requirements

- Node.js >= 22.12
- pnpm >= 10 (`corepack enable` provisions the version pinned in `package.json`)

## Quick start

```bash
pnpm install
pnpm build
pnpm test
```

## Build model

`scripts/build.mjs` discovers packages under `sdk/`, `agents/`, `mcp/`, and `tests/`, topologically
sorts them by their `@kubeforge/*` dependencies, runs `tsc` in each package, and mirrors the built
package into `node_modules/@kubeforge/<name>`. The copy replaces the symlinks a package manager
would create because this checkout lives on an exFAT volume, which has no symlink or junction
support. On NTFS the script can be replaced by a standard pnpm workspace without touching package
code.

## Running the MCP server

```bash
pnpm mcp
```

The server speaks newline-delimited JSON-RPC 2.0 over stdio:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"kubeforge_doctor_report"}}' \
  | pnpm mcp
```

### Tools

| Tool | Input | Purpose |
| --- | --- | --- |
| `create_cluster` | `name`, `provider`, `nodes`, ... | Create a cluster on AKS, EKS, GKE, k3s, Minikube, or Docker Desktop |
| `delete_cluster` | `name`, `provider`, ... | Delete a cluster |
| `deploy_app` | `manifests`, `namespace`, `wait` | Apply manifests with `kubectl apply` |
| `rollback_app` | `kind`, `name`, `revision` | Roll back a Deployment, StatefulSet, or DaemonSet |
| `scan_security` | `checks`, `namespace`, ... | Scan workloads, RBAC, Secrets, and pod policies |
| `list_nodes` | `labelSelector` | List nodes filtered by labels |
| `cluster_status` | `context`, `kubeconfig` | Summarize node readiness and workload health |
| `cost_report` | `rates`, `namespaceBudget` | Estimate monthly cost per namespace |

The six `kubeforge_*` tools wrap the diagnostic agents and take no input. Tool arguments are passed
as the JSON-RPC `params.arguments` object.

## Using a real cluster

```ts
import { createKubernetesClient } from "@kubeforge/kubernetes";
import { createClusterAgent } from "@kubeforge/cluster-agent";
import { createLogger } from "@kubeforge/core";

const client = createKubernetesClient({ context: "prod" });
const report = await createClusterAgent({ client }).run({ logger: createLogger("cluster-agent") });
```

Credentials come from `KUBECONFIG` (default `~/.kube/config`) or the in-cluster service account.
Token, client-certificate, CA data, `tls-server-name`, and `insecure-skip-tls-verify` are supported.
Kubeconfig `exec` credential plugins are supported too, which covers EKS (`aws eks get-token`), GKE
(`gke-gcloud-auth-plugin`), and AKS (`kubelogin`). Tokens and client certificates are refreshed
when they expire, and concurrent requests share a single plugin invocation. Plugins that require
an interactive terminal (`interactiveMode: Always`) are rejected. HTTPS connections are pooled and
honor `proxy-url`; without it, `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` (and lowercase variants)
are used.

## Cluster lifecycle

`createClusterManager()` drives cluster creation, deletion, and scaling through the provider CLIs,
and runs deploys and rollbacks through `kubectl`:

```ts
import { createClusterManager } from "@kubeforge/kubernetes";

const clusters = createClusterManager({ provider: "eks", region: "us-west-2" });

const cluster = await clusters.createCluster({ name: "staging", nodes: 3, nodeSize: "m5.large" });
await clusters.scaleNodes({ name: "staging", nodes: 5, nodeGroup: "workers" });
await clusters.deploy({
  manifests: { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "api", namespace: "apps" } },
  namespace: "apps",
  wait: true,
});
await clusters.rollback({ kind: "Deployment", name: "api", namespace: "apps", revision: 3 });
await clusters.deleteCluster({ name: "staging" });

const nodes = await clusters.listNodes({ context: cluster.context, labelSelector: { role: "worker" } });
```

| Provider | CLI | Notes |
| --- | --- | --- |
| `aks` | `az` | Requires `--resource-group`; scales a node pool when `nodeGroup` is set |
| `eks` | `eksctl` | Requires a region; scaling requires `nodeGroup` |
| `gke` | `gcloud` | Region vs zone is inferred from the location string; project is optional |
| `k3s` | `k3d` | K3S is managed as a k3d cluster; the default context is `k3d-<name>` |
| `minikube` | `minikube` | Uses profiles; scaling adds or removes non-primary nodes |
| `docker-desktop` | — | Lifecycle is managed by Docker Desktop; use the `docker-desktop` context for deploys and rollbacks |

`deploy()` accepts a YAML string, an object, or an array of both, and pipes the serialized documents
to `kubectl apply -f -`. Provider calls run with a 15 minute timeout by default and surface
non-zero exits as `KUBERNETES_CLI_FAILED`; a missing CLI raises `KUBERNETES_CLI_NOT_FOUND`. Every
operation accepts an injectable `runner` and `listNodes()` accepts an injectable `client`, so
workflows can be tested without cloud credentials.

## Helm

`createHelmClient()` drives the Helm CLI, while `createInMemoryHelmClient()` keeps deterministic
tests and demos working:

```ts
import { createHelmClient } from "@kubeforge/helm";

const helm = createHelmClient({ namespace: "apps", context: "staging" });

const release = await helm.installChart({
  name: "web",
  chart: "bitnami/nginx",
  version: "15.0.0",
  createNamespace: true,
  values: { replicaCount: 2 },
});

await helm.upgradeChart({ name: "web", chart: "bitnami/nginx", version: "15.1.0", wait: true });
await helm.removeChart({ name: "web" });
```

Value objects are serialized to YAML and passed on stdin; `set` entries become `--set-json` flags.
`listReleases()` and `getRelease()` use `helm list` and `helm status`, and `--kubeconfig` /
`--kube-context` can be set once on the client. Failures surface as `HELM_CLI_FAILED`,
`HELM_CLI_NOT_FOUND`, or `HELM_INVALID_RESPONSE`.

## Security scans

`@kubeforge/security` exposes four scanners that return `Finding[]`:

| Function | Rules |
| --- | --- |
| `scanWorkloads()` | `KF-SEC-*` container hardening rules |
| `scanRBAC()` | `KF-RBAC-*` wildcard permissions, Secret access, escalation, Pod creation, and binding risks |
| `scanSecrets()` | `KF-SECRET-*` weak or short values and TLS material in non-TLS Secrets |
| `scanPolicies()` | `KF-POLICY-*` host namespaces, hostPath volumes, dangerous capabilities, and missing guardrails |

```ts
import { scanPolicies, scanRBAC, scanSecrets } from "@kubeforge/security";

const findings = [
  ...scanRBAC({ roles, clusterRoles, roleBindings, clusterRoleBindings }),
  ...scanSecrets(secrets),
  ...scanPolicies(workloads),
];
```

The Kubernetes client can list the required resources (`Secret`, `Role`, `ClusterRole`,
`RoleBinding`, `ClusterRoleBinding`) from a real cluster or from
`createInMemoryKubernetesClient()` seeds.

## SDK facade

`@kubeforge/core` exposes `createSdk()` with configuration, authentication, logging, events,
permissions, and plugin loading in one runtime:

```ts
import { createSdk } from "@kubeforge/core";

const sdk = createSdk({
  config: {
    log: { level: "info" },
    permissions: { roles: { viewer: ["cluster.read"] }, granted: ["viewer"] },
  },
});

sdk.auth.register({ name: "static", authenticate: () => ({ subject: "doctor" }) });
sdk.events.on("deploy.requested", (event) => sdk.logger.info("deploy requested", { event }));

await sdk.loadPlugin("./plugins/doctor/index.mjs");
await sdk.connect();
await sdk.authenticate({ provider: "static" });
sdk.emit("deploy.requested", { namespace: "payments" });
```

Configuration defaults are merged with `KUBEFORGE_*` environment variables (`KUBEFORGE_LOG_LEVEL`
maps to `log.level`). Permissions are deny-by-default: grant a role, then call
`permissions.require("cluster.read")`. Plugins execute as trusted code, so only load modules you
control.

## Current state

- The Kubernetes client ships a real HTTP adapter (kubeconfig or in-cluster credentials) and the
  Helm client drives the Helm CLI. Docker and monitoring clients remain in-memory for now. The MCP
  server still boots a demo runtime (`mcp/servers/src/demo.ts`) seeded with a small cluster.
- Tool input schemas are currently empty objects; add per-tool schemas in `mcp/schemas` as filters
  (namespace, label selectors) are introduced.

## Adding to the workspace

- **SDK adapter**: implement the client interface in the matching `sdk/*` package and export a factory.
- **Agent**: build it with `defineAgent` from `@kubeforge/core`, add a package under `agents/`, and
  register it in `mcp/tools/src/index.ts`.
- **Tool**: add an entry to `createKubeforgeTools` with a descriptor from `mcp/schemas`.
