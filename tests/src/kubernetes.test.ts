import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { describe, test } from "node:test";
import { createKubernetesHttpClient, parseKubeconfig } from "@kubeforge/kubernetes";

const kubeconfig = `
apiVersion: v1
kind: Config
current-context: dev
clusters:
  - name: local
    cluster:
      server: https://cluster.example:6443
      certificate-authority-data: Y2E=
      insecure-skip-tls-verify: true
      tls-server-name: api.internal
contexts:
  - name: dev
    context:
      cluster: local
      user: admin
      namespace: payments
users:
  - name: admin
    user:
      token: super-secret
`;

describe("kubeconfig", () => {
  test("resolves the selected context, auth, and TLS settings", () => {
    const connection = parseKubeconfig(kubeconfig);

    assert.equal(connection.server, "https://cluster.example:6443");
    assert.equal(connection.token, "super-secret");
    assert.equal(connection.namespace, "payments");
    assert.equal(connection.rejectUnauthorized, false);
    assert.equal(connection.tlsServerName, "api.internal");
    assert.equal(connection.ca?.toString(), "ca");
  });

  test("rejects exec plugins that require an interactive terminal", () => {
    const execConfig = kubeconfig.replace(
      "token: super-secret",
      "exec:\n        command: aws\n        interactiveMode: Always",
    );

    assert.throws(() => parseKubeconfig(execConfig), /requires an interactive terminal/);
  });

  test("requires a known context", () => {
    assert.throws(() => parseKubeconfig(kubeconfig, { context: "missing" }), /context "missing" was not found/);
  });
});

describe("http client", () => {
  test("lists and gets resources from a Kubernetes API server", async () => {
    const seen: Array<{ url: string | undefined; authorization: string | undefined }> = [];

    const server = createServer((request, response) => {
      seen.push({ url: request.url, authorization: request.headers.authorization });
      response.setHeader("content-type", "application/json");

      if (request.url?.startsWith("/api/v1/nodes")) {
        response.end(JSON.stringify({ items: [{ metadata: { name: "worker-1" } }] }));
        return;
      }
      if (request.url === "/apis/apps/v1/namespaces/payments/deployments") {
        response.end(JSON.stringify({ items: [{ metadata: { name: "api", namespace: "payments" } }] }));
        return;
      }
      if (request.url === "/api/v1/namespaces/payments/secrets") {
        response.end(JSON.stringify({ items: [{ metadata: { name: "db", namespace: "payments" } }] }));
        return;
      }
      if (request.url === "/apis/rbac.authorization.k8s.io/v1/clusterroles") {
        response.end(JSON.stringify({ items: [{ metadata: { name: "admin" } }] }));
        return;
      }
      if (request.url === "/api/v1/namespaces/payments/pods/missing") {
        response.statusCode = 404;
        response.end(JSON.stringify({ kind: "Status", message: 'pods "missing" not found' }));
        return;
      }

      response.statusCode = 500;
      response.end(JSON.stringify({ message: "unexpected request" }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    try {
      const client = createKubernetesHttpClient({
        server: `http://127.0.0.1:${address.port}`,
        token: "test-token",
      });

      const nodes = await client.list("Node", { labelSelector: { role: "worker" } });
      assert.equal(nodes.length, 1);
      assert.equal((nodes[0] as { kind?: string }).kind, "Node");
      assert.equal(seen[0]?.authorization, "Bearer test-token");
      assert.match(seen[0]?.url ?? "", /\/api\/v1\/nodes\?labelSelector=role%3Dworker$/);

      const deployments = await client.list("Deployment", { namespace: "payments" });
      assert.equal(deployments.length, 1);
      assert.equal(seen[1]?.url, "/apis/apps/v1/namespaces/payments/deployments");

      const secrets = await client.list("Secret", { namespace: "payments" });
      assert.equal(secrets.length, 1);
      assert.equal(seen[2]?.url, "/api/v1/namespaces/payments/secrets");

      const clusterRoles = await client.list("ClusterRole");
      assert.equal(clusterRoles.length, 1);
      assert.equal(seen[3]?.url, "/apis/rbac.authorization.k8s.io/v1/clusterroles");

      const missing = await client.get("Pod", "missing", { namespace: "payments" });
      assert.equal(missing, undefined);

      await assert.rejects(() => client.get("Deployment", "api"), /namespace is required/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("transport", () => {
  test("tunnels requests through the kubeconfig proxy-url", async () => {
    const authorizations: Array<string | undefined> = [];
    const tunnels: string[] = [];

    const target = createServer((request, response) => {
      authorizations.push(request.headers.authorization);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ items: [{ metadata: { name: "worker-1" } }] }));
    });

    const proxy = createServer();
    const openSockets = new Set<Duplex>();
    proxy.on("connect", (request, clientSocket, head) => {
      tunnels.push(request.url ?? "");
      openSockets.add(clientSocket);
      clientSocket.on("close", () => openSockets.delete(clientSocket));

      const [host = "127.0.0.1", port = "80"] = (request.url ?? "").split(":");
      const upstream = netConnect(Number(port), host, () => {
        openSockets.add(upstream);
        upstream.on("close", () => openSockets.delete(upstream));
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", () => clientSocket.destroy());
    });

    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const targetPort = (target.address() as AddressInfo).port;
    const proxyPort = (proxy.address() as AddressInfo).port;

    try {
      const config = kubeconfig
        .replace("server: https://cluster.example:6443", `server: 'http://127.0.0.1:${targetPort}'`)
        .replace(
          "      insecure-skip-tls-verify: true",
          `      insecure-skip-tls-verify: true\n      proxy-url: 'http://127.0.0.1:${proxyPort}'`,
        );

      const client = createKubernetesHttpClient(parseKubeconfig(config));
      const nodes = await client.list("Node");

      assert.equal(nodes.length, 1);
      assert.deepEqual(tunnels, [`127.0.0.1:${targetPort}`]);
      assert.deepEqual(authorizations, ["Bearer super-secret"]);
    } finally {
      for (const socket of openSockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        proxy.close((error) => (error ? reject(error) : resolve()));
      });
      await new Promise<void>((resolve, reject) => {
        target.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  test("bypasses env proxies listed as NO_PROXY CIDR ranges", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ items: [] }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const previous = {
      HTTP_PROXY: process.env.HTTP_PROXY,
      http_proxy: process.env.http_proxy,
      NO_PROXY: process.env.NO_PROXY,
      no_proxy: process.env.no_proxy,
    };

    try {
      process.env.HTTP_PROXY = "http://127.0.0.1:1";
      delete process.env.http_proxy;
      process.env.NO_PROXY = "127.0.0.0/8";
      delete process.env.no_proxy;

      const client = createKubernetesHttpClient({
        server: `http://127.0.0.1:${port}`,
        token: "env-token",
      });

      assert.deepEqual(await client.list("Node"), []);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

const execPluginSource = `
const fs = require("node:fs");
const statePath = process.env.PLUGIN_STATE;
const runs = fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, "utf8")) : 0;
fs.writeFileSync(statePath, String(runs + 1));
fs.writeFileSync(statePath + ".info", process.env.KUBERNETES_EXEC_INFO || "");
fs.writeFileSync(statePath + ".args", JSON.stringify(process.argv.slice(2)));
if (process.env.PLUGIN_FAIL) process.exit(Number(process.env.PLUGIN_FAIL));
process.stdout.write(JSON.stringify({
  apiVersion: "client.authentication.k8s.io/v1beta1",
  kind: "ExecCredential",
  status: {
    token: "exec-token-" + (runs + 1),
    expirationTimestamp: new Date(Date.now() + 3600000).toISOString(),
  },
}));
`;

function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function execKubeconfig(server: string, pluginDir: string, extraEnv = ""): string {
  return `
apiVersion: v1
kind: Config
current-context: eks
clusters:
  - name: eks
    cluster:
      server: ${yamlQuote(server)}
      certificate-authority-data: Y2E=
      tls-server-name: eks.internal
contexts:
  - name: eks
    context:
      cluster: eks
      user: aws
      namespace: payments
users:
  - name: aws
    user:
      exec:
        apiVersion: client.authentication.k8s.io/v1beta1
        command: ${yamlQuote(process.execPath)}
        args:
          - ${yamlQuote(join(pluginDir, "plugin.cjs"))}
          - get-token
        env:
          PLUGIN_STATE: ${yamlQuote(join(pluginDir, "runs.txt"))}
${extraEnv}        provideClusterInfo: true
        interactiveMode: Never
`;
}

async function createExecFixture(extraEnv = ""): Promise<{ dir: string; config: (server: string) => string }> {
  const dir = await mkdtemp(join(tmpdir(), "kubeforge-exec-"));
  await writeFile(join(dir, "plugin.cjs"), execPluginSource, "utf8");
  return { dir, config: (server) => execKubeconfig(server, dir, extraEnv) };
}

async function readState(dir: string, suffix: string): Promise<string> {
  return readFile(join(dir, `runs.txt${suffix}`), "utf8");
}

describe("exec credentials", () => {
  test("runs the plugin once, passes cluster info, and caches the token", async () => {
    const fixture = await createExecFixture();

    try {
      const connection = parseKubeconfig(fixture.config("https://cluster.example:6443"));
      const provider = connection.exec;
      assert.ok(provider);
      assert.equal(connection.token, undefined);

      const first = await provider();
      const second = await provider();

      assert.equal(first.token, "exec-token-1");
      assert.equal(second.token, "exec-token-1");
      assert.equal(await readState(fixture.dir, ""), "1");

      const info = JSON.parse(await readState(fixture.dir, ".info")) as {
        apiVersion: string;
        kind: string;
        spec: { interactive: boolean; cluster: Record<string, unknown> };
      };
      assert.equal(info.kind, "ExecCredential");
      assert.equal(info.apiVersion, "client.authentication.k8s.io/v1beta1");
      assert.equal(info.spec.interactive, false);
      assert.equal(info.spec.cluster.server, "https://cluster.example:6443");
      assert.equal(info.spec.cluster["certificate-authority-data"], "Y2E=");
      assert.equal(info.spec.cluster["tls-server-name"], "eks.internal");

      assert.deepEqual(JSON.parse(await readState(fixture.dir, ".args")), ["get-token"]);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  test("authenticates API requests with exec-provided tokens", async () => {
    const fixture = await createExecFixture();
    const authorizations: Array<string | undefined> = [];

    const server = createServer((request, response) => {
      authorizations.push(request.headers.authorization);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ items: [] }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    try {
      const connection = parseKubeconfig(fixture.config(`http://127.0.0.1:${address.port}`));
      const client = createKubernetesHttpClient(connection);

      await client.list("Node");
      await client.list("Deployment", { namespace: "payments" });

      assert.deepEqual(authorizations, ["Bearer exec-token-1", "Bearer exec-token-1"]);
      assert.equal(await readState(fixture.dir, ""), "1");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  test("surfaces nonzero plugin exits", async () => {
    const fixture = await createExecFixture("          PLUGIN_FAIL: '3'\n");

    try {
      const connection = parseKubeconfig(fixture.config("https://cluster.example:6443"));
      const provider = connection.exec;
      assert.ok(provider);

      await assert.rejects(provider(), /exited with code 3/);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
});
