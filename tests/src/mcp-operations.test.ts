import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Logger } from "@kubeforge/core";
import {
  createInMemoryKubernetesClient,
  type ClusterManager,
  type CreateClusterOptions,
  type DeleteClusterOptions,
  type DeployOptions,
  type RollbackOptions,
} from "@kubeforge/kubernetes";
import { createKubeforgeTools, type KubeforgeTool, type ToolRuntime } from "@kubeforge/mcp-tools";
import { createDemoRuntime, createDispatcher } from "@kubeforge/mcp-servers";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface Recorded {
  created: CreateClusterOptions[];
  deleted: DeleteClusterOptions[];
  deployed: DeployOptions[];
  rolledBack: RollbackOptions[];
}

function createFakeClusterManager(recorded: Recorded): ClusterManager {
  return {
    createCluster: async (options) => {
      recorded.created.push(options);
      return { provider: options.provider ?? "k3s", name: options.name, context: options.context };
    },
    deleteCluster: async (options) => {
      recorded.deleted.push(options);
    },
    scaleNodes: async () => undefined,
    listNodes: async () => [],
    deploy: async (options) => {
      recorded.deployed.push(options);
      return { applied: 1, namespace: options.namespace, stdout: "" };
    },
    rollback: async (options) => {
      recorded.rolledBack.push(options);
      return {
        kind: options.kind,
        name: options.name,
        namespace: options.namespace,
        revision: options.revision,
        stdout: "",
      };
    },
  };
}

function runtimeWithClusters(recorded: Recorded): ToolRuntime {
  return {
    ...createDemoRuntime(),
    clusters: createFakeClusterManager(recorded),
    logger: silentLogger,
  };
}

function toolNamed(tools: KubeforgeTool[], name: string): KubeforgeTool {
  const tool = tools.find((candidate) => candidate.definition.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

describe("mcp operations", () => {
  test("create_cluster forwards options and returns the cluster handle", async () => {
    const recorded: Recorded = { created: [], deleted: [], deployed: [], rolledBack: [] };
    const tools = createKubeforgeTools(runtimeWithClusters(recorded), { logger: silentLogger });

    const result = await toolNamed(tools, "create_cluster").execute({
      name: "dev",
      provider: "k3s",
      nodes: 2,
      context: "k3d-dev",
    });

    assert.deepEqual(result, { provider: "k3s", name: "dev", context: "k3d-dev" });
    assert.equal(recorded.created.length, 1);
    assert.equal(recorded.created[0]?.nodes, 2);
  });

  test("create_cluster rejects input without a name", async () => {
    const recorded: Recorded = { created: [], deleted: [], deployed: [], rolledBack: [] };
    const tools = createKubeforgeTools(runtimeWithClusters(recorded), { logger: silentLogger });

    await assert.rejects(
      () => toolNamed(tools, "create_cluster").execute({ nodes: 1 }),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === "MCP_INVALID_ARGUMENT",
    );
    assert.equal(recorded.created.length, 0);
  });

  test("delete_cluster removes the requested cluster", async () => {
    const recorded: Recorded = { created: [], deleted: [], deployed: [], rolledBack: [] };
    const tools = createKubeforgeTools(runtimeWithClusters(recorded), { logger: silentLogger });

    const result = await toolNamed(tools, "delete_cluster").execute({
      name: "dev",
      provider: "eks",
      region: "us-east-1",
    });

    assert.deepEqual(result, { deleted: true, name: "dev", provider: "eks" });
    assert.equal(recorded.deleted.length, 1);
    assert.equal(recorded.deleted[0]?.region, "us-east-1");
  });

  test("deploy_app forwards manifests, namespace, and wait", async () => {
    const recorded: Recorded = { created: [], deleted: [], deployed: [], rolledBack: [] };
    const tools = createKubeforgeTools(runtimeWithClusters(recorded), { logger: silentLogger });

    const manifests = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: demo\n";
    const result = await toolNamed(tools, "deploy_app").execute({
      manifests,
      namespace: "storefront",
      wait: true,
    });

    assert.deepEqual(result, { applied: 1, namespace: "storefront", stdout: "" });
    assert.equal(recorded.deployed.length, 1);
    assert.equal(recorded.deployed[0]?.manifests, manifests);
    assert.equal(recorded.deployed[0]?.wait, true);
  });

  test("rollback_app validates the workload kind and forwards the revision", async () => {
    const recorded: Recorded = { created: [], deleted: [], deployed: [], rolledBack: [] };
    const tools = createKubeforgeTools(runtimeWithClusters(recorded), { logger: silentLogger });
    const rollback = toolNamed(tools, "rollback_app");

    await assert.rejects(
      () => rollback.execute({ kind: "Pod", name: "api" }),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === "MCP_INVALID_ARGUMENT",
    );
    assert.equal(recorded.rolledBack.length, 0);

    const result = await rollback.execute({
      kind: "Deployment",
      name: "api",
      namespace: "payments",
      revision: 2,
    });

    assert.deepEqual(result, {
      kind: "Deployment",
      name: "api",
      namespace: "payments",
      revision: 2,
      stdout: "",
    });
    assert.equal(recorded.rolledBack[0]?.revision, 2);
  });

  test("list_nodes filters nodes by label selector", async () => {
    const runtime: ToolRuntime = {
      ...createDemoRuntime(),
      kubernetes: createInMemoryKubernetesClient({
        nodes: [
          { metadata: { name: "worker-1", labels: { role: "worker" } } },
          { metadata: { name: "control-1", labels: { role: "control-plane" } } },
        ],
      }),
      logger: silentLogger,
    };
    const tools = createKubeforgeTools(runtime, { logger: silentLogger });

    const result = (await toolNamed(tools, "list_nodes").execute({
      labelSelector: { role: "worker" },
    })) as { count: number; nodes: Array<{ metadata: { name: string } }> };

    assert.equal(result.count, 1);
    assert.equal(result.nodes[0]?.metadata.name, "worker-1");
  });

  test("scan_security reports workload findings and honors the checks filter", async () => {
    const tools = createKubeforgeTools(createDemoRuntime(), { logger: silentLogger });
    const scan = toolNamed(tools, "scan_security");

    const all = (await scan.execute({})) as {
      checks: string[];
      summary: { total: number };
      findings: Array<{ id: string }>;
    };
    assert.deepEqual(all.checks, ["workloads", "rbac", "secrets", "policies"]);
    assert.ok(all.findings.some((finding) => finding.id.startsWith("KF-SEC-001")));
    assert.equal(all.summary.total, all.findings.length);

    const secretsOnly = (await scan.execute({ checks: ["secrets"] })) as {
      checks: string[];
      findings: unknown[];
    };
    assert.deepEqual(secretsOnly.checks, ["secrets"]);
    assert.equal(secretsOnly.findings.length, 0);
  });

  test("cluster_status summarizes node readiness", async () => {
    const tools = createKubeforgeTools(createDemoRuntime(), { logger: silentLogger });

    const result = (await toolNamed(tools, "cluster_status").execute({})) as {
      summary: {
        totalNodes: number;
        readyNodes: number;
        notReadyNodes: string[];
        workloads: number;
      };
      findings: Array<{ id: string }>;
    };

    assert.equal(result.summary.totalNodes, 2);
    assert.equal(result.summary.readyNodes, 1);
    assert.deepEqual(result.summary.notReadyNodes, ["worker-2"]);
    assert.equal(result.summary.workloads, 2);
    assert.ok(result.findings.some((finding) => finding.id === "cluster.node-not-ready:worker-2"));
  });

  test("cost_report applies custom rates and budget", async () => {
    const tools = createKubeforgeTools(createDemoRuntime(), { logger: silentLogger });

    const result = (await toolNamed(tools, "cost_report").execute({
      rates: { cpuCoreMonth: 10, memoryGiBMonth: 2 },
      namespaceBudget: 1,
    })) as {
      agent: string;
      rates: { cpuCoreMonth: number; memoryGiBMonth: number };
      namespaceBudget: number | null;
      findings: Array<{ id: string; severity: string }>;
    };

    assert.equal(result.agent, "cost-agent");
    assert.deepEqual(result.rates, { cpuCoreMonth: 10, memoryGiBMonth: 2 });
    assert.equal(result.namespaceBudget, 1);
    assert.ok(result.findings.some((finding) => finding.id === "cost.namespace:storefront"));
    assert.ok(result.findings.filter((finding) => finding.id.startsWith("cost.namespace")).every(
      (finding) => finding.severity === "warning",
    ));
  });

  test("dispatcher passes tool arguments through", async () => {
    const recorded: Recorded = { created: [], deleted: [], deployed: [], rolledBack: [] };
    const dispatch = createDispatcher(
      createKubeforgeTools(runtimeWithClusters(recorded), { logger: silentLogger }),
      { name: "kubeforge", version: "0.1.0" },
    );

    const response = await dispatch({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "create_cluster", arguments: { name: "edge", provider: "minikube" } },
    });

    const result = response?.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, false);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as { name: string; provider: string };
    assert.equal(payload.name, "edge");
    assert.equal(payload.provider, "minikube");
    assert.equal(recorded.created[0]?.name, "edge");
  });
});
