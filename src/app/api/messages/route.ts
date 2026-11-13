import { mcpAuthOk, mcpUnauthorizedResponse } from "@/lib/mcp-auth";
import { createNodeAdapter } from "@/lib/node-adapter";
import { getSseTransport } from "@/lib/sse-sessions";

/**
 * POST target for the legacy SSE transport: /api/messages?sessionId=...
 * Validates the session, feeds the JSON-RPC message into the SSE transport (202),
 * and the actual reply travels back over the open GET /api/sse stream.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  if (!mcpAuthOk(req)) return mcpUnauthorizedResponse();

  const sessionId = new URL(req.url).searchParams.get("sessionId") ?? "";
  const transport = sessionId ? getSseTransport(sessionId) : undefined;
  if (!transport) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found — open GET /api/sse again to start a new session." },
        id: null,
      }),
      { status: 404, headers: { "content-type": "application/json" } }
    );
  }

  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const { req: nodeReq, res: nodeRes, done } = createNodeAdapter(req, bodyText);
  try {
    await transport.handlePostMessage(nodeReq, nodeRes, parsed);
    await done;
  } catch (err) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: `Internal error: ${(err as Error).message}` }, id: null }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  return nodeRes.toWebResponse();
}
