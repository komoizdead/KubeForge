import { AuthManager, type AuthIdentity, type AuthenticateOptions } from "./auth.js";
import { ConfigStore } from "./config.js";
import { EventBus } from "./events.js";
import { createLogger, isLogLevel, type Logger, type LogLevel } from "./logger.js";
import { PermissionManager } from "./permissions.js";
import { PluginManager, type KubeforgePlugin, type PluginSource } from "./plugins.js";

export type SdkState = "idle" | "connected";

export const SdkEvent = {
  Connected: "sdk.connected",
  Authenticated: "auth.authenticated",
  PluginLoaded: "plugin.loaded",
  ConfigChanged: "config.changed",
} as const;

export interface SdkOptions {
  name?: string;
  config?: ConfigStore | Record<string, unknown>;
  envPrefix?: string;
  logger?: Logger;
  events?: EventBus;
  auth?: AuthManager;
  permissions?: PermissionManager;
}

export interface KubeforgeSdk {
  readonly name: string;
  readonly config: ConfigStore;
  readonly logger: Logger;
  readonly events: EventBus;
  readonly auth: AuthManager;
  readonly permissions: PermissionManager;
  readonly plugins: PluginManager;
  readonly state: SdkState;
  connect(): Promise<void>;
  authenticate(options?: AuthenticateOptions): Promise<AuthIdentity>;
  loadPlugin(source: PluginSource): Promise<KubeforgePlugin>;
  emit(event: string, payload?: unknown): void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function logLevelOf(config: ConfigStore): LogLevel {
  const level = config.get<unknown>("log.level");
  return isLogLevel(level) ? level : "info";
}

function permissionsOf(config: ConfigStore): PermissionManager {
  const manager = new PermissionManager();

  const roles = config.get<unknown>("permissions.roles");
  if (isPlainObject(roles)) {
    for (const [role, allow] of Object.entries(roles)) {
      if (Array.isArray(allow) && allow.every((pattern) => typeof pattern === "string")) {
        manager.defineRole(role, allow);
      }
    }
  }

  const granted = config.get<unknown>("permissions.granted");
  if (Array.isArray(granted)) {
    for (const role of granted) {
      if (typeof role === "string") manager.grant(role);
    }
  }

  return manager;
}

export function createSdk(options: SdkOptions = {}): KubeforgeSdk {
  const name = options.name ?? "kubeforge";
  const events = options.events ?? new EventBus();
  const config =
    options.config instanceof ConfigStore
      ? options.config
      : new ConfigStore({
          defaults: options.config,
          envPrefix: options.envPrefix ?? "KUBEFORGE",
          onChange: (key, value) => events.emit(SdkEvent.ConfigChanged, { key, value }),
        });

  const logger = options.logger ?? createLogger(name, logLevelOf(config));
  const auth = options.auth ?? new AuthManager();
  const permissions = options.permissions ?? permissionsOf(config);
  const plugins = new PluginManager({ config, logger, events, auth, permissions });

  let state: SdkState = "idle";

  return {
    name,
    config,
    logger,
    events,
    auth,
    permissions,
    plugins,
    get state() {
      return state;
    },

    async connect() {
      if (state === "connected") return;
      await plugins.connect();
      state = "connected";
      events.emit(SdkEvent.Connected, { name });
    },

    async authenticate(authOptions) {
      const identity = await auth.authenticate(authOptions);
      events.emit(SdkEvent.Authenticated, identity);
      return identity;
    },

    async loadPlugin(source) {
      const plugin = await plugins.load(source);
      events.emit(SdkEvent.PluginLoaded, { name: plugin.name, version: plugin.version });
      return plugin;
    },

    emit(event, payload) {
      events.emit(event, payload);
    },
  };
}
