import { spawn } from "node:child_process";
import { KubeforgeError } from "@kubeforge/core";

export interface ExecPluginConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  apiVersion: string;
  provideClusterInfo: boolean;
  interactiveMode: "Never" | "IfAvailable" | "Always";
}

export interface ExecClusterInfo {
  server: string;
  certificateAuthorityData?: string;
  insecureSkipTlsVerify?: boolean;
  tlsServerName?: string;
  proxyUrl?: string;
}

export interface ExecCredentialSource extends ExecPluginConfig {
  cluster: ExecClusterInfo;
}

export interface ExecCredential {
  token?: string;
  clientCertificate?: Buffer;
  clientKey?: Buffer;
  expiration?: Date;
}

export type ExecCredentialProvider = () => Promise<ExecCredential>;

const EXEC_TIMEOUT_MS = 60_000;
const EXPIRY_SKEW_MS = 10_000;
const NO_EXPIRATION_TTL_MS = 5 * 60_000;
const MAX_STDERR_CHARS = 8_192;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function buildExecInfo(source: ExecCredentialSource): unknown {
  const cluster: Record<string, unknown> = { server: source.cluster.server };

  if (source.cluster.certificateAuthorityData) {
    cluster["certificate-authority-data"] = source.cluster.certificateAuthorityData;
  }
  if (source.cluster.insecureSkipTlsVerify) {
    cluster["insecure-skip-tls-verify"] = true;
  }
  if (source.cluster.tlsServerName) {
    cluster["tls-server-name"] = source.cluster.tlsServerName;
  }
  if (source.cluster.proxyUrl) {
    cluster["proxy-url"] = source.cluster.proxyUrl;
  }

  const spec: Record<string, unknown> = { interactive: false };
  if (source.provideClusterInfo) spec.cluster = cluster;

  return { apiVersion: source.apiVersion, kind: "ExecCredential", spec };
}

function parseExecCredential(stdout: string, command: string): ExecCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new KubeforgeError(
      `Exec credential plugin "${command}" returned invalid JSON`,
      "KUBERNETES_EXEC_CREDENTIAL_INVALID",
      { cause: error },
    );
  }

  const root = asRecord(parsed);
  if (!root || root.kind !== "ExecCredential") {
    throw new KubeforgeError(
      `Exec credential plugin "${command}" did not return an ExecCredential response`,
      "KUBERNETES_EXEC_CREDENTIAL_INVALID",
    );
  }

  const apiVersion = typeof root.apiVersion === "string" ? root.apiVersion : "";
  if (apiVersion && !apiVersion.startsWith("client.authentication.k8s.io/")) {
    throw new KubeforgeError(
      `Exec credential plugin "${command}" returned unsupported apiVersion "${apiVersion}"`,
      "KUBERNETES_EXEC_CREDENTIAL_INVALID",
    );
  }

  const status = asRecord(root.status);
  if (!status) {
    throw new KubeforgeError(
      `Exec credential plugin "${command}" response is missing status`,
      "KUBERNETES_EXEC_CREDENTIAL_INVALID",
    );
  }

  const token = typeof status.token === "string" && status.token.length > 0 ? status.token : undefined;
  const certificateData =
    typeof status.clientCertificateData === "string" && status.clientCertificateData.length > 0
      ? status.clientCertificateData
      : undefined;
  const keyData =
    typeof status.clientKeyData === "string" && status.clientKeyData.length > 0
      ? status.clientKeyData
      : undefined;

  if (!token && !(certificateData && keyData)) {
    throw new KubeforgeError(
      `Exec credential plugin "${command}" returned neither a token nor a client certificate`,
      "KUBERNETES_EXEC_CREDENTIAL_INVALID",
    );
  }

  let expiration: Date | undefined;
  if (typeof status.expirationTimestamp === "string" && status.expirationTimestamp.length > 0) {
    expiration = new Date(status.expirationTimestamp);
    if (Number.isNaN(expiration.getTime())) {
      throw new KubeforgeError(
        `Exec credential plugin "${command}" returned an invalid expirationTimestamp`,
        "KUBERNETES_EXEC_CREDENTIAL_INVALID",
      );
    }
  }

  return {
    token,
    clientCertificate: certificateData ? Buffer.from(certificateData, "base64") : undefined,
    clientKey: keyData ? Buffer.from(keyData, "base64") : undefined,
    expiration,
  };
}

function executeExecPlugin(source: ExecCredentialSource): Promise<ExecCredential> {
  const child = spawn(source.command, source.args, {
    env: {
      ...process.env,
      ...source.env,
      KUBERNETES_EXEC_INFO: JSON.stringify(buildExecInfo(source)),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderr = `${stderr}${text}`.slice(-MAX_STDERR_CHARS);
    process.stderr.write(text);
  });

  return new Promise<ExecCredential>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(
        new KubeforgeError(
          `Exec credential plugin "${source.command}" timed out after ${EXEC_TIMEOUT_MS}ms`,
          "KUBERNETES_EXEC_TIMEOUT",
        ),
      );
    }, EXEC_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(
        new KubeforgeError(
          `Failed to start exec credential plugin "${source.command}": ${error.message}`,
          "KUBERNETES_EXEC_CREDENTIAL_FAILED",
          { cause: error },
        ),
      );
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);

      if (code !== 0) {
        const reason = signal ? `was terminated by ${signal}` : `exited with code ${code ?? "unknown"}`;
        const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
        rejectPromise(
          new KubeforgeError(
            `Exec credential plugin "${source.command}" ${reason}${detail}`,
            "KUBERNETES_EXEC_CREDENTIAL_FAILED",
          ),
        );
        return;
      }

      try {
        resolvePromise(parseExecCredential(stdout, source.command));
      } catch (error) {
        rejectPromise(error);
      }
    });
  });
}

function isFresh(cachedAt: number, credential: ExecCredential): boolean {
  if (credential.expiration) {
    return credential.expiration.getTime() - Date.now() > EXPIRY_SKEW_MS;
  }
  return Date.now() - cachedAt < NO_EXPIRATION_TTL_MS;
}

export function createExecCredentialProvider(source: ExecCredentialSource): ExecCredentialProvider {
  let cached: { credential: ExecCredential; cachedAt: number } | undefined;
  let inFlight: Promise<ExecCredential> | undefined;

  return async () => {
    if (cached && isFresh(cached.cachedAt, cached.credential)) {
      return cached.credential;
    }

    if (!inFlight) {
      inFlight = executeExecPlugin(source)
        .then((credential) => {
          cached = { credential, cachedAt: Date.now() };
          return credential;
        })
        .finally(() => {
          inFlight = undefined;
        });
    }

    return inFlight;
  };
}
