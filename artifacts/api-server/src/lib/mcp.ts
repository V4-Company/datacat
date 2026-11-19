import { HttpError } from "./http";
import { logger } from "./logger";
import { TOOLS, ToolError, capOutput, checkArgs, type ApiCall, type Tool } from "./mcpTools";

// Model Context Protocol over the Streamable HTTP transport, stateless and JSON-only: each POST carries one JSON-RPC
// message and gets one JSON answer (no SSE stream, no Mcp-Session-Id). This module is the protocol; routes/mcp.ts does
// the HTTP checks (origin, keys) and lib/mcpTools.ts the tools.

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];
export const SERVER_VERSION = "0.1.0";

export const INSTRUCTIONS = [
  "Read-only access to this DataCat organization's telemetry: APM services, spans and traces, metrics, logs, monitors and dashboards.",
  "Times (from/to): now, now-15m, now-1h, now-7d, ISO 8601 or epoch seconds/milliseconds; the default range is the last hour.",
  'Queries use Datadog syntax. Logs and spans: service:web status:error @http.status_code:500 env:prod -host:db-1 "free text".',
  "Metrics: avg:system.cpu.user{host:web-1} by {host}, sum:trace.web.request.hits{service:web}.as_count().",
  "Start broad (list_services, aggregate_logs, list_monitors), then narrow; use search_metrics and get_metric_tags to find metric names and tags.",
  "Outputs are capped: use shorter time ranges, more specific queries or lower limits rather than paging.",
].join("\n");

export const JSONRPC = { PARSE_ERROR: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL_ERROR: -32603 } as const;

type Id = string | number;
export type JsonRpcResponse = { jsonrpc: "2.0"; id: Id; result: unknown } | { jsonrpc: "2.0"; id: Id | null; error: { code: number; message: string } };

/** HTTP answer to one message: a JSON-RPC response, or 202 with no body for notifications and responses. */
export interface McpReply {
  status: number;
  body?: JsonRpcResponse;
}

export const rpcError = (id: Id | null, code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });
const rpcResult = (id: Id, result: unknown): McpReply => ({ status: 200, body: { jsonrpc: "2.0", id, result } });

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is Id => typeof v === "string" || (typeof v === "number" && Number.isInteger(v));

/** The client's protocol version when this server supports it, otherwise the latest one. */
export function negotiateVersion(requested: unknown): string {
  return PROTOCOL_VERSIONS.find((v) => v === requested) ?? LATEST_PROTOCOL_VERSION;
}

/** Answers one parsed JSON-RPC message. `api` reaches the HTTP API with the caller's keys. */
export async function handleMcpMessage(msg: unknown, api: ApiCall, tools: Tool[] = TOOLS): Promise<McpReply> {
  if (Array.isArray(msg)) return { status: 400, body: rpcError(null, JSONRPC.INVALID_REQUEST, "Batches are not supported; send one message per request") };
  if (!isObject(msg) || msg.jsonrpc !== "2.0") return { status: 400, body: rpcError(null, JSONRPC.INVALID_REQUEST, "Invalid JSON-RPC 2.0 message") };

  const hasId = "id" in msg;
  if (hasId && !isId(msg.id)) return { status: 400, body: rpcError(null, JSONRPC.INVALID_REQUEST, "id must be a string or an integer") };

  const isClientResponse = msg.method === undefined && hasId && ("result" in msg || "error" in msg);
  if (isClientResponse) return { status: 202 };
  if (typeof msg.method !== "string") return { status: 400, body: rpcError(hasId ? (msg.id as Id) : null, JSONRPC.INVALID_REQUEST, "method must be a string") };
  if (msg.params !== undefined && !isObject(msg.params))
    return { status: 400, body: rpcError(hasId ? (msg.id as Id) : null, JSONRPC.INVALID_REQUEST, "params must be an object") };
  if (!hasId) return { status: 202 };

  const id = msg.id as Id;
  const params = isObject(msg.params) ? msg.params : {};
  switch (msg.method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: negotiateVersion(params.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: { name: "datacat", title: "DataCat", version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: tools.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        })),
      });
    case "tools/call": {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return { status: 200, body: rpcError(id, JSONRPC.INVALID_PARAMS, `Unknown tool: ${String(params.name)}`) };
      return rpcResult(id, await callTool(tool, params.arguments, api));
    }
    default:
      return { status: 200, body: rpcError(id, JSONRPC.METHOD_NOT_FOUND, `Method not found: ${msg.method}`) };
  }
}

/**
 * Runs a tool. Bad arguments and API errors are tool results with isError (the model can read and fix them), not
 * JSON-RPC errors. Unexpected failures are logged and reported without detail. Arguments are never logged.
 */
export async function callTool(tool: Tool, rawArgs: unknown, api: ApiCall): Promise<{ content: { type: "text"; text: string }[]; isError: boolean }> {
  const started = Date.now();
  const text = (t: string, isError: boolean) => {
    logger.info({ tool: tool.name, ms: Date.now() - started, isError }, "mcp tool call");
    return { content: [{ type: "text" as const, text: capOutput(t) }], isError };
  };
  try {
    return text(await tool.run(checkArgs(tool.inputSchema, rawArgs), api), false);
  } catch (e) {
    if (e instanceof ToolError || e instanceof HttpError) return text(e.message, true);
    logger.error({ err: e, tool: tool.name }, "mcp tool failed");
    return text(`Internal error in ${tool.name}. Check the server logs.`, true);
  }
}
