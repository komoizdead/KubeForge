#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createKubeforgeTools } from "@kubeforge/mcp-tools";
import { createDemoRuntime } from "./demo.js";
import { createDispatcher, type JsonRpcRequest } from "./protocol.js";

process.stderr.write("kubeforge MCP server listening on stdio (demo runtime)\n");

const dispatch = createDispatcher(createKubeforgeTools(createDemoRuntime()), {
  name: "kubeforge",
  version: "0.1.0",
});

function send(response: unknown): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function parse(line: string): JsonRpcRequest | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) return undefined;
    const request = value as { jsonrpc?: unknown; method?: unknown };
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return undefined;
    return value as JsonRpcRequest;
  } catch {
    return undefined;
  }
}

const input = createInterface({ input: process.stdin, terminal: false });
let queue: Promise<void> = Promise.resolve();

input.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  const request = parse(trimmed);
  if (!request) {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }

  queue = queue
    .then(async () => {
      const response = await dispatch(request);
      if (response) send(response);
    })
    .catch((error: unknown) => {
      process.stderr.write(`kubeforge MCP dispatch failed: ${String(error)}\n`);
    });
});
