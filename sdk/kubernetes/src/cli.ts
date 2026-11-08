import {
  createCommandRunner as createCoreCommandRunner,
  runCommand,
  type CommandErrorCodes,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
} from "@kubeforge/core";

export type { CommandOptions, CommandResult, CommandRunner };

export const kubernetesCommandCodes: CommandErrorCodes = {
  failed: "KUBERNETES_CLI_FAILED",
  notFound: "KUBERNETES_CLI_NOT_FOUND",
  timeout: "KUBERNETES_CLI_TIMEOUT",
};

export function createCommandRunner(): CommandRunner {
  const runner = createCoreCommandRunner();
  return {
    run(command, args, options = {}) {
      return runner.run(command, args, {
        ...options,
        codes: { ...kubernetesCommandCodes, ...options.codes },
      });
    },
  };
}

export function runCli(
  runner: CommandRunner,
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return runCommand(runner, command, args, {
    ...options,
    codes: { ...kubernetesCommandCodes, ...options.codes },
  });
}
