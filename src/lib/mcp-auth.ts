/**
 * Shared auth for the MCP endpoints (/api/mcp, /api/sse, /api/messages).
 * When MCP_SECRET is set, clients must send `Authorization: Bearer <secret>`
 * or `x-api-key: <secret>` or `?secret=<secret>`. When unset the endpoints are open.
 */
export function mcpAuthOk(req: Request): boolean {
  const secret = process.env.MCP_SECRET;
  if (!secret) return true;
  const auth = req.headers.get("authorization") ?? "";
  const apiKey = req.headers.get("x-api-key") ?? "";
  const urlSecret = new URL(req.url).searchParams.get("secret") ?? "";
  return auth === `Bearer ${secret}` || apiKey === secret || urlSecret === secret;
}

export function mcpUnauthorizedResponse(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: MCP_SECRET is set — send it via Authorization: Bearer <secret>." },
      id: null,
    }),
    { status: 401, headers: { "content-type": "application/json" } }
  );
}
