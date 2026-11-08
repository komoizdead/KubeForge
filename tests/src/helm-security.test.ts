import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CommandOptions, CommandResult, CommandRunner } from "@kubeforge/core";
import { createHelmClient, createInMemoryHelmClient } from "@kubeforge/helm";
import {
  createInMemoryKubernetesClient,
  type RbacBindingResource,
  type RbacRoleResource,
  type SecretResource,
  type Workload,
} from "@kubeforge/kubernetes";
import { scanPolicies, scanRBAC, scanSecrets } from "@kubeforge/security";

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

const releaseJson = JSON.stringify({
  name: "web",
  namespace: "apps",
  version: 3,
  info: { status: "deployed", last_deployed: "2026-01-02T03:04:05Z" },
  chart: { metadata: { name: "nginx", version: "15.0.0", appVersion: "1.25.3" } },
});

describe("helm", () => {
  test("installs a chart with values, set flags, and release parsing", async () => {
    const runner = fakeRunner(() => ({ stdout: releaseJson }));
    const helm = createHelmClient({ runner, namespace: "apps" });

    const release = await helm.installChart({
      name: "web",
      chart: "bitnami/nginx",
      version: "15.0.0",
      createNamespace: true,
      values: { replicaCount: 2 },
      set: { "image.tag": "1.25.3", "service.type": "ClusterIP" },
      wait: true,
      timeout: "5m",
      atomic: true,
    });

    assert.deepEqual(release, {
      name: "web",
      namespace: "apps",
      chart: "nginx",
      chartVersion: "15.0.0",
      appVersion: "1.25.3",
      status: "deployed",
      updatedAt: "2026-01-02T03:04:05Z",
    });

    const call = runner.calls[0];
    assert.equal(call?.command, "helm");
    assert.deepEqual(call?.args, [
      "install",
      "web",
      "bitnami/nginx",
      "--namespace",
      "apps",
      "--create-namespace",
      "--version",
      "15.0.0",
      "--values",
      "-",
      "--set-json",
      'image.tag="1.25.3"',
      "--set-json",
      'service.type="ClusterIP"',
      "--wait",
      "--timeout",
      "5m",
      "--atomic",
      "--output",
      "json",
    ]);
    assert.match(call?.options.stdin ?? "", /replicaCount: 2/);
  });

  test("upgrades a chart with global kube flags", async () => {
    const runner = fakeRunner(() => ({ stdout: releaseJson }));
    const helm = createHelmClient({
      runner,
      namespace: "apps",
      kubeconfig: "C:/kube/config",
      context: "prod",
    });

    await helm.upgradeChart({
      name: "web",
      chart: "nginx",
      installIfMissing: true,
      createNamespace: true,
      version: "15.1.0",
      valuesFile: "values.yaml",
    });

    assert.deepEqual(runner.calls[0]?.args, [
      "upgrade",
      "web",
      "nginx",
      "--install",
      "--namespace",
      "apps",
      "--create-namespace",
      "--version",
      "15.1.0",
      "--values",
      "values.yaml",
      "--output",
      "json",
      "--kubeconfig",
      "C:/kube/config",
      "--kube-context",
      "prod",
    ]);

    await assert.rejects(
      helm.upgradeChart({ name: "web", chart: "nginx", createNamespace: true }),
      codeOf("HELM_INVALID_ARGUMENT"),
    );
  });

  test("uninstalls a release", async () => {
    const runner = fakeRunner();
    const helm = createHelmClient({ runner, namespace: "apps" });

    await helm.removeChart({
      name: "web",
      keepHistory: true,
      wait: true,
      timeout: "2m",
      args: ["--no-hooks"],
    });

    assert.deepEqual(runner.calls[0]?.args, [
      "uninstall",
      "web",
      "--namespace",
      "apps",
      "--keep-history",
      "--wait",
      "--timeout",
      "2m",
      "--no-hooks",
    ]);
  });

  test("lists releases across namespaces and filters by status", async () => {
    const runner = fakeRunner(() => ({
      stdout: JSON.stringify([
        {
          name: "web",
          namespace: "apps",
          status: "deployed",
          chart: "nginx-15.0.0",
          app_version: "1.25.3",
          updated: "2026-01-02T03:04:05Z",
        },
        { name: "db", namespace: "data", status: "failed", chart: "postgres-12.1.0" },
      ]),
    }));
    const helm = createHelmClient({ runner });

    const releases = await helm.listReleases({ status: "deployed" });

    assert.deepEqual(runner.calls[0]?.args, [
      "list",
      "--all",
      "--output",
      "json",
      "--all-namespaces",
    ]);
    assert.equal(releases.length, 1);
    assert.equal(releases[0]?.name, "web");
    assert.equal(releases[0]?.chart, "nginx");
    assert.equal(releases[0]?.chartVersion, "15.0.0");
    assert.equal(releases[0]?.appVersion, "1.25.3");
  });

  test("returns undefined for a missing release and surfaces other failures", async () => {
    const missing = fakeRunner(() => ({ exitCode: 1, stderr: "Error: release: not found" }));
    const helm = createHelmClient({ runner: missing });
    assert.equal(await helm.getRelease("web", "apps"), undefined);

    const failing = fakeRunner(() => ({ exitCode: 2, stderr: "cluster unreachable" }));
    const broken = createHelmClient({ runner: failing });
    await assert.rejects(broken.getRelease("web", "apps"), codeOf("HELM_CLI_FAILED"));
  });

  test("parses releases from helm status", async () => {
    const runner = fakeRunner(() => ({ stdout: releaseJson }));
    const helm = createHelmClient({ runner });

    const release = await helm.getRelease("web", "apps");
    assert.deepEqual(runner.calls[0]?.args, [
      "status",
      "web",
      "--namespace",
      "apps",
      "--output",
      "json",
    ]);
    assert.equal(release?.chartVersion, "15.0.0");
    assert.equal(release?.status, "deployed");
  });

  test("manages releases in memory", async () => {
    const helm = createInMemoryHelmClient();

    const installed = await helm.installChart({
      name: "web",
      chart: "bitnami/nginx",
      version: "15.0.0",
      namespace: "apps",
    });
    assert.equal(installed.chart, "nginx");
    assert.equal(installed.status, "deployed");

    await assert.rejects(
      helm.installChart({ name: "web", chart: "nginx", namespace: "apps" }),
      codeOf("HELM_RELEASE_EXISTS"),
    );
    await assert.rejects(
      helm.upgradeChart({ name: "missing", chart: "nginx", namespace: "apps" }),
      codeOf("HELM_RELEASE_NOT_FOUND"),
    );

    const upgraded = await helm.upgradeChart({
      name: "web",
      chart: "nginx",
      namespace: "apps",
      version: "15.1.0",
    });
    assert.equal(upgraded.chartVersion, "15.1.0");

    const created = await helm.upgradeChart({ name: "api", chart: "api", installIfMissing: true });
    assert.equal(created.namespace, "default");

    await helm.removeChart({ name: "web", namespace: "apps" });
    assert.equal(await helm.getRelease("web", "apps"), undefined);
  });
});

describe("rbac scan", () => {
  const wildcard: RbacRoleResource = {
    kind: "ClusterRole",
    metadata: { name: "wildcard" },
    rules: [{ apiGroups: ["*"], resources: ["*"], verbs: ["*"] }],
  };
  const secretReader: RbacRoleResource = {
    kind: "Role",
    metadata: { name: "reader", namespace: "apps" },
    rules: [{ apiGroups: [""], resources: ["secrets"], verbs: ["get", "list"] }],
  };
  const escalator: RbacRoleResource = {
    kind: "ClusterRole",
    metadata: { name: "escalator" },
    rules: [{ apiGroups: ["rbac.authorization.k8s.io"], resources: ["clusterroles"], verbs: ["escalate"] }],
  };
  const podCreator: RbacRoleResource = {
    kind: "Role",
    metadata: { name: "pods", namespace: "apps" },
    rules: [{ apiGroups: [""], resources: ["pods", "pods/exec"], verbs: ["create"] }],
  };

  test("flags wildcard, Secret, escalation, and Pod permissions", () => {
    const findings = scanRBAC({
      clusterRoles: [wildcard, escalator],
      roles: [secretReader, podCreator],
    });

    const ids = findings.map((finding) => finding.id);
    assert.ok(ids.includes("KF-RBAC-001:ClusterRole/wildcard"));
    assert.ok(ids.includes("KF-RBAC-002:Role/apps/reader"));
    assert.ok(ids.includes("KF-RBAC-003:ClusterRole/escalator"));
    assert.ok(ids.includes("KF-RBAC-004:Role/apps/pods"));
  });

  test("flags cluster-admin, anonymous, and subjectless bindings", () => {
    const clusterAdmin: RbacBindingResource = {
      kind: "ClusterRoleBinding",
      metadata: { name: "admin-binding" },
      roleRef: { kind: "ClusterRole", name: "cluster-admin" },
      subjects: [{ kind: "ServiceAccount", name: "deployer", namespace: "apps" }],
    };
    const anonymous: RbacBindingResource = {
      kind: "RoleBinding",
      metadata: { name: "anonymous", namespace: "apps" },
      roleRef: { kind: "Role", name: "reader" },
      subjects: [{ kind: "Group", name: "system:unauthenticated" }],
    };
    const empty: RbacBindingResource = {
      kind: "RoleBinding",
      metadata: { name: "empty", namespace: "apps" },
      roleRef: { kind: "Role", name: "reader" },
    };

    const findings = scanRBAC({
      clusterRoleBindings: [clusterAdmin],
      roleBindings: [anonymous, empty],
    });

    const ids = findings.map((finding) => finding.id);
    assert.ok(ids.includes("KF-RBAC-005:ClusterRoleBinding/admin-binding"));
    assert.ok(ids.includes("KF-RBAC-006:RoleBinding/apps/anonymous"));
    assert.ok(ids.includes("KF-RBAC-007:RoleBinding/apps/empty"));
  });
});

describe("secret scan", () => {
  test("flags weak, short, and non-TLS key material without leaking values", () => {
    const secrets: SecretResource[] = [
      {
        metadata: { name: "api", namespace: "apps" },
        data: {
          password: Buffer.from("letmein").toString("base64"),
          apiKey: Buffer.from("short").toString("base64"),
        },
      },
      {
        metadata: { name: "tls", namespace: "apps" },
        type: "Opaque",
        stringData: { "tls.key": "not-a-real-key" },
      },
    ];

    const findings = scanSecrets(secrets);
    const ids = findings.map((finding) => finding.id);

    assert.ok(ids.includes("KF-SECRET-001:Secret/apps/api"));
    assert.ok(ids.includes("KF-SECRET-002:Secret/apps/api"));
    assert.ok(ids.includes("KF-SECRET-003:Secret/apps/tls"));
    assert.match(
      findings.find((finding) => finding.id.startsWith("KF-SECRET-001"))?.detail ?? "",
      /password/,
    );
    assert.doesNotMatch(JSON.stringify(findings), /letmein|not-a-real-key/);
  });

  test("accepts TLS secrets and strong values", () => {
    const findings = scanSecrets([
      {
        metadata: { name: "tls", namespace: "apps" },
        type: "kubernetes.io/tls",
        data: {
          "tls.crt": Buffer.from("certificate-data").toString("base64"),
          "tls.key": Buffer.from("private-key-material").toString("base64"),
        },
      },
    ]);

    assert.deepEqual(findings, []);
  });
});

describe("policy scan", () => {
  const workload: Workload = {
    kind: "Deployment",
    metadata: { name: "api", namespace: "apps" },
    spec: {
      hostNetwork: true,
      volumes: [{ name: "docker", hostPath: { path: "/var/run/docker.sock" } }],
      template: {
        spec: {
          containers: [
            {
              name: "api",
              image: "registry.example.com/api:1.2.3",
              securityContext: { capabilities: { add: ["SYS_ADMIN", "NET_BIND_SERVICE"] } },
              resources: { requests: { cpu: "100m" } },
            },
          ],
        },
      },
    },
  };

  test("flags host access, capabilities, and missing guardrails", () => {
    const findings = scanPolicies([workload]);
    const ids = findings.map((finding) => finding.id);

    assert.ok(ids.includes("KF-POLICY-001:Deployment/apps/api"));
    assert.ok(ids.includes("KF-POLICY-002:Deployment/apps/api"));
    assert.ok(ids.includes("KF-POLICY-003:Deployment/apps/api"));
    assert.ok(ids.includes("KF-POLICY-004:Deployment/apps/api"));
    assert.ok(ids.includes("KF-POLICY-005:Deployment/apps/api"));

    const capabilityFinding = findings.find((finding) => finding.id.startsWith("KF-POLICY-003"));
    assert.match(capabilityFinding?.detail ?? "", /SYS_ADMIN/);
    assert.doesNotMatch(capabilityFinding?.detail ?? "", /NET_BIND_SERVICE/);
  });

  test("accepts a compliant workload", () => {
    const compliant: Workload = {
      kind: "Deployment",
      metadata: { name: "api", namespace: "apps" },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: "api",
                image: "registry.example.com/api:1.2.3",
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ["ALL"] },
                },
                resources: {
                  requests: { cpu: "100m", memory: "128Mi" },
                  limits: { cpu: "500m", memory: "512Mi" },
                },
              },
            ],
          },
        },
      },
    };

    assert.deepEqual(scanPolicies([compliant]), []);
  });
});

describe("resource listing", () => {
  test("lists secrets and RBAC resources from the in-memory client", async () => {
    const client = createInMemoryKubernetesClient({
      secrets: [{ metadata: { name: "db", namespace: "apps" } }],
      roles: [{ kind: "Role", metadata: { name: "reader", namespace: "apps" } }],
      clusterRoles: [{ kind: "ClusterRole", metadata: { name: "admin" } }],
      roleBindings: [
        {
          kind: "RoleBinding",
          metadata: { name: "reader", namespace: "apps" },
          roleRef: { kind: "Role", name: "reader" },
        },
      ],
      clusterRoleBindings: [
        { kind: "ClusterRoleBinding", metadata: { name: "admin" }, roleRef: { kind: "ClusterRole", name: "admin" } },
      ],
    });

    assert.equal((await client.list("Secret", { namespace: "apps" })).length, 1);
    assert.equal((await client.list("Role", { namespace: "apps" })).length, 1);
    assert.equal((await client.list("ClusterRole")).length, 1);
    assert.equal((await client.list("RoleBinding", { namespace: "apps" })).length, 1);
    assert.equal((await client.list("ClusterRoleBinding")).length, 1);
  });
});
