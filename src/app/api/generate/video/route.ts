import { after } from "next/server";
import { requireAdminJson } from "@/lib/admin";
import { VIDEO_WAIT_MS, pollTaskToRecord, runVideoGeneration } from "@/lib/generate";
import { updateMediaRecord } from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/generate/video { prompt, duration_seconds?, resolution?, image_url? }
 * Video generation takes minutes, so the call answers quickly and keeps polling in the
 * background; the history page shows the result as soon as it lands in the DB.
 */
export async function POST(req: Request): Promise<Response> {
  const denied = await requireAdminJson();
  if (denied) return denied;

  let body: { prompt?: string; duration_seconds?: number; resolution?: string; image_url?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "صيغة الطلب غير صالحة." }, { status: 400 });
  }
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return Response.json({ error: "الوصف (prompt) مطلوب." }, { status: 400 });

  try {
    const quickWaitMs = 20_000;
    const result = await runVideoGeneration({
      prompt,
      durationSeconds: body.duration_seconds ? Number(body.duration_seconds) : undefined,
      resolution: body.resolution,
      imageUrl: body.image_url,
      waitMs: quickWaitMs,
    });

    if (result.status === "processing") {
      const recordId = result.recordId;
      const taskId = result.taskId;
      after(async () => {
        try {
          await pollTaskToRecord(recordId, taskId ?? "", Math.max(VIDEO_WAIT_MS, 540_000));
        } catch (err) {
          await updateMediaRecord(recordId, { status: "failed", error: (err as Error).message }).catch(() => {});
        }
      });
    }

    return Response.json(result);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
