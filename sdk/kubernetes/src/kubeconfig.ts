import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { KubeforgeError } from "@kubeforge/core";
import {
  createExecCredentialProvider,
  type ExecCredentialProvider,
  type ExecPluginConfig,
} from "./exec.js";

export interface KubernetesConnection {
  server: string;
  namespace?: string;
  token?: string;
  username?: string;
  password?: string;
  ca?: Buffer;
  clientCertificate?: Buffer;
  clientKey?: Buffer;
  rejectUnauthorized?: boolean;
  tlsServerName?: string;
  proxyUrl?: string;
  timeoutMs?: number;
  exec?: ExecCredentialProvider;
}

export interface KubeconfigLoadOptions {
  path?: string;
  context?: string;
  timeoutMs?: number;
}

export interface ParseKubeconfigOptions {
  context?: string;
  baseDir?: string;
  timeoutMs?: number;
}

export interface InClusterOptions {
  timeoutMs?: number;
}

interface NamedCluster {
  server: string;
  certificateAuthorityFile?: string;
  certificateAuthorityData?: string;
  insecureSkipTlsVerify: boolean;
  tlsServerName?: string;
  proxyUrl?: string;
}

interface NamedContext {
  cluster: string;
  user?: string;
  namespace?: string;
}

interface NamedUser {
  token?: string;
  tokenFile?: string;
  username?: string;
  password?: string;
  clientCertificateFile?: string;
  clientCertificateData?: string;
  clientKeyFile?: string;
  clientKeyData?: string;
  exec?: ExecPluginConfig;
  usesAuthProvider: boolean;
}

interface KubeconfigDocument {
  currentContext?: string;
  clusters: Map<string, NamedCluster>;
  contexts: Map<string, NamedContext>;
  users: Map<string, NamedUser>;
}

const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readBytes(filePath: string, description: string): Buffer {
  try {
    return readFileSync(filePath);
  } catch (error) {
    throw new KubeforgeError(`Unable to read ${description} at ${filePath}`, "KUBERNETES_KUBECONFIG_INVALID", {
      cause: error,
    });
  }
}

function readText(filePath: string, description: string): string {
  return readBytes(filePath, description).toString("utf8").trim();
}

function resolveExecCommand(command: string, baseDir: string): string {
  if (isAbsolute(command)) return command;
  if (command.includes("/") || command.includes("\\")) return resolve(baseDir, command);
  return command;
}

function parseExecPlugin(record: Record<string, unknown>, baseDir: string): ExecPluginConfig {
  const command = asString(record.command);
  if (!command) {
    throw new KubeforgeError(
      "Invalid kubeconfig: exec credential plugin is missing a command",
      "KUBERNETES_KUBECONFIG_INVALID",
    );
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(record.env) ?? {})) {
    if (typeof value === "string") env[key] = value;
  }

  const interactiveMode = asString(record.interactiveMode) ?? "IfAvailable";
  if (interactiveMode !== "Never" && interactiveMode !== "IfAvailable" && interactiveMode !== "Always") {
    throw new KubeforgeError(
      `Invalid kubeconfig: exec credential plugin "${command}" has unknown interactiveMode "${interactiveMode}"`,
      "KUBERNETES_KUBECONFIG_INVALID",
    );
  }

  return {
    command: resolveExecCommand(command, baseDir),
    args: asArray(record.args).filter((arg): arg is string => typeof arg === "string"),
    env,
    apiVersion: asString(record.apiVersion) ?? "client.authentication.k8s.io/v1beta1",
    provideClusterInfo: record.provideClusterInfo === true,
    interactiveMode,
  };
}

function parseDocument(text: string, baseDir: string): KubeconfigDocument {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new KubeforgeError("Invalid kubeconfig: unable to parse YAML", "KUBERNETES_KUBECONFIG_INVALID", {
      cause: error,
    });
  }

  const root = asRecord(raw);
  if (!root) {
    throw new KubeforgeError("Invalid kubeconfig: expected a mapping at the document root", "KUBERNETES_KUBECONFIG_INVALID");
  }

  const clusters = new Map<string, NamedCluster>();
  for (const entry of asArray(root.clusters)) {
    const record = asRecord(entry);
    const name = asString(record?.name);
    const cluster = asRecord(record?.cluster);
    const server = asString(cluster?.server);
    if (!name || !cluster || !server) continue;

    const authorityFile = asString(cluster["certificate-authority"]);
    clusters.set(name, {
      server,
      certificateAuthorityFile: authorityFile ? resolve(baseDir, authorityFile) : undefined,
      certificateAuthorityData: asString(cluster["certificate-authority-data"]),
      insecureSkipTlsVerify: cluster["insecure-skip-tls-verify"] === true,
      tlsServerName: asString(cluster["tls-server-name"]),
      proxyUrl: asString(cluster["proxy-url"]),
    });
  }

  const contexts = new Map<string, NamedContext>();
  for (const entry of asArray(root.contexts)) {
    const record = asRecord(entry);
    const name = asString(record?.name);
    const context = asRecord(record?.context);
    const clusterName = asString(context?.cluster);
    if (!name || !context || !clusterName) continue;

    contexts.set(name, {
      cluster: clusterName,
      user: asString(context.user),
      namespace: asString(context.namespace),
    });
  }

  const users = new Map<string, NamedUser>();
  for (const entry of asArray(root.users)) {
    const record = asRecord(entry);
    const name = asString(record?.name);
    const user = asRecord(record?.user);
    if (!name || !user) continue;

    const tokenFile = asString(user.tokenFile);
    const certificateFile = asString(user["client-certificate"]);
    const keyFile = asString(user["client-key"]);
    const execRecord = asRecord(user.exec);

    users.set(name, {
      token: asString(user.token),
      tokenFile: tokenFile ? resolve(baseDir, tokenFile) : undefined,
      username: asString(user.username),
      password: asString(user.password),
      clientCertificateFile: certificateFile ? resolve(baseDir, certificateFile) : undefined,
      clientCertificateData: asString(user["client-certificate-data"]),
      clientKeyFile: keyFile ? resolve(baseDir, keyFile) : undefined,
      clientKeyData: asString(user["client-key-data"]),
      exec: execRecord ? parseExecPlugin(execRecord, baseDir) : undefined,
      usesAuthProvider: asRecord(user["auth-provider"]) !== undefined,
    });
  }

  return {
    currentContext: asString(root["current-context"]),
    clusters,
    contexts,
    users,
  };
}

function mergeDocuments(documents: KubeconfigDocument[]): KubeconfigDocument {
  const merged: KubeconfigDocument = { clusters: new Map(), contexts: new Map(), users: new Map() };

  for (const document of documents) {
    if (merged.currentContext === undefined && document.currentContext) {
      merged.currentContext = document.currentContext;
    }
    for (const [name, cluster] of document.clusters) {
      if (!merged.clusters.has(name)) merged.clusters.set(name, cluster);
    }
    for (const [name, context] of document.contexts) {
      if (!merged.contexts.has(name)) merged.contexts.set(name, context);
    }
    for (const [name, user] of document.users) {
      if (!merged.users.has(name)) merged.users.set(name, user);
    }
  }

  return merged;
}

function connectionFromDocuments(
  documents: KubeconfigDocument[],
  contextName: string | undefined,
  timeoutMs: number | undefined,
): KubernetesConnection {
  const merged = mergeDocuments(documents);
  const selectedContext = contextName ?? merged.currentContext;

  if (!selectedContext) {
    throw new KubeforgeError(
      "Kubeconfig does not define a current context; pass a context explicitly",
      "KUBERNETES_KUBECONFIG_INVALID",
    );
  }

  const context = merged.contexts.get(selectedContext);
  if (!context) {
    throw new KubeforgeError(`Kubeconfig context "${selectedContext}" was not found`, "KUBERNETES_KUBECONFIG_INVALID");
  }

  const cluster = merged.clusters.get(context.cluster);
  if (!cluster) {
    throw new KubeforgeError(
      `Kubeconfig cluster "${context.cluster}" referenced by context "${selectedContext}" was not found`,
      "KUBERNETES_KUBECONFIG_INVALID",
    );
  }

  const user = context.user ? merged.users.get(context.user) : undefined;
  if (context.user && !user) {
    throw new KubeforgeError(`Kubeconfig user "${context.user}" was not found`, "KUBERNETES_KUBECONFIG_INVALID");
  }
  if (user?.exec?.interactiveMode === "Always") {
    throw new KubeforgeError(
      `Exec credential plugin "${user.exec.command}" requires an interactive terminal, which is not supported`,
      "KUBERNETES_EXEC_INTERACTIVE_UNSUPPORTED",
    );
  }
  if (user?.usesAuthProvider) {
    throw new KubeforgeError(
      "Kubeconfig auth-provider credentials are not supported; use a token or client certificate",
      "KUBERNETES_AUTH_PROVIDER_UNSUPPORTED",
    );
  }

  const connection: KubernetesConnection = {
    server: cluster.server,
    timeoutMs,
  };

  if (context.namespace) connection.namespace = context.namespace;
  if (cluster.insecureSkipTlsVerify) connection.rejectUnauthorized = false;
  if (cluster.tlsServerName) connection.tlsServerName = cluster.tlsServerName;
  if (cluster.proxyUrl) connection.proxyUrl = cluster.proxyUrl;

  if (cluster.certificateAuthorityData) {
    connection.ca = Buffer.from(cluster.certificateAuthorityData, "base64");
  } else if (cluster.certificateAuthorityFile) {
    connection.ca = readBytes(cluster.certificateAuthorityFile, "certificate authority");
  }

  if (user?.exec) {
    connection.exec = createExecCredentialProvider({
      ...user.exec,
      cluster: {
        server: cluster.server,
        certificateAuthorityData:
          cluster.certificateAuthorityData ?? connection.ca?.toString("base64"),
        insecureSkipTlsVerify: cluster.insecureSkipTlsVerify || undefined,
        tlsServerName: cluster.tlsServerName,
        proxyUrl: cluster.proxyUrl,
      },
    });
    return connection;
  }

  if (user?.token) {
    connection.token = user.token;
  } else if (user?.tokenFile) {
    connection.token = readText(user.tokenFile, "token file");
  }

  if (user?.username !== undefined) {
    connection.username = user.username;
    connection.password = user.password ?? "";
  }

  if (user?.clientCertificateData) {
    connection.clientCertificate = Buffer.from(user.clientCertificateData, "base64");
  } else if (user?.clientCertificateFile) {
    connection.clientCertificate = readBytes(user.clientCertificateFile, "client certificate");
  }

  if (user?.clientKeyData) {
    connection.clientKey = Buffer.from(user.clientKeyData, "base64");
  } else if (user?.clientKeyFile) {
    connection.clientKey = readBytes(user.clientKeyFile, "client key");
  }

  return connection;
}

export function resolveKubeconfigPaths(explicitPath?: string): string[] {
  const configured = explicitPath ?? process.env.KUBECONFIG;
  if (configured) {
    return configured
      .split(delimiter)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  return [join(homedir(), ".kube", "config")];
}

export function parseKubeconfig(text: string, options: ParseKubeconfigOptions = {}): KubernetesConnection {
  const document = parseDocument(text, options.baseDir ?? process.cwd());
  return connectionFromDocuments([document], options.context, options.timeoutMs);
}

export function loadKubeconfig(options: KubeconfigLoadOptions = {}): KubernetesConnection {
  const paths = resolveKubeconfigPaths(options.path);
  const documents: KubeconfigDocument[] = [];

  for (const filePath of paths) {
    if (!existsSync(filePath)) {
      if (options.path) {
        throw new KubeforgeError(`Kubeconfig not found at ${filePath}`, "KUBERNETES_KUBECONFIG_NOT_FOUND");
      }
      continue;
    }
    documents.push(parseDocument(readFileSync(filePath, "utf8"), dirname(filePath)));
  }

  if (documents.length === 0) {
    throw new KubeforgeError(
      `Kubeconfig not found; looked in ${paths.join(", ")}`,
      "KUBERNETES_KUBECONFIG_NOT_FOUND",
    );
  }

  return connectionFromDocuments(documents, options.context, options.timeoutMs);
}

export function loadInClusterConfig(options: InClusterOptions = {}): KubernetesConnection | undefined {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT;
  if (!host || !port) return undefined;

  const tokenPath = `${SERVICE_ACCOUNT_DIR}/token`;
  if (!existsSync(tokenPath)) return undefined;

  const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const connection: KubernetesConnection = {
    server: `https://${hostname}:${port}`,
    token: readText(tokenPath, "service account token"),
    timeoutMs: options.timeoutMs,
  };

  const caPath = `${SERVICE_ACCOUNT_DIR}/ca.crt`;
  if (existsSync(caPath)) connection.ca = readBytes(caPath, "service account CA certificate");

  const namespacePath = `${SERVICE_ACCOUNT_DIR}/namespace`;
  if (existsSync(namespacePath)) {
    const namespace = readText(namespacePath, "service account namespace");
    if (namespace) connection.namespace = namespace;
  }

  return connection;
}
