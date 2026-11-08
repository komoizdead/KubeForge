import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest, type RequestOptions } from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { KubeforgeError } from "@kubeforge/core";
import type { KubernetesClient, KubernetesKind, ListOptions } from "./index.js";
import {
  loadInClusterConfig,
  loadKubeconfig,
  type KubernetesConnection,
} from "./kubeconfig.js";

interface ApiResource {
  basePath: string;
  plural: string;
  namespaced: boolean;
}

const RESOURCES: Record<KubernetesKind, ApiResource> = {
  Node: { basePath: "/api/v1", plural: "nodes", namespaced: false },
  Namespace: { basePath: "/api/v1", plural: "namespaces", namespaced: false },
  Pod: { basePath: "/api/v1", plural: "pods", namespaced: true },
  Secret: { basePath: "/api/v1", plural: "secrets", namespaced: true },
  Deployment: { basePath: "/apis/apps/v1", plural: "deployments", namespaced: true },
  StatefulSet: { basePath: "/apis/apps/v1", plural: "statefulsets", namespaced: true },
  DaemonSet: { basePath: "/apis/apps/v1", plural: "daemonsets", namespaced: true },
  Role: { basePath: "/apis/rbac.authorization.k8s.io/v1", plural: "roles", namespaced: true },
  ClusterRole: {
    basePath: "/apis/rbac.authorization.k8s.io/v1",
    plural: "clusterroles",
    namespaced: false,
  },
  RoleBinding: {
    basePath: "/apis/rbac.authorization.k8s.io/v1",
    plural: "rolebindings",
    namespaced: true,
  },
  ClusterRoleBinding: {
    basePath: "/apis/rbac.authorization.k8s.io/v1",
    plural: "clusterrolebindings",
    namespaced: false,
  },
};

interface ApiResponse {
  status: number;
  body: unknown;
}

export interface KubernetesClientOptions {
  mode?: "auto" | "kubeconfig" | "in-cluster";
  kubeconfig?: string;
  context?: string;
  timeoutMs?: number;
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function isIpv4InCidr(host: string, range: string): boolean {
  const [network = "", bitsText = ""] = range.split("/");
  const bits = Number(bitsText);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host) || !/^\d+\.\d+\.\d+\.\d+$/.test(network)) return false;
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const toInteger = (address: string): number =>
    address.split(".").reduce((value, part) => ((value << 8) + Number(part)) >>> 0, 0);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInteger(host) & mask) === (toInteger(network) & mask);
}

function isProxyExcluded(target: URL, noProxy: string | undefined): boolean {
  if (!noProxy) return false;

  const host = stripBrackets(target.hostname.toLowerCase());
  const port = target.port || (target.protocol === "https:" ? "443" : "80");

  for (const raw of noProxy.split(",")) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    if (entry.includes("/")) {
      if (isIpv4InCidr(host, entry)) return true;
      continue;
    }

    let entryPort: string | undefined;
    const lastColon = entry.lastIndexOf(":");
    if (lastColon > 0 && entry.indexOf(":") === lastColon && /^\d+$/.test(entry.slice(lastColon + 1))) {
      entryPort = entry.slice(lastColon + 1);
      entry = entry.slice(0, lastColon);
    }

    entry = stripBrackets(entry);
    if (entryPort && entryPort !== port) continue;
    if (entry.startsWith(".")) entry = entry.slice(1);
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }

  return false;
}

function resolveProxyUrl(connection: KubernetesConnection, target: URL): string | undefined {
  if (connection.proxyUrl) {
    try {
      return new URL(connection.proxyUrl).toString();
    } catch (error) {
      throw new KubeforgeError(
        `Invalid Kubernetes proxy URL "${connection.proxyUrl}"`,
        "KUBERNETES_PROXY_INVALID",
        { cause: error },
      );
    }
  }

  const env = process.env;
  const configured =
    target.protocol === "https:"
      ? env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
      : env.HTTP_PROXY ?? env.http_proxy;
  if (!configured) return undefined;
  if (isProxyExcluded(target, env.NO_PROXY ?? env.no_proxy)) return undefined;

  try {
    return new URL(configured).toString();
  } catch {
    return undefined;
  }
}

function createTransportAgent(connection: KubernetesConnection): HttpAgent {
  const target = new URL(connection.server);
  const proxyUrl = resolveProxyUrl(connection, target);

  if (proxyUrl) {
    const agent = new HttpsProxyAgent(proxyUrl);
    agent.keepAlive = true;
    return agent;
  }

  return target.protocol === "https:" ? new HttpsAgent({ keepAlive: true }) : new HttpAgent({ keepAlive: true });
}

interface RequestCredentials {
  headers: Record<string, string>;
  clientCertificate?: Buffer;
  clientKey?: Buffer;
}

async function credentialsFor(connection: KubernetesConnection): Promise<RequestCredentials> {
  if (connection.exec) {
    const credential = await connection.exec();
    const headers: Record<string, string> = credential.token
      ? { Authorization: `Bearer ${credential.token}` }
      : {};
    return {
      headers,
      clientCertificate: credential.clientCertificate,
      clientKey: credential.clientKey,
    };
  }

  if (connection.token) {
    return { headers: { Authorization: `Bearer ${connection.token}` } };
  }
  if (connection.username !== undefined) {
    const credentials = Buffer.from(`${connection.username}:${connection.password ?? ""}`).toString("base64");
    return { headers: { Authorization: `Basic ${credentials}` } };
  }
  return { headers: {} };
}

async function requestJson(
  url: string,
  connection: KubernetesConnection,
  agent: HttpAgent,
): Promise<ApiResponse> {
  const timeoutMs = connection.timeoutMs ?? 30_000;
  const target = new URL(url);
  const credentials = await credentialsFor(connection);
  const options: RequestOptions = {
    method: "GET",
    agent,
    headers: {
      Accept: "application/json",
      "User-Agent": "kubeforge/0.1.0",
      ...credentials.headers,
    },
    timeout: timeoutMs,
  };

  if (target.protocol === "https:") {
    if (connection.ca) options.ca = connection.ca;
    const cert = credentials.clientCertificate ?? connection.clientCertificate;
    const key = credentials.clientKey ?? connection.clientKey;
    if (cert) options.cert = cert;
    if (key) options.key = key;
    if (connection.tlsServerName) options.servername = connection.tlsServerName;
    options.rejectUnauthorized = connection.rejectUnauthorized ?? true;
  }

  return new Promise<ApiResponse>((resolvePromise, rejectPromise) => {
    const handleResponse = (response: IncomingMessage): void => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown;
        if (text.length > 0) {
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        }
        resolvePromise({ status: response.statusCode ?? 0, body });
      });
    };

    const request =
      target.protocol === "https:"
        ? httpsRequest(target, options, handleResponse)
        : httpRequest(target, options, handleResponse);

    request.on("timeout", () => {
      request.destroy(
        new KubeforgeError(`Kubernetes API request timed out after ${timeoutMs}ms`, "KUBERNETES_TIMEOUT"),
      );
    });

    request.on("error", (error) => {
      rejectPromise(
        error instanceof KubeforgeError
          ? error
          : new KubeforgeError(`Kubernetes API request failed: ${error.message}`, "KUBERNETES_REQUEST_FAILED", {
              cause: error,
            }),
      );
    });

    request.end();
  });
}

function statusMessage(body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "Kubernetes API request failed";
}

function httpError(response: ApiResponse, url: string): KubeforgeError {
  const permissionHint =
    response.status === 401 || response.status === 403
      ? " Check your Kubernetes credentials and RBAC permissions."
      : "";
  return new KubeforgeError(
    `${statusMessage(response.body)} (HTTP ${response.status} from ${url})${permissionHint}`,
    `KUBERNETES_HTTP_${response.status}`,
  );
}

function resourcePath(kind: KubernetesKind, namespace: string | undefined, name?: string): string {
  const resource = RESOURCES[kind];
  let path = resource.basePath;

  if (resource.namespaced && namespace) {
    path += `/namespaces/${encodeURIComponent(namespace)}`;
  }
  path += `/${resource.plural}`;
  if (name) {
    path += `/${encodeURIComponent(name)}`;
  }

  return path;
}

function buildUrl(connection: KubernetesConnection, path: string, options: ListOptions = {}): string {
  const url = new URL(`${connection.server.replace(/\/+$/, "")}${path}`);
  const selector = Object.entries(options.labelSelector ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(",");

  if (selector) url.searchParams.set("labelSelector", selector);
  return url.toString();
}

function stampKind(item: unknown, kind: KubernetesKind): unknown {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
  const record = item as Record<string, unknown>;
  return record.kind === kind ? record : { ...record, kind };
}

export function createKubernetesHttpClient(connection: KubernetesConnection): KubernetesClient {
  const agent = createTransportAgent(connection);

  return {
    async list(kind, options = {}) {
      const resource = RESOURCES[kind];
      const namespace = resource.namespaced ? options.namespace : undefined;
      const url = buildUrl(connection, resourcePath(kind, namespace), options);
      const response = await requestJson(url, connection, agent);

      if (response.status < 200 || response.status >= 300) {
        throw httpError(response, url);
      }

      const items = (response.body as { items?: unknown } | undefined)?.items;
      if (!Array.isArray(items)) {
        throw new KubeforgeError(
          `Kubernetes list response for ${kind} did not contain items`,
          "KUBERNETES_INVALID_RESPONSE",
        );
      }

      return items.map((item) => stampKind(item, kind));
    },

    async get(kind, name, options = {}) {
      const resource = RESOURCES[kind];
      const namespace = resource.namespaced ? (options.namespace ?? connection.namespace) : undefined;

      if (resource.namespaced && !namespace) {
        throw new KubeforgeError(
          `A namespace is required to get ${kind} "${name}"`,
          "KUBERNETES_NAMESPACE_REQUIRED",
        );
      }

      const url = buildUrl(connection, resourcePath(kind, namespace, name));
      const response = await requestJson(url, connection, agent);

      if (response.status === 404) return undefined;
      if (response.status < 200 || response.status >= 300) {
        throw httpError(response, url);
      }

      return stampKind(response.body, kind);
    },
  };
}

export function createKubernetesClient(options: KubernetesClientOptions = {}): KubernetesClient {
  if (options.mode !== "kubeconfig") {
    const inCluster = loadInClusterConfig({ timeoutMs: options.timeoutMs });
    if (inCluster) return createKubernetesHttpClient(inCluster);

    if (options.mode === "in-cluster") {
      throw new KubeforgeError(
        "In-cluster configuration not found; KUBERNETES_SERVICE_HOST/PORT and a service account token are required",
        "KUBERNETES_CONFIG_NOT_FOUND",
      );
    }
  }

  return createKubernetesHttpClient(
    loadKubeconfig({
      path: options.kubeconfig,
      context: options.context,
      timeoutMs: options.timeoutMs,
    }),
  );
}
