import { DEFAULT_VIDEO_DURATION, IMAGE_MODEL, kieCreateTask, kieGetRecord, VIDEO_MODEL } from "./kie";
import {
  createMediaRecord,
  getMediaRecord,
  updateMediaRecord,
  type MediaRecord,
  type MediaStatus,
} from "./media";

function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** How long a single MCP/dashboard call waits before answering "still processing". */
export const IMAGE_WAIT_MS = intEnv("IMAGE_WAIT_MS", 110_000);
export const VIDEO_WAIT_MS = intEnv("VIDEO_WAIT_MS", 110_000);
export const MERGE_WAIT_MS = intEnv("MERGE_WAIT_MS", 110_000);
const POLL_INTERVAL_MS = 5_000;

export type OpResult = {
  recordId: string;
  taskId: string | null;
  status: MediaStatus;
  urls: string[];
  error: string | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Snaps a requested duration to the nearest value the grok-imagine models accept (6 / 10 / 15). */
export function nearestVideoDuration(requested?: number): number {
  if (requested == null || !Number.isFinite(requested)) return DEFAULT_VIDEO_DURATION;
  const allowed = [6, 10, 15];
  const target = Math.max(1, Math.floor(requested));
  return allowed.reduce((best, v) => (Math.abs(v - target) < Math.abs(best - target) ? v : best), allowed[0]);
}

/** Polls KIE until the task succeeds/fails or the wait budget ends, keeping the DB record in sync. */
export async function pollTaskToRecord(
  recordId: string,
  taskId: string,
  waitMs: number
): Promise<{ status: MediaStatus; urls: string[]; error: string | null }> {
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const kieRec = await kieGetRecord(taskId);
    if (kieRec) {
      if (kieRec.state === "success" && kieRec.resultUrls.length > 0) {
        await updateMediaRecord(recordId, { status: "completed", urls: kieRec.resultUrls, error: null });
        return { status: "completed", urls: kieRec.resultUrls, error: null };
      }
      if (kieRec.state === "fail") {
        const message = kieRec.failMsg || "فشل توليد المهمة عند المزود (KIE).";
        await updateMediaRecord(recordId, { status: "failed", error: message });
        return { status: "failed", urls: [], error: message };
      }
    }
    if (Date.now() >= deadline) {
      const current = await getMediaRecord(recordId);
      return { status: current?.status ?? "processing", urls: current?.urls ?? [], error: current?.error ?? null };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

function toOpResult(record: MediaRecord, r: { status: MediaStatus; urls: string[]; error: string | null }): OpResult {
  return { recordId: record.id, taskId: record.task_id, status: r.status, urls: r.urls, error: r.error };
}

export async function runImageGeneration(opts: {
  prompt: string;
  aspectRatio?: string;
  waitMs?: number;
}): Promise<OpResult> {
  const input: Record<string, unknown> = { prompt: opts.prompt };
  if (opts.aspectRatio && opts.aspectRatio !== "auto") input.aspect_ratio = opts.aspectRatio;
  const taskId = await kieCreateTask(IMAGE_MODEL, input);
  const record = await createMediaRecord({
    type: "image",
    model: IMAGE_MODEL,
    prompt: opts.prompt,
    taskId,
    meta: { aspect_ratio: opts.aspectRatio ?? "auto" },
  });
  const r = await pollTaskToRecord(record.id, taskId, opts.waitMs ?? IMAGE_WAIT_MS);
  return toOpResult(record, r);
}

export async function runVideoGeneration(opts: {
  prompt: string;
  durationSeconds?: number;
  resolution?: string;
  imageUrl?: string;
  waitMs?: number;
}): Promise<OpResult> {
  const duration = nearestVideoDuration(opts.durationSeconds);
  const input: Record<string, unknown> = { prompt: opts.prompt, duration: String(duration) };
  if (opts.resolution) input.resolution = opts.resolution;
  if (opts.imageUrl) input.image_urls = [opts.imageUrl];
  const taskId = await kieCreateTask(VIDEO_MODEL, input);
  const record = await createMediaRecord({
    type: "video",
    model: VIDEO_MODEL,
    prompt: opts.prompt,
    taskId,
    meta: {
      duration_seconds: duration,
      resolution: opts.resolution ?? "480p",
      image_to_video: Boolean(opts.imageUrl),
    },
  });
  const r = await pollTaskToRecord(record.id, taskId, opts.waitMs ?? VIDEO_WAIT_MS);
  return toOpResult(record, r);
}

/** Refreshes a record from KIE once (short poll) — used by the check_task tool. */
export async function refreshRecordFromKie(record: MediaRecord, waitMs = 25_000): Promise<MediaRecord> {
  if (record.status === "processing" && record.task_id && (record.type === "image" || record.type === "video")) {
    await pollTaskToRecord(record.id, record.task_id, waitMs);
    const fresh = await getMediaRecord(record.id);
    if (fresh) return fresh;
  }
  return record;
}

export function formatRecordSummary(rec: MediaRecord): string {
  const lines: string[] = [];
  const typeLabel = rec.type === "image" ? "صورة" : rec.type === "video" ? "فيديو" : "فيديو مدمج";
  lines.push(`النوع: ${typeLabel}`);
  lines.push(`الحالة: ${rec.status === "completed" ? "مكتمل ✅" : rec.status === "processing" ? "قيد المعالجة ⏳" : "فشل ❌"}`);
  if (rec.model) lines.push(`الموديل: ${rec.model}`);
  if (rec.prompt) lines.push(`الوصف: ${rec.prompt.slice(0, 300)}`);
  if (rec.task_id) lines.push(`Task ID: ${rec.task_id}`);
  if (rec.urls.length > 0) lines.push(`الروابط:\n${rec.urls.join("\n")}`);
  if (rec.error) lines.push(`الخطأ: ${rec.error}`);
  return lines.join("\n");
}
