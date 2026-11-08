import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createClusterAgent } from "@kubeforge/cluster-agent";
import { estimateWorkloadCost, parseCpu, parseMemoryBytes } from "@kubeforge/cost-agent";
import type { Logger } from "@kubeforge/core";
import { parseImageRef } from "@kubeforge/docker";
import { createInMemoryKubernetesClient, type Workload } from "@kubeforge/kubernetes";
import { createKubeforgeTools } from "@kubeforge/mcp-tools";
import { createDemoRuntime, createDispatcher } from "@kubeforge/mcp-servers";
import { scanWorkloads } from "@kubeforge/security";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const workload: Workload = {
  kind: "Deployment",
  metadata: { name: "api", namespace: "payments" },
  spec: {
    replicas: 2,
    template: {
      spec: {
        containers: [
          {
            name: "api",
            image: "registry.example.com/payments/api:latest",
            resources: { requests: { cpu: "500m", memory: "1Gi" } },
            securityContext: { privileged: true },
          },
        ],
      },
    },
  },
};

describe("sdk", () => {
  test("parses image references", () => {
    assert.deepEqual(parseImageRef("nginx"), {
      registry: "docker.io",
      repository: "nginx",
      tag: "latest",
    });
    assert.deepEqual(parseImageRef("ghcr.io/acme/app:1.2.3"), {
      registry: "ghcr.io",
      repository: "acme/app",
      tag: "1.2.3",
    });
    assert.deepEqual(parseImageRef("localhost:5000/app"), {
      registry: "localhost:5000",
      repository: "app",
      tag: "latest",
    });
  });

  test("flags privileged containers and mutable tags", () => {
    const findings = scanWorkloads([workload]);
    assert.ok(findings.some((finding) => finding.id.startsWith("KF-SEC-001")));
    assert.ok(findings.some((finding) => finding.id.startsWith("KF-SEC-004")));
  });

  test("estimates workload cost from resource requests", () => {
    assert.equal(parseCpu("500m"), 0.5);
    assert.equal(parseMemoryBytes("1Gi"), 1024 ** 3);
    assert.equal(
      estimateWorkloadCost(workload, { cpuCoreMonth: 10, memoryGiBMonth: 2 }),
      2 * (0.5 * 10 + 1 * 2),
    );
  });
});

describe("agents", () => {
  test("cluster agent reports nodes that are not ready", async () => {
    const client = createInMemoryKubernetesClient({
      nodes: [{ metadata: { name: "worker-1" }, status: { conditions: [{ type: "Ready", status: "False" }] } }],
    });

    const report = await createClusterAgent({ client }).run({ logger: silentLogger });

    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0]?.severity, "error");
    assert.equal(report.findings[0]?.id, "cluster.node-not-ready:worker-1");
  });
});

describe("mcp", () => {
  const dispatch = createDispatcher(
    createKubeforgeTools(createDemoRuntime(), { logger: silentLogger }),
    { name: "kubeforge", version: "0.1.0" },
  );

  test("initializes and lists the registered tools", async () => {
    const initialized = await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize" });
    assert.equal(initialized?.error, undefined);
    const info = initialized?.result as { serverInfo: { name: string } };
    assert.equal(info.serverInfo.name, "kubeforge");

    const listed = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (listed?.result as { tools: Array<{ name: string }> }).tools;
    assert.equal(tools.length, 6);
    assert.ok(tools.some((tool) => tool.name === "kubeforge_doctor_report"));
  });

  test("runs the doctor report over the demo runtime", async () => {
    const response = await dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "kubeforge_doctor_report" },
    });

    const result = response?.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, false);

    const report = JSON.parse(result.content[0]?.text ?? "{}") as {
      agent: string;
      findings: Array<{ id: string }>;
    };
    assert.equal(report.agent, "doctor-agent");
    assert.ok(report.findings.some((finding) => finding.id.startsWith("KF-SEC-001")));
    assert.ok(report.findings.some((finding) => finding.id.startsWith("gitops.drift")));
  });

  test("rejects unknown tools", async () => {
    const response = await dispatch({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "kubeforge_does_not_exist" },
    });
    assert.equal(response?.error?.code, -32602);
  });
});
