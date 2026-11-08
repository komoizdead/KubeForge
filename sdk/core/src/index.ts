import type { Logger } from "./logger.js";

export type Severity = "info" | "warning" | "error" | "critical";

export interface ResourceRef {
  kind: string;
  name: string;
  namespace?: string;
}

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail?: string;
  resource?: ResourceRef;
  remediation?: string;
}

export interface AgentContext {
  logger: Logger;
  signal?: AbortSignal;
}

export interface AgentReport {
  agent: string;
  startedAt: string;
  finishedAt: string;
  findings: Finding[];
}

export interface Agent {
  readonly name: string;
  run(context: AgentContext): Promise<AgentReport>;
}

export type AgentCheck = (context: AgentContext) => Promise<Finding[]>;

export function defineAgent(name: string, check: AgentCheck): Agent {
  return {
    name,
    async run(context) {
      const startedAt = new Date().toISOString();
      const findings = await check(context);
      return { agent: name, startedAt, finishedAt: new Date().toISOString(), findings };
    },
  };
}

export function severityRank(severity: Severity): number {
  switch (severity) {
    case "critical":
      return 4;
    case "error":
      return 3;
    case "warning":
      return 2;
    case "info":
      return 1;
  }
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

export { KubeforgeError, err, ok, type Result } from "./errors.js";
export {
  createCommandRunner,
  defaultCommandCodes,
  runCommand,
  type CommandErrorCodes,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
} from "./command.js";
export { createLogger, isLogLevel, type Logger, type LogLevel } from "./logger.js";
export { ConfigStore, type ConfigStoreOptions } from "./config.js";
export { EventBus, type EventListener } from "./events.js";
export {
  AuthManager,
  type AuthCredentials,
  type AuthIdentity,
  type AuthProvider,
  type AuthResult,
  type AuthenticateOptions,
} from "./auth.js";
export { PermissionManager, type PermissionManagerOptions } from "./permissions.js";
export {
  PluginManager,
  type KubeforgePlugin,
  type PluginContext,
  type PluginSource,
} from "./plugins.js";
export {
  createSdk,
  SdkEvent,
  type KubeforgeSdk,
  type SdkOptions,
  type SdkState,
} from "./sdk.js";
