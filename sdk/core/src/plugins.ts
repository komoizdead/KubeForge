import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { KubeforgeError } from "./errors.js";
import type { AuthManager } from "./auth.js";
import type { ConfigStore } from "./config.js";
import type { EventBus } from "./events.js";
import type { Logger } from "./logger.js";
import type { PermissionManager } from "./permissions.js";

export interface PluginContext {
  config: ConfigStore;
  logger: Logger;
  events: EventBus;
  auth: AuthManager;
  permissions: PermissionManager;
}

export interface KubeforgePlugin {
  readonly name: string;
  readonly version?: string;
  setup?(context: PluginContext): void | Promise<void>;
  connect?(context: PluginContext): void | Promise<void>;
}

export type PluginSource = KubeforgePlugin | string;

function isPlugin(value: unknown): value is KubeforgePlugin {
  if (typeof value !== "object" || value === null) return false;
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" && name.length > 0;
}

function assertPlugin(value: unknown, source: string): KubeforgePlugin {
  if (!isPlugin(value)) {
    throw new KubeforgeError(
      `Plugin "${source}" is not a valid plugin (missing a name)`,
      "SDK_PLUGIN_INVALID",
    );
  }

  const plugin = value as KubeforgePlugin & { version?: unknown; setup?: unknown; connect?: unknown };
  if (plugin.version !== undefined && typeof plugin.version !== "string") {
    throw new KubeforgeError(`Plugin "${plugin.name}" has an invalid version`, "SDK_PLUGIN_INVALID");
  }
  if (plugin.setup !== undefined && typeof plugin.setup !== "function") {
    throw new KubeforgeError(`Plugin "${plugin.name}" has an invalid setup hook`, "SDK_PLUGIN_INVALID");
  }
  if (plugin.connect !== undefined && typeof plugin.connect !== "function") {
    throw new KubeforgeError(`Plugin "${plugin.name}" has an invalid connect hook`, "SDK_PLUGIN_INVALID");
  }

  return plugin;
}

async function importPlugin(specifier: string): Promise<KubeforgePlugin> {
  const reference =
    isAbsolute(specifier) || specifier.startsWith("./") || specifier.startsWith("../")
      ? pathToFileURL(resolve(process.cwd(), specifier)).href
      : specifier;

  let module: { default?: unknown };
  try {
    module = (await import(reference)) as { default?: unknown };
  } catch (error) {
    throw new KubeforgeError(
      `Unable to load plugin "${specifier}": ${error instanceof Error ? error.message : String(error)}`,
      "SDK_PLUGIN_LOAD_FAILED",
      { cause: error },
    );
  }

  return assertPlugin(module.default ?? module, specifier);
}

export class PluginManager {
  readonly #context: PluginContext;
  readonly #plugins: KubeforgePlugin[] = [];
  readonly #names = new Set<string>();

  constructor(context: PluginContext) {
    this.#context = context;
  }

  async load(source: PluginSource): Promise<KubeforgePlugin> {
    const plugin = typeof source === "string" ? await importPlugin(source) : assertPlugin(source, "inline");

    if (this.#names.has(plugin.name)) {
      throw new KubeforgeError(`Plugin "${plugin.name}" is already loaded`, "SDK_PLUGIN_DUPLICATE");
    }

    await plugin.setup?.(this.#context);

    this.#names.add(plugin.name);
    this.#plugins.push(plugin);
    return plugin;
  }

  list(): string[] {
    return [...this.#names];
  }

  async connect(): Promise<void> {
    for (const plugin of this.#plugins) {
      await plugin.connect?.(this.#context);
    }
  }
}
