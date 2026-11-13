import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer } from "@/lib/mcp-server";
import { mcpAuthOk, mcpUnauthorizedResponse } from "@/lib/mcp-auth";

/**
 * MCP Streamable HTTP endpoint (the modern transport used by ChatGPT connectors & MCP clients).
 * Stateless: every POST builds a fresh server+transport and answers with plain JSON.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function jsonError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(req: Request): Promise<Response> {
  if (!mcpAuthOk(req)) return mcpUnauthorizedResponse();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, -32700, "Parse error: invalid JSON body");
  }

  // Per-request stateless server (recommended pattern for serverless platforms).
  const server = buildMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session ids
    enableJsonResponse: true, // plain JSON responses (no SSE stream needed)
  });

  // Clean up as soon as the response finishes.
  req.signal.addEventListener(
    "abort",
    () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    },
    { once: true }
  );

  await server.connect(transport);
  try {
    // Body was already consumed for validation — hand the parsed JSON to the transport.
    return await transport.handleRequest(req, { parsedBody: body });
  } catch (err) {
    return jsonError(500, -32603, `Internal error: ${(err as Error).message}`);
  } finally {
    void server.close().catch(() => {});
  }
}

// The stateless server does not support server-initiated SSE streams on GET.
export async function GET(): Promise<Response> {
  return jsonError(405, -32000, "Method Not Allowed: POST JSON-RPC messages to /api/mcp.");
}

export async function DELETE(): Promise<Response> {
  return jsonError(405, -32000, "Method Not Allowed: no sessions to terminate (stateless server).");
}
