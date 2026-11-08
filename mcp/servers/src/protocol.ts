import type { KubeforgeTool } from "@kubeforge/mcp-tools";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface ServerInfo {
  name: string;
  version: string;
}

export type Dispatcher = (request: JsonRpcRequest) => Promise<JsonRpcResponse | undefined>;

const PROTOCOL_VERSION = "2025-06-18";

export function createDispatcher(tools: KubeforgeTool[], serverInfo: ServerInfo): Dispatcher {
  const toolsByName = new Map(tools.map((tool) => [tool.definition.name, tool]));

  return async (request) => {
    const id = request.id ?? null;

    const callTool = async (params: unknown): Promise<JsonRpcResponse> => {
      if (typeof params !== "object" || params === null || typeof (params as { name?: unknown }).name !== "string") {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "tools/call requires a tool name" },
        };
      }

      const name = (params as { name: string }).name;
      const tool = toolsByName.get(name);
      if (!tool) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown tool: ${name}` },
        };
      }

      try {
        const report = await tool.execute();
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
            isError: false,
          },
        };
      } catch (error) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          },
        };
      }
    };

    switch (request.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo,
          },
        };
      case "notifications/initialized":
        return undefined;
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: tools.map((tool) => tool.definition) },
        };
      case "tools/call":
        return callTool(request.params);
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        };
    }
  };
}
