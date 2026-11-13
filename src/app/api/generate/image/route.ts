import { after } from "next/server";
import { requireAdminJson } from "@/lib/admin";
import { IMAGE_WAIT_MS, pollTaskToRecord, runImageGeneration } from "@/lib/generate";
import { updateMediaRecord } from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/generate/image { prompt, aspect_ratio? }
 * Creates the KIE task, waits briefly for a snappy answer, then keeps polling in the
 * background (after the response) and updates the DB record — the history page picks it up.
 */
export async function POST(req: Request): Promise<Response> {
  const denied = await requireAdminJson();
  if (denied) return denied;

  let body: { prompt?: string; aspect_ratio?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "صيغة الطلب غير صالحة." }, { status: 400 });
  }
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return Response.json({ error: "الوصف (prompt) مطلوب." }, { status: 400 });

  try {
    const quickWaitMs = 15_000;
    const result = await runImageGeneration({
      prompt,
      aspectRatio: body.aspect_ratio,
      waitMs: quickWaitMs,
    });

    if (result.status === "processing") {
      const recordId = result.recordId;
      const taskId = result.taskId;
      after(async () => {
        try {
          await pollTaskToRecord(recordId, taskId ?? "", Math.max(IMAGE_WAIT_MS, 240_000));
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
