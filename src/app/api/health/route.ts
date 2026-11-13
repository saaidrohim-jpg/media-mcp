import { getActiveKeys } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/health — lightweight health probe. */
export async function GET(): Promise<Response> {
  let keys = -1;
  let dbOk = true;
  try {
    keys = (await getActiveKeys()).length;
  } catch {
    dbOk = false;
  }
  return Response.json({
    ok: dbOk,
    service: "media-mcp-studio",
    active_keys: keys,
    time: new Date().toISOString(),
  });
}
