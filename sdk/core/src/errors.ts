export class KubeforgeError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KubeforgeError";
    this.code = code;
  }
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: KubeforgeError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err(error: KubeforgeError): Result<never> {
  return { ok: false, error };
}
