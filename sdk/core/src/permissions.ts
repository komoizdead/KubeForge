import { KubeforgeError } from "./errors.js";

export interface PermissionManagerOptions {
  roles?: Record<string, string[]>;
  granted?: string[];
}

function matchesPattern(pattern: string, action: string): boolean {
  const expected = pattern.split(".");
  const actual = action.split(".");

  for (let index = 0; index < expected.length; index += 1) {
    const part = expected[index];
    if (part === "*") return index < actual.length;
    if (part !== actual[index]) return false;
  }

  return expected.length === actual.length;
}

export class PermissionManager {
  readonly #roles = new Map<string, string[]>();
  readonly #granted = new Set<string>();

  constructor(options: PermissionManagerOptions = {}) {
    for (const [role, allow] of Object.entries(options.roles ?? {})) {
      this.defineRole(role, allow);
    }
    for (const role of options.granted ?? []) {
      this.grant(role);
    }
  }

  defineRole(name: string, allow: string[]): this {
    if (!name) {
      throw new KubeforgeError("Permission role must have a name", "SDK_PERMISSION_INVALID_ROLE");
    }
    if (!Array.isArray(allow) || allow.some((pattern) => typeof pattern !== "string" || pattern.length === 0)) {
      throw new KubeforgeError(
        `Permission role "${name}" must list non-empty permission patterns`,
        "SDK_PERMISSION_INVALID_ROLE",
      );
    }
    this.#roles.set(name, [...allow]);
    return this;
  }

  grant(role: string): this {
    if (!this.#roles.has(role)) {
      throw new KubeforgeError(`Permission role "${role}" is not defined`, "SDK_PERMISSION_UNKNOWN_ROLE");
    }
    this.#granted.add(role);
    return this;
  }

  revoke(role: string): void {
    this.#granted.delete(role);
  }

  can(action: string): boolean {
    if (!action) return false;
    for (const role of this.#granted) {
      for (const pattern of this.#roles.get(role) ?? []) {
        if (matchesPattern(pattern, action)) return true;
      }
    }
    return false;
  }

  require(action: string): void {
    if (!this.can(action)) {
      throw new KubeforgeError(`Permission denied for "${action}"`, "SDK_PERMISSION_DENIED");
    }
  }

  get roles(): string[] {
    return [...this.#granted];
  }
}
