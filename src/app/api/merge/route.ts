import { requireAdminJson } from "@/lib/admin";
import { runMergeWithRecord } from "@/lib/mcp-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/merge { urls: [videoUrl, ...] }
 * Runs ffmpeg synchronously (within the function's maxDuration budget) and returns the
 * merged MP4 direct URL; the run is also stored in the history via runMergeWithRecord.
 */
export async function POST(req: Request): Promise<Response> {
  const denied = await requireAdminJson();
  if (denied) return denied;

  let body: { urls?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "صيغة الطلب غير صالحة." }, { status: 400 });
  }
  const rawUrls = Array.isArray(body.urls) ? body.urls : [];
  const urls = rawUrls.map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u));
  if (urls.length < 2) {
    return Response.json({ error: "يلزم رابطا فيديو مباشران على الأقل." }, { status: 400 });
  }
  if (urls.length > 10) {
    return Response.json({ error: "الحد الأقصى 10 روابط في المرة الواحدة." }, { status: 400 });
  }

  try {
    const outcome = await runMergeWithRecord(urls, "dashboard");
    if (outcome.error) {
      return Response.json({ error: outcome.error, recordId: outcome.recordId }, { status: 502 });
    }
    return Response.json(outcome);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
