import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createClusterManager,
  createCommandRunner,
  createInMemoryKubernetesClient,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
  type ClusterProviderName,
} from "@kubeforge/kubernetes";

interface Call {
  command: string;
  args: string[];
  options: CommandOptions;
}

type Override = Partial<Pick<CommandResult, "stdout" | "stderr" | "exitCode">>;

function fakeRunner(handler?: (call: Call) => Override | undefined): CommandRunner & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(command, args, options = {}) {
      const call = { command, args, options };
      calls.push(call);
      const override = handler?.(call);
      return {
        command,
        args,
        exitCode: override?.exitCode ?? 0,
        stdout: override?.stdout ?? "",
        stderr: override?.stderr ?? "",
      };
    },
  };
}

function codeOf(expected: string) {
  return (error: unknown): boolean => {
    assert.equal((error as { code?: string }).code, expected);
    return true;
  };
}

describe("cluster providers", () => {
  test("creates, scales, and deletes an AKS cluster", async () => {
    const runner = fakeRunner();
    const manager = createClusterManager({
      provider: "aks",
      runner,
      resourceGroup: "rg-prod",
      region: "westeurope",
      nodeGroup: "system",
    });

    const handle = await manager.createCluster({ name: "prod", nodes: 3 });
    assert.deepEqual(handle, { provider: "aks", name: "prod", context: "prod" });
    assert.deepEqual(runner.calls[0]?.args, [
      "aks",
      "create",
      "--name",
      "prod",
      "--resource-group",
      "rg-prod",
      "--node-count",
      "3",
      "--generate-ssh-keys",
      "--location",
      "westeurope",
    ]);
    assert.deepEqual(runner.calls[1]?.args, [
      "aks",
      "get-credentials",
      "--name",
      "prod",
      "--resource-group",
      "rg-prod",
      "--overwrite-existing",
    ]);

    await manager.scaleNodes({ name: "prod", nodes: 5 });
    assert.deepEqual(runner.calls[2]?.args, [
      "aks",
      "nodepool",
      "scale",
      "--cluster-name",
      "prod",
      "--resource-group",
      "rg-prod",
      "--name",
      "system",
      "--node-count",
      "5",
    ]);

    await manager.deleteCluster({ name: "prod" });
    assert.deepEqual(runner.calls[3]?.args, [
      "aks",
      "delete",
      "--name",
      "prod",
      "--resource-group",
      "rg-prod",
      "--yes",
    ]);
  });

  test("requires a resource group for AKS", async () => {
    const manager = createClusterManager({ provider: "aks", runner: fakeRunner() });
    await assert.rejects(
      manager.createCluster({ name: "prod" }),
      codeOf("KUBERNETES_RESOURCE_GROUP_REQUIRED"),
    );
  });

  test("creates an EKS cluster and scales its node group", async () => {
    const runner = fakeRunner();
    const manager = createClusterManager({ provider: "eks", runner, region: "us-west-2" });

    await manager.createCluster({
      name: "eks-prod",
      nodes: 2,
      nodeSize: "m5.large",
      kubernetesVersion: "1.30",
    });
    assert.deepEqual(runner.calls[0]?.args, [
      "create",
      "cluster",
      "--name",
      "eks-prod",
      "--region",
      "us-west-2",
      "--nodes",
      "2",
      "--node-type",
      "m5.large",
      "--version",
      "1.30",
    ]);

    await assert.rejects(
      manager.scaleNodes({ name: "eks-prod", nodes: 4 }),
      codeOf("KUBERNETES_NODEGROUP_REQUIRED"),
    );

    await manager.scaleNodes({ name: "eks-prod", nodes: 4, nodeGroup: "workers" });
    assert.deepEqual(runner.calls[1]?.args, [
      "scale",
      "nodegroup",
      "--cluster",
      "eks-prod",
      "--name",
      "workers",
      "--nodes",
      "4",
      "--region",
      "us-west-2",
    ]);
  });

  test("maps GKE regions and zones and derives the context", async () => {
    const runner = fakeRunner();
    const manager = createClusterManager({
      provider: "gke",
      runner,
      region: "europe-west1",
      project: "my-project",
    });

    const handle = await manager.createCluster({ name: "gke-prod" });
    assert.equal(handle.context, "gke_my-project_europe-west1_gke-prod");
    assert.deepEqual(runner.calls[0]?.args, [
      "container",
      "clusters",
      "create",
      "gke-prod",
      "--num-nodes",
      "3",
      "--region",
      "europe-west1",
      "--project",
      "my-project",
      "--quiet",
    ]);
    assert.deepEqual(runner.calls[1]?.args, [
      "container",
      "clusters",
      "get-credentials",
      "gke-prod",
      "--region",
      "europe-west1",
      "--project",
      "my-project",
      "--quiet",
    ]);

    await manager.scaleNodes({ name: "gke-prod", nodes: 2, region: "us-central1-a" });
    assert.deepEqual(runner.calls[2]?.args, [
      "container",
      "clusters",
      "resize",
      "gke-prod",
      "--num-nodes",
      "2",
      "--zone",
      "us-central1-a",
      "--project",
      "my-project",
      "--quiet",
    ]);
  });

  test("creates a k3d cluster and scales agents", async () => {
    const created = fakeRunner();
    const manager = createClusterManager({ provider: "k3s", runner: created });

    const handle = await manager.createCluster({ name: "dev", nodes: 3 });
    assert.deepEqual(handle, { provider: "k3s", name: "dev", context: "k3d-dev" });
    assert.deepEqual(created.calls[0]?.args, ["cluster", "create", "dev", "--agents", "2"]);

    const nodes = [
      { name: "dev-server-0", role: "server", cluster: "dev" },
      { name: "dev-agent-0", role: "agent", cluster: "dev" },
      { name: "dev-agent-1", role: "agent", cluster: "dev" },
      { name: "other-agent-0", role: "agent", cluster: "other" },
    ];
    const scaled = fakeRunner((call) =>
      call.command === "k3d" && call.args[0] === "node" && call.args[1] === "list"
        ? { stdout: JSON.stringify(nodes) }
        : undefined,
    );
    const scaling = createClusterManager({ provider: "k3s", runner: scaled });

    await scaling.scaleNodes({ name: "dev", nodes: 4 });
    assert.deepEqual(scaled.calls[1]?.args, [
      "node",
      "create",
      "dev-agent-2",
      "--cluster",
      "dev",
      "--role",
      "agent",
    ]);

    const shrinking = fakeRunner((call) =>
      call.command === "k3d" && call.args[0] === "node" && call.args[1] === "list"
        ? { stdout: JSON.stringify(nodes.slice(0, 3)) }
        : undefined,
    );
    const shrinkManager = createClusterManager({ provider: "k3s", runner: shrinking });

    await shrinkManager.scaleNodes({ name: "dev", nodes: 2 });
    assert.deepEqual(shrinking.calls[1]?.args, ["node", "delete", "dev-agent-1"]);
  });

  test("creates and scales a minikube profile", async () => {
    const runner = fakeRunner((call) =>
      call.command === "minikube" && call.args.includes("node") && call.args.includes("list")
        ? { stdout: "m\n" }
        : undefined,
    );
    const manager = createClusterManager({ provider: "minikube", runner });

    const handle = await manager.createCluster({ name: "m", nodes: 2, driver: "docker" });
    assert.deepEqual(handle, { provider: "minikube", name: "m", context: "m" });
    assert.deepEqual(runner.calls[0]?.args, [
      "start",
      "--profile",
      "m",
      "--nodes",
      "2",
      "--driver",
      "docker",
    ]);

    await manager.scaleNodes({ name: "m", nodes: 3 });
    assert.deepEqual(runner.calls[2]?.args, ["--profile", "m", "node", "add"]);
    assert.deepEqual(runner.calls[3]?.args, ["--profile", "m", "node", "add"]);

    const shrinker = fakeRunner((call) =>
      call.command === "minikube" && call.args.includes("list")
        ? { stdout: "m\nm-m02\nm-m03\n" }
        : undefined,
    );
    const shrinkManager = createClusterManager({ provider: "minikube", runner: shrinker });

    await shrinkManager.scaleNodes({ name: "m", nodes: 2 });
    assert.deepEqual(shrinker.calls[1]?.args, ["--profile", "m", "node", "delete", "m-m03"]);
  });

  test("reports Docker Desktop lifecycle as unsupported", async () => {
    const manager = createClusterManager({ provider: "docker-desktop", runner: fakeRunner() });

    await assert.rejects(
      manager.createCluster({ name: "desktop" }),
      codeOf("KUBERNETES_PROVIDER_UNSUPPORTED"),
    );
    await assert.rejects(
      manager.scaleNodes({ name: "desktop", nodes: 2 }),
      codeOf("KUBERNETES_PROVIDER_UNSUPPORTED"),
    );
  });

  test("rejects unknown providers and invalid node counts", async () => {
    const unknown = createClusterManager({
      provider: "nomad" as ClusterProviderName,
      runner: fakeRunner(),
    });
    await assert.rejects(unknown.createCluster({ name: "x" }), codeOf("KUBERNETES_PROVIDER_UNKNOWN"));

    const manager = createClusterManager({ provider: "eks", runner: fakeRunner(), region: "us-east-1" });
    await assert.rejects(
      manager.createCluster({ name: "x", nodes: 0 }),
      codeOf("KUBERNETES_INVALID_ARGUMENT"),
    );
    await assert.rejects(manager.createCluster({ name: "  " }), codeOf("KUBERNETES_INVALID_ARGUMENT"));
  });

  test("surfaces provider CLI failures", async () => {
    const runner = fakeRunner(() => ({ exitCode: 3, stderr: "cluster not found" }));
    const manager = createClusterManager({ provider: "eks", runner, region: "us-east-1" });

    await assert.rejects(manager.deleteCluster({ name: "missing" }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "KUBERNETES_CLI_FAILED");
      assert.match((error as Error).message, /cluster not found/);
      return true;
    });
  });
});

describe("cluster operations", () => {
  test("lists nodes through an injected client with a label selector", async () => {
    const client = createInMemoryKubernetesClient({
      nodes: [
        { metadata: { name: "worker-1", labels: { role: "worker" } } },
        { metadata: { name: "control-1", labels: { role: "control-plane" } } },
      ],
    });
    const manager = createClusterManager({ client, runner: fakeRunner() });

    const nodes = await manager.listNodes({ labelSelector: { role: "worker" } });
    assert.deepEqual(
      nodes.map((node) => node.metadata.name),
      ["worker-1"],
    );
  });

  test("deploys manifests through kubectl using stdin", async () => {
    const runner = fakeRunner();
    const manager = createClusterManager({ runner, context: "prod", kubectl: "oc" });

    const result = await manager.deploy({
      manifests: [
        "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: apps\n---\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: jobs\n",
        { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "settings", namespace: "apps" }, data: { a: "b" } },
      ],
      namespace: "apps",
      wait: true,
      args: ["--server-side"],
    });

    assert.equal(result.applied, 3);
    const call = runner.calls[0];
    assert.equal(call?.command, "oc");
    assert.deepEqual(call?.args, [
      "apply",
      "-f",
      "-",
      "--context",
      "prod",
      "--namespace",
      "apps",
      "--wait",
      "--server-side",
    ]);
    const stdin = call?.options.stdin ?? "";
    assert.match(stdin, /name: apps\n---\napiVersion: v1/);
    assert.match(stdin, /kind: ConfigMap/);
  });

  test("rejects empty manifests", async () => {
    const manager = createClusterManager({ runner: fakeRunner() });
    await assert.rejects(manager.deploy({ manifests: [] }), codeOf("KUBERNETES_INVALID_ARGUMENT"));
    await assert.rejects(manager.deploy({ manifests: "---\n" }), codeOf("KUBERNETES_INVALID_ARGUMENT"));
  });

  test("rolls back a workload to a revision", async () => {
    const runner = fakeRunner();
    const manager = createClusterManager({ runner, kubeconfig: "C:/kube/config" });

    const result = await manager.rollback({
      kind: "Deployment",
      name: "api",
      namespace: "payments",
      revision: 2,
      context: "prod",
    });

    assert.equal(result.kind, "Deployment");
    assert.equal(result.revision, 2);
    assert.deepEqual(runner.calls[0]?.args, [
      "rollout",
      "undo",
      "deployment/api",
      "--context",
      "prod",
      "--kubeconfig",
      "C:/kube/config",
      "--namespace",
      "payments",
      "--to-revision",
      "2",
    ]);

    await assert.rejects(
      manager.rollback({ kind: "Deployment", name: "api", revision: 0 }),
      codeOf("KUBERNETES_INVALID_ARGUMENT"),
    );
  });
});

describe("command runner", () => {
  test("pipes stdin and captures stdout", async () => {
    const runner = createCommandRunner();
    const result = await runner.run(
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout)"],
      { stdin: "hello kube" },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "hello kube");
  });

  test("times out long-running commands", async () => {
    const runner = createCommandRunner();
    await assert.rejects(
      runner.run(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 100 }),
      codeOf("KUBERNETES_CLI_TIMEOUT"),
    );
  });

  test("reports missing executables", async () => {
    const runner = createCommandRunner();
    await assert.rejects(
      runner.run("kubeforge-missing-cli", ["version"]),
      codeOf("KUBERNETES_CLI_NOT_FOUND"),
    );
  });
});
