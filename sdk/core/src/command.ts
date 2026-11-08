import type { ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import { KubeforgeError } from "./errors.js";

export interface CommandErrorCodes {
  failed: string;
  notFound: string;
  timeout: string;
}

export const defaultCommandCodes: CommandErrorCodes = {
  failed: "COMMAND_FAILED",
  notFound: "COMMAND_NOT_FOUND",
  timeout: "COMMAND_TIMEOUT",
};

export interface CommandOptions {
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  stdin?: string;
  cwd?: string;
  codes?: Partial<CommandErrorCodes>;
}

export interface CommandResult {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult>;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60_000;
const MAX_ERROR_OUTPUT = 4_000;

export function createCommandRunner(): CommandRunner {
  return {
    run(command, args, options = {}) {
      const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
      const codes = { ...defaultCommandCodes, ...options.codes };

      return new Promise<CommandResult>((resolve, reject) => {
        let child: ChildProcess;
        try {
          child = crossSpawn(command, args, {
            cwd: options.cwd,
            env: options.env ? { ...process.env, ...options.env } : process.env,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          });
        } catch (error) {
          reject(
            new KubeforgeError(
              `Unable to run "${command}": ${error instanceof Error ? error.message : String(error)}`,
              codes.failed,
              { cause: error },
            ),
          );
          return;
        }

        let stdout = "";
        let stderr = "";
        let settled = false;

        const settle = (action: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          action();
        };

        const timer = setTimeout(() => {
          child.kill();
          settle(() =>
            reject(
              new KubeforgeError(
                `Command "${command}" timed out after ${timeoutMs}ms`,
                codes.timeout,
              ),
            ),
          );
        }, timeoutMs);

        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        child.on("error", (error: NodeJS.ErrnoException) => {
          const notFound = error.code === "ENOENT";
          settle(() =>
            reject(
              new KubeforgeError(
                notFound
                  ? `Command "${command}" was not found; install the CLI and ensure it is on PATH`
                  : `Command "${command}" failed to start: ${error.message}`,
                notFound ? codes.notFound : codes.failed,
                { cause: error },
              ),
            ),
          );
        });

        child.on("close", (code, signal) => {
          settle(() =>
            resolve({
              command,
              args: [...args],
              exitCode: code ?? (signal ? -1 : 0),
              stdout,
              stderr,
            }),
          );
        });

        child.stdin?.on("error", () => {
          // The CLI may exit before reading stdin; the exit code carries the failure.
        });
        child.stdin?.end(options.stdin ?? "");
      });
    },
  };
}

export async function runCommand(
  runner: CommandRunner,
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const result = await runner.run(command, args, options);
  if (result.exitCode !== 0) {
    const codes = { ...defaultCommandCodes, ...options.codes };
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(-MAX_ERROR_OUTPUT);
    throw new KubeforgeError(
      `${command} ${args.join(" ")} exited with code ${result.exitCode}${detail ? `: ${detail}` : ""}`,
      codes.failed,
    );
  }
  return result;
}
