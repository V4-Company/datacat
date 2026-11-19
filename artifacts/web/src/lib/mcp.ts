import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

/** Contract of GET /api/ui/mcp/info. */
export interface McpInfo {
  endpoint: string;
  server_name: string;
  tools: { name: string; description: string }[];
}

/** A personal MCP token as listed by GET /api/ui/mcp/tokens (the value is never returned). */
export interface McpToken {
  id: number;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

/** Response of POST /api/ui/mcp/tokens: the only time the token value is visible. */
export interface CreatedMcpToken {
  id: number;
  name: string;
  created_at: string;
  token: string;
}

export const MCP_TOKEN_NAME_MAX = 60;
export const TOKEN_PLACEHOLDER = "<YOUR_TOKEN>";

const mcpKeys = {
  info: ["mcp", "info"] as const,
  tokens: ["mcp", "tokens"] as const,
};

export function useMcpInfo() {
  return useQuery({ queryKey: mcpKeys.info, queryFn: () => api<McpInfo>("/ui/mcp/info"), staleTime: 5 * 60_000 });
}

export function useMcpTokens() {
  return useQuery({ queryKey: mcpKeys.tokens, queryFn: () => api<{ tokens: McpToken[] }>("/ui/mcp/tokens") });
}

export function useCreateMcpToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api<CreatedMcpToken>("/ui/mcp/tokens", { body: name ? { name } : {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: mcpKeys.tokens }),
  });
}

export function useRevokeMcpToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<{ ok: true }>(`/ui/mcp/tokens/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: mcpKeys.tokens }),
  });
}

/** A readable default token name, e.g. "Claude Code on macOS". */
export function defaultTokenName(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const os = /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `Claude Code on ${os}` : "Claude Code";
}

/** Install snippets for the given endpoint and token (or the placeholder before a token exists). */
export function mcpSnippets(endpoint: string, server: string, token: string) {
  const auth = `Authorization: Bearer ${token}`;
  return {
    claude: `claude mcp add --transport http ${server} ${endpoint} --header "${auth}"`,
    claudeUser: `claude mcp add --transport http --scope user ${server} ${endpoint} --header "${auth}"`,
    json: JSON.stringify({ mcpServers: { [server]: { type: "http", url: endpoint, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
    curl: `curl -X POST ${endpoint} \\
  -H 'Content-Type: application/json' \\
  -H 'Accept: application/json, text/event-stream' \\
  -H '${auth}' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  };
}
