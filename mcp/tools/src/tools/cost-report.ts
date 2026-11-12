import { defaultRates, createCostAgent, type CostRates } from "@kubeforge/cost-agent";
import { createLogger, KubeforgeError } from "@kubeforge/core";
import type { ToolDescriptor } from "@kubeforge/mcp-schemas";
import type { KubeforgeTool, ToolRuntime } from "../types.js";
import { kubernetesFor, optionalNumber, optionalString, requireObject } from "./context.js";

function readRates(value: Record<string, unknown>): CostRates {
  const rates = value.rates;
  if (rates === undefined || rates === null) return defaultRates;
  if (typeof rates !== "object" || Array.isArray(rates)) {
    throw new KubeforgeError(
      `${definition.name} requires "rates" to be an object`,
      "MCP_INVALID_ARGUMENT",
    );
  }

  const fields = rates as Record<string, unknown>;
  return {
    cpuCoreMonth:
      optionalNumber(fields, "cpuCoreMonth", `${definition.name}.rates`) ?? defaultRates.cpuCoreMonth,
    memoryGiBMonth:
      optionalNumber(fields, "memoryGiBMonth", `${definition.name}.rates`) ??
      defaultRates.memoryGiBMonth,
  };
}

export const definition: ToolDescriptor = {
  name: "cost_report",
  description: "Estimate monthly cost per namespace from workload resource requests.",
  inputSchema: {
    type: "object",
    properties: {
      rates: {
        type: "object",
        properties: {
          cpuCoreMonth: { type: "number", minimum: 0, description: "USD per CPU core per month." },
          memoryGiBMonth: { type: "number", minimum: 0, description: "USD per GiB per month." },
        },
        additionalProperties: false,
      },
      namespaceBudget: {
        type: "number",
        minimum: 0,
        description: "Monthly USD budget per namespace; exceeding it raises a warning.",
      },
      context: { type: "string" },
      kubeconfig: { type: "string" },
    },
    additionalProperties: false,
  },
};

export async function execute(input: unknown, runtime: ToolRuntime): Promise<unknown> {
  const value = requireObject(input, definition.name);
  const client = kubernetesFor(runtime, {
    context: optionalString(value, "context", definition.name),
    kubeconfig: optionalString(value, "kubeconfig", definition.name),
  });
  const rates = readRates(value);
  const namespaceBudget = optionalNumber(value, "namespaceBudget", definition.name);

  const report = await createCostAgent({ client, rates, namespaceBudget }).run({
    logger: runtime.logger ?? createLogger(definition.name),
  });

  return {
    ...report,
    rates,
    namespaceBudget: namespaceBudget ?? null,
  };
}

export function createCostReportTool(runtime: ToolRuntime): KubeforgeTool {
  return { definition, execute: (input) => execute(input, runtime) };
}
