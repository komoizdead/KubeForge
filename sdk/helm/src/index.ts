import {
  KubeforgeError,
  createCommandRunner,
  runCommand,
  type CommandErrorCodes,
  type CommandRunner,
} from "@kubeforge/core";
import { stringify } from "yaml";

export type HelmReleaseStatus = "deployed" | "failed" | "pending" | "superseded" | "uninstalled";

export interface HelmRelease {
  name: string;
  namespace: string;
  chart: string;
  chartVersion: string;
  appVersion?: string;
  status: HelmReleaseStatus;
  updatedAt?: string;
}

export interface ReleaseSelector {
  namespace?: string;
  status?: HelmReleaseStatus;
}

export interface ChartValues {
  values?: Record<string, unknown>;
  valuesFile?: string;
  set?: Record<string, string | number | boolean>;
}

export interface InstallChartOptions extends ChartValues {
  name: string;
  chart: string;
  namespace?: string;
  version?: string;
  createNamespace?: boolean;
  wait?: boolean;
  timeout?: string;
  atomic?: boolean;
  args?: string[];
}

export interface UpgradeChartOptions extends ChartValues {
  name: string;
  chart: string;
  namespace?: string;
  version?: string;
  installIfMissing?: boolean;
  createNamespace?: boolean;
  wait?: boolean;
  timeout?: string;
  atomic?: boolean;
  args?: string[];
}

export interface RemoveChartOptions {
  name: string;
  namespace?: string;
  keepHistory?: boolean;
  wait?: boolean;
  timeout?: string;
  args?: string[];
}

export interface HelmClient {
  listReleases(selector?: ReleaseSelector): Promise<HelmRelease[]>;
  getRelease(name: string, namespace: string): Promise<HelmRelease | undefined>;
  installChart(options: InstallChartOptions): Promise<HelmRelease>;
  upgradeChart(options: UpgradeChartOptions): Promise<HelmRelease>;
  removeChart(options: RemoveChartOptions): Promise<void>;
}

export interface HelmClientOptions {
  helm?: string;
  namespace?: string;
  kubeconfig?: string;
  context?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  runner?: CommandRunner;
}

const HELM_COMMAND_CODES: CommandErrorCodes = {
  failed: "HELM_CLI_FAILED",
  notFound: "HELM_CLI_NOT_FOUND",
  timeout: "HELM_CLI_TIMEOUT",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeStatus(value: string | undefined): HelmReleaseStatus {
  switch (value) {
    case "deployed":
    case "failed":
    case "superseded":
    case "uninstalled":
      return value;
    default:
      return "pending";
  }
}

function splitChartLabel(label: string): { chart: string; version: string } {
  const match = /^(.*)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(label);
  return match?.[1] && match[2] ? { chart: match[1], version: match[2] } : { chart: label, version: "" };
}

function chartName(chart: string): string {
  const base = chart.split(/[\\/]/).pop() ?? chart;
  return base.replace(/\.tgz$/i, "");
}

export function parseHelmRelease(
  value: unknown,
  fallback: { name?: string; namespace?: string } = {},
): HelmRelease {
  const record = asRecord(value);
  const name = asString(record?.name) ?? fallback.name;
  if (!record || !name) {
    throw new KubeforgeError("Helm returned an unexpected release payload", "HELM_INVALID_RESPONSE");
  }

  const info = asRecord(record.info);
  const chart = asRecord(record.chart);
  const metadata = asRecord(chart?.metadata);
  const chartLabel = asString(record.chart);

  const fromLabel = chartLabel ? splitChartLabel(chartLabel) : undefined;
  const chartVersion = asString(metadata?.version) ?? fromLabel?.version ?? "";
  const releaseChart = asString(metadata?.name) ?? fromLabel?.chart ?? chartVersion;
  const status = normalizeStatus(asString(info?.status) ?? asString(record.status));
  const updatedAt = asString(info?.last_deployed) ?? asString(record.updated);

  return {
    name,
    namespace: asString(record.namespace) ?? fallback.namespace ?? "default",
    chart: releaseChart,
    chartVersion,
    ...(asString(metadata?.appVersion) ?? asString(record.app_version)
      ? { appVersion: asString(metadata?.appVersion) ?? asString(record.app_version) }
      : {}),
    status,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new KubeforgeError(
      `Helm returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "HELM_INVALID_RESPONSE",
      { cause: error },
    );
  }
}

function appendChartValues(args: string[], options: ChartValues): void {
  if (options.valuesFile) args.push("--values", options.valuesFile);
  if (options.values) args.push("--values", "-");
  for (const [key, value] of Object.entries(options.set ?? {})) {
    args.push("--set-json", `${key}=${JSON.stringify(value)}`);
  }
}

function valuesInput(options: ChartValues): string | undefined {
  return options.values ? stringify(options.values) : undefined;
}

function now(): string {
  return new Date().toISOString();
}

function inMemoryRelease(
  options: InstallChartOptions | UpgradeChartOptions,
  namespace: string,
): HelmRelease {
  return {
    name: options.name,
    namespace,
    chart: chartName(options.chart),
    chartVersion: options.version ?? "latest",
    status: "deployed",
    updatedAt: now(),
  };
}

export function createInMemoryHelmClient(releases: HelmRelease[] = []): HelmClient {
  const indexOf = (name: string, namespace: string): number =>
    releases.findIndex((release) => release.name === name && release.namespace === namespace);

  const install = (options: InstallChartOptions): HelmRelease => {
    const namespace = options.namespace ?? "default";
    if (indexOf(options.name, namespace) >= 0) {
      throw new KubeforgeError(
        `Helm release "${namespace}/${options.name}" already exists`,
        "HELM_RELEASE_EXISTS",
      );
    }
    const release = inMemoryRelease(options, namespace);
    releases.push(release);
    return release;
  };

  return {
    async listReleases(selector = {}) {
      return releases.filter(
        (release) =>
          (!selector.namespace || release.namespace === selector.namespace) &&
          (!selector.status || release.status === selector.status),
      );
    },
    async getRelease(name, namespace) {
      return releases.find((release) => release.name === name && release.namespace === namespace);
    },
    async installChart(options) {
      return install(options);
    },
    async upgradeChart(options) {
      const namespace = options.namespace ?? "default";
      const index = indexOf(options.name, namespace);
      if (index < 0) {
        if (!options.installIfMissing) {
          throw new KubeforgeError(
            `Helm release "${namespace}/${options.name}" was not found`,
            "HELM_RELEASE_NOT_FOUND",
          );
        }
        return install({ ...options, namespace });
      }
      const release = inMemoryRelease(options, namespace);
      releases[index] = release;
      return release;
    },
    async removeChart(options) {
      const namespace = options.namespace ?? "default";
      const index = indexOf(options.name, namespace);
      if (index < 0) {
        throw new KubeforgeError(
          `Helm release "${namespace}/${options.name}" was not found`,
          "HELM_RELEASE_NOT_FOUND",
        );
      }
      releases.splice(index, 1);
    },
  };
}

export function createHelmClient(options: HelmClientOptions = {}): HelmClient {
  const runner = options.runner ?? createCommandRunner();
  const helm = options.helm ?? "helm";
  const defaultNamespace = options.namespace;

  const invoke = async (args: string[], stdin?: string): Promise<string> => {
    const globalArgs: string[] = [];
    if (options.kubeconfig) globalArgs.push("--kubeconfig", options.kubeconfig);
    if (options.context) globalArgs.push("--kube-context", options.context);

    const result = await runCommand(runner, helm, [...args, ...globalArgs], {
      timeoutMs: options.timeoutMs,
      env: options.env,
      stdin,
      codes: HELM_COMMAND_CODES,
    });
    return result.stdout;
  };

  const runChart = async (
    args: string[],
    chartOptions: ChartValues & { args?: string[] },
  ): Promise<string> => {
    args.push(...(chartOptions.args ?? []), "--output", "json");
    return invoke(args, valuesInput(chartOptions));
  };

  return {
    async listReleases(selector = {}) {
      const args = ["list", "--all", "--output", "json"];
      const namespace = selector.namespace ?? defaultNamespace;
      if (namespace) args.push("--namespace", namespace);
      else args.push("--all-namespaces");

      const parsed = parseJson(await invoke(args));
      if (!Array.isArray(parsed)) {
        throw new KubeforgeError("Helm list did not return an array", "HELM_INVALID_RESPONSE");
      }

      const releases = parsed.map((entry) => parseHelmRelease(entry));
      return selector.status
        ? releases.filter((release) => release.status === selector.status)
        : releases;
    },

    async getRelease(name, namespace) {
      try {
        const output = await invoke([
          "status",
          name,
          "--namespace",
          namespace,
          "--output",
          "json",
        ]);
        return parseHelmRelease(parseJson(output), { name, namespace });
      } catch (error) {
        if (error instanceof KubeforgeError && error.code === "HELM_CLI_FAILED" && /not found/i.test(error.message)) {
          return undefined;
        }
        throw error;
      }
    },

    async installChart(installOptions) {
      const namespace = installOptions.namespace ?? defaultNamespace;
      const args = ["install", installOptions.name, installOptions.chart];
      if (namespace) args.push("--namespace", namespace);
      if (installOptions.createNamespace) args.push("--create-namespace");
      if (installOptions.version) args.push("--version", installOptions.version);
      appendChartValues(args, installOptions);
      if (installOptions.wait) args.push("--wait");
      if (installOptions.timeout) args.push("--timeout", installOptions.timeout);
      if (installOptions.atomic) args.push("--atomic");

      const output = await runChart(args, installOptions);
      return parseHelmRelease(parseJson(output), { name: installOptions.name, namespace });
    },

    async upgradeChart(upgradeOptions) {
      if (upgradeOptions.createNamespace && !upgradeOptions.installIfMissing) {
        throw new KubeforgeError(
          "createNamespace requires installIfMissing on helm upgrade",
          "HELM_INVALID_ARGUMENT",
        );
      }

      const namespace = upgradeOptions.namespace ?? defaultNamespace;
      const args = ["upgrade", upgradeOptions.name, upgradeOptions.chart];
      if (upgradeOptions.installIfMissing) args.push("--install");
      if (namespace) args.push("--namespace", namespace);
      if (upgradeOptions.createNamespace) args.push("--create-namespace");
      if (upgradeOptions.version) args.push("--version", upgradeOptions.version);
      appendChartValues(args, upgradeOptions);
      if (upgradeOptions.wait) args.push("--wait");
      if (upgradeOptions.timeout) args.push("--timeout", upgradeOptions.timeout);
      if (upgradeOptions.atomic) args.push("--atomic");

      const output = await runChart(args, upgradeOptions);
      return parseHelmRelease(parseJson(output), { name: upgradeOptions.name, namespace });
    },

    async removeChart(removeOptions) {
      const namespace = removeOptions.namespace ?? defaultNamespace;
      const args = ["uninstall", removeOptions.name];
      if (namespace) args.push("--namespace", namespace);
      if (removeOptions.keepHistory) args.push("--keep-history");
      if (removeOptions.wait) args.push("--wait");
      if (removeOptions.timeout) args.push("--timeout", removeOptions.timeout);
      args.push(...(removeOptions.args ?? []));

      await invoke(args);
    },
  };
}
