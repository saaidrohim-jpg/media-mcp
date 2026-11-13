import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createNodeAdapter } from "@/lib/node-adapter";
import { buildMcpServer } from "@/lib/mcp-server";
import { mcpAuthOk, mcpUnauthorizedResponse } from "@/lib/mcp-auth";
import { registerSseTransport, removeSseTransport } from "@/lib/sse-sessions";

/**
 * Legacy MCP "HTTP + SSE" transport endpoint.
 * 1) Client opens GET /api/sse → server replies with an `endpoint` event pointing to /api/messages?sessionId=...
 * 2) Client POSTs JSON-RPC messages to that endpoint; replies arrive over the SSE stream.
 * Prefer /api/mcp (Streamable HTTP) on serverless platforms.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!mcpAuthOk(req)) return mcpUnauthorizedResponse();

  const { req: nodeReq, res: nodeRes } = createNodeAdapter(req);
  const server = buildMcpServer();
  const transport = new SSEServerTransport("/api/messages", nodeRes);
  registerSseTransport(transport);

  nodeReq.on("close", () => {
    removeSseTransport(transport.sessionId);
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  });

  await server.connect(transport);

  // Return the streaming response immediately — it stays open until the client disconnects.
  return nodeRes.toWebResponse();
}
