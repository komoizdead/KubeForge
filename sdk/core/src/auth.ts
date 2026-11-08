import { KubeforgeError } from "./errors.js";

export type AuthCredentials = Record<string, unknown>;

export interface AuthIdentity {
  subject: string;
  provider: string;
  scopes?: string[];
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}

export type AuthResult = Omit<AuthIdentity, "provider">;

export interface AuthProvider {
  readonly name: string;
  authenticate(credentials?: AuthCredentials): Promise<AuthResult> | AuthResult;
}

export interface AuthenticateOptions {
  provider?: string;
  credentials?: AuthCredentials;
}

export class AuthManager {
  readonly #providers = new Map<string, AuthProvider>();
  #identity: AuthIdentity | undefined;

  register(provider: AuthProvider): this {
    if (!provider.name) {
      throw new KubeforgeError("Authentication provider must have a name", "SDK_AUTH_PROVIDER_INVALID");
    }
    if (this.#providers.has(provider.name)) {
      throw new KubeforgeError(
        `Authentication provider "${provider.name}" is already registered`,
        "SDK_AUTH_PROVIDER_DUPLICATE",
      );
    }
    this.#providers.set(provider.name, provider);
    return this;
  }

  has(name: string): boolean {
    return this.#providers.has(name);
  }

  list(): string[] {
    return [...this.#providers.keys()];
  }

  get identity(): AuthIdentity | undefined {
    return this.#identity;
  }

  get authenticated(): boolean {
    return this.#identity !== undefined;
  }

  async authenticate(options: AuthenticateOptions = {}): Promise<AuthIdentity> {
    const provider = this.#select(options.provider);
    const result = await provider.authenticate(options.credentials);

    if (!result || typeof result.subject !== "string" || result.subject.length === 0) {
      throw new KubeforgeError(
        `Authentication provider "${provider.name}" returned an identity without a subject`,
        "SDK_AUTH_IDENTITY_INVALID",
      );
    }
    if (result.expiresAt !== undefined) {
      const expiresAt = result.expiresAt;
      if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
        throw new KubeforgeError(
          `Authentication provider "${provider.name}" returned an expired or invalid identity`,
          "SDK_AUTH_IDENTITY_INVALID",
        );
      }
    }

    this.#identity = { ...result, provider: provider.name };
    return this.#identity;
  }

  clear(): void {
    this.#identity = undefined;
  }

  #select(name: string | undefined): AuthProvider {
    if (name) {
      const provider = this.#providers.get(name);
      if (!provider) {
        throw new KubeforgeError(`Authentication provider "${name}" is not registered`, "SDK_AUTH_PROVIDER_UNKNOWN");
      }
      return provider;
    }

    if (this.#providers.size === 0) {
      throw new KubeforgeError("No authentication providers are registered", "SDK_AUTH_NO_PROVIDERS");
    }
    if (this.#providers.size > 1) {
      throw new KubeforgeError(
        "Multiple authentication providers are registered; specify which one to use",
        "SDK_AUTH_PROVIDER_REQUIRED",
      );
    }
    return this.#providers.values().next().value as AuthProvider;
  }
}
