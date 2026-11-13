import type { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

/**
 * In-memory registry of live legacy-SSE sessions.
 * NOTE: on serverless platforms this map lives per warm instance, so the SSE transport
 * is best-effort; the Streamable HTTP endpoint (/api/mcp) is the reliable one.
 */
const transports = new Map<string, SSEServerTransport>();

export function registerSseTransport(transport: SSEServerTransport): void {
  transports.set(transport.sessionId, transport);
}

export function removeSseTransport(sessionId: string): void {
  transports.delete(sessionId);
}

export function getSseTransport(sessionId: string): SSEServerTransport | undefined {
  return transports.get(sessionId);
}
