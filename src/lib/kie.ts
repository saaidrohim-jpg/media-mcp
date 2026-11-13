import { KieError, kieRequest, type KieJson } from "./keys";

export const IMAGE_MODEL = process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image";
export const VIDEO_MODEL = process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview";

function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Default video length in seconds — the grok-imagine models accept 6 / 10 / 15. */
export const DEFAULT_VIDEO_DURATION = [6, 10, 15].includes(intEnv("VIDEO_DURATION_SECONDS", 15))
  ? intEnv("VIDEO_DURATION_SECONDS", 15)
  : 15;

export type KieRecord = {
  taskId: string;
  state: string; // waiting | queuing | generating | success | fail
  resultUrls: string[];
  failMsg?: string;
};

/** Creates a generation task via the unified jobs API and returns the taskId. */
export async function kieCreateTask(model: string, input: Record<string, unknown>): Promise<string> {
  const json: KieJson = await kieRequest("/api/v1/jobs/createTask", {
    method: "POST",
    body: { model, input },
  });
  const taskId = json?.data?.taskId;
  if (!taskId) {
    throw new KieError(`لم يُرجع KIE معرف المهمة. الاستجابة: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return String(taskId);
}

/**
 * Fetches a task record from GET /api/v1/jobs/recordInfo?taskId=...
 * Returns null when the task does not exist (KIE answers 422 "recordInfo is null").
 */
export async function kieGetRecord(taskId: string): Promise<KieRecord | null> {
  let json: KieJson;
  try {
    json = await kieRequest(`/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`);
  } catch (err) {
    if (/is null|not found/i.test((err as Error).message)) return null;
    throw err;
  }
  const d = json?.data as Record<string, unknown> | undefined;
  if (!d) return null;

  let urls: string[] = [];
  try {
    const parsed = JSON.parse(String(d.resultJson ?? "{}")) as { resultUrls?: unknown; resultUrl?: unknown };
    const arr = parsed?.resultUrls ?? parsed?.resultUrl ?? [];
    urls = (Array.isArray(arr) ? arr : [arr]).map((u) => String(u)).filter(Boolean);
  } catch {
    urls = [];
  }

  const failMsg = [d.failCode, d.failMsg].filter(Boolean).join(": ") || undefined;
  return {
    taskId: String(d.taskId ?? taskId),
    state: String(d.state ?? "unknown").toLowerCase(),
    resultUrls: urls,
    failMsg,
  };
}
