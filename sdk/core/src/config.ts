import { KubeforgeError } from "./errors.js";

export interface ConfigStoreOptions {
  defaults?: Record<string, unknown>;
  envPrefix?: string;
  env?: Record<string, string | undefined>;
  onChange?: (key: string, value: unknown) => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function merge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    target[key] = isPlainObject(existing) && isPlainObject(value) ? merge(existing, value) : clone(value);
  }
  return target;
}

function parseEnvValue(raw: string): unknown {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    try {
      return JSON.parse(value);
    } catch {
      return raw;
    }
  }
  return raw;
}

function splitKey(key: string): string[] {
  return key.split(".").filter((part) => part.length > 0);
}

export class ConfigStore {
  readonly #values: Record<string, unknown>;
  readonly #onChange: ((key: string, value: unknown) => void) | undefined;

  constructor(options: ConfigStoreOptions = {}) {
    this.#values = clone(options.defaults ?? {});
    this.#onChange = options.onChange;

    if (options.envPrefix) {
      this.#applyEnv(options.envPrefix, options.env ?? process.env);
    }
  }

  get<T = unknown>(key: string): T | undefined;
  get<T>(key: string, fallback: T): T;
  get<T>(key: string, fallback?: T): T | undefined {
    const parts = splitKey(key);
    if (parts.length === 0) return fallback;

    let current: unknown = this.#values;
    for (const part of parts) {
      if (!isPlainObject(current) || !(part in current)) return fallback;
      current = current[part];
    }
    return (current === undefined ? fallback : current) as T;
  }

  set(key: string, value: unknown): void {
    const parts = splitKey(key);
    if (parts.length === 0) {
      throw new KubeforgeError("Configuration key must not be empty", "SDK_CONFIG_INVALID_KEY");
    }

    this.#assign(parts, clone(value));
    this.#onChange?.(key, this.get(key));
  }

  has(key: string): boolean {
    const parts = splitKey(key);
    if (parts.length === 0) return false;

    let current: unknown = this.#values;
    for (const part of parts) {
      if (!isPlainObject(current) || !(part in current)) return false;
      current = current[part];
    }
    return current !== undefined;
  }

  toObject(): Record<string, unknown> {
    return clone(this.#values);
  }

  section(prefix?: string): Record<string, unknown> {
    if (!prefix) return this.toObject();
    const value = this.get<unknown>(prefix);
    return isPlainObject(value) ? clone(value) : {};
  }

  #assign(parts: string[], value: unknown): void {
    let target = this.#values;
    for (const part of parts.slice(0, -1)) {
      const next = target[part];
      if (!isPlainObject(next)) {
        const created: Record<string, unknown> = {};
        target[part] = created;
        target = created;
      } else {
        target = next;
      }
    }
    target[parts[parts.length - 1] as string] = value;
  }

  #applyEnv(prefix: string, env: Record<string, string | undefined>): void {
    const expected = `${prefix.toUpperCase()}_`;

    for (const [name, raw] of Object.entries(env)) {
      if (raw === undefined) continue;
      const upper = name.toUpperCase();
      if (!upper.startsWith(expected)) continue;

      const key = upper.slice(expected.length).toLowerCase().replace(/__/g, ".").replace(/_/g, ".");
      const parts = splitKey(key);
      if (parts.length === 0) continue;
      this.#assign(parts, parseEnvValue(raw));
    }
  }
}
