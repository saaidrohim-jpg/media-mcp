import { ensureSchema, getDb } from "./db";

export type MediaType = "image" | "video" | "merge";
export type MediaStatus = "processing" | "completed" | "failed";

export type MediaRecord = {
  id: string;
  type: MediaType;
  model: string | null;
  prompt: string | null;
  task_id: string | null;
  status: MediaStatus;
  urls: string[];
  meta: Record<string, unknown>;
  error: string | null;
  created_at: string;
  updated_at: string | null;
};

type Row = Record<string, unknown>;

function rowToRecord(r: Row): MediaRecord {
  let urls: string[] = [];
  try {
    const parsed = JSON.parse(String(r.urls ?? "[]"));
    if (Array.isArray(parsed)) urls = parsed.map(String).filter(Boolean);
  } catch {
    urls = [];
  }
  let meta: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(r.meta ?? "{}"));
    if (parsed && typeof parsed === "object") meta = parsed as Record<string, unknown>;
  } catch {
    meta = {};
  }
  return {
    id: String(r.id),
    type: String(r.type) as MediaType,
    model: r.model == null ? null : String(r.model),
    prompt: r.prompt == null ? null : String(r.prompt),
    task_id: r.task_id == null ? null : String(r.task_id),
    status: String(r.status) as MediaStatus,
    urls,
    meta,
    error: r.error == null ? null : String(r.error),
    created_at: String(r.created_at ?? ""),
    updated_at: r.updated_at == null ? null : String(r.updated_at),
  };
}

export async function createMediaRecord(input: {
  type: MediaType;
  model?: string;
  prompt?: string;
  taskId?: string;
  status?: MediaStatus;
  urls?: string[];
  meta?: Record<string, unknown>;
}): Promise<MediaRecord> {
  await ensureSchema();
  const id = crypto.randomUUID();
  await getDb()
    .execute({
      sql: `INSERT INTO media_records (id, type, model, prompt, task_id, status, urls, meta, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      args: [
        id,
        input.type,
        input.model ?? null,
        input.prompt ?? null,
        input.taskId ?? null,
        input.status ?? "processing",
        JSON.stringify(input.urls ?? []),
        JSON.stringify(input.meta ?? {}),
      ],
    })
    .catch((err) => {
      throw new Error(`تعذر حفظ السجل في قاعدة البيانات: ${(err as Error).message}`);
    });
  const rec = await getMediaRecord(id);
  if (!rec) throw new Error("فُقد السجل بعد الإنشاء مباشرة.");
  return rec;
}

export async function updateMediaRecord(
  id: string,
  patch: { status?: MediaStatus; urls?: string[]; error?: string | null; meta?: Record<string, unknown>; taskId?: string }
): Promise<void> {
  await ensureSchema();
  const sets: string[] = [];
  const args: (string | null)[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
  }
  if (patch.urls !== undefined) {
    sets.push("urls = ?");
    args.push(JSON.stringify(patch.urls));
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    args.push(patch.error);
  }
  if (patch.meta !== undefined) {
    sets.push("meta = ?");
    args.push(JSON.stringify(patch.meta));
  }
  if (patch.taskId !== undefined) {
    sets.push("task_id = ?");
    args.push(patch.taskId);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  args.push(id);
  await getDb().execute({ sql: `UPDATE media_records SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function getMediaRecord(id: string): Promise<MediaRecord | null> {
  await ensureSchema();
  const res = await getDb().execute({ sql: "SELECT * FROM media_records WHERE id = ? LIMIT 1", args: [id] });
  return res.rows[0] ? rowToRecord(res.rows[0]) : null;
}

export async function getMediaRecordByTask(taskId: string): Promise<MediaRecord | null> {
  await ensureSchema();
  const res = await getDb().execute({
    sql: "SELECT * FROM media_records WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
    args: [taskId],
  });
  return res.rows[0] ? rowToRecord(res.rows[0]) : null;
}

export async function listMediaRecords(limit = 120, type?: MediaType): Promise<MediaRecord[]> {
  await ensureSchema();
  const cap = Math.min(Math.max(1, Math.floor(limit)), 300);
  const res = type
    ? await getDb().execute({
        sql: "SELECT * FROM media_records WHERE type = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
        args: [type, cap],
      })
    : await getDb().execute({ sql: "SELECT * FROM media_records ORDER BY created_at DESC, rowid DESC LIMIT ?", args: [cap] });
  return res.rows.map(rowToRecord);
}

export async function deleteMediaRecord(id: string): Promise<void> {
  await ensureSchema();
  await getDb().execute({ sql: "DELETE FROM media_records WHERE id = ?", args: [id] });
}

export type MediaStats = {
  total: number;
  completed: number;
  processing: number;
  failed: number;
  images: number;
  videos: number;
  merges: number;
};

export async function getMediaStats(): Promise<MediaStats> {
  await ensureSchema();
  const res = await getDb().execute("SELECT type, status, COUNT(*) AS c FROM media_records GROUP BY type, status");
  const stats: MediaStats = { total: 0, completed: 0, processing: 0, failed: 0, images: 0, videos: 0, merges: 0 };
  for (const row of res.rows) {
    const c = Number(row.c ?? 0);
    stats.total += c;
    const type = String(row.type);
    const status = String(row.status);
    if (type === "image") stats.images += c;
    if (type === "video") stats.videos += c;
    if (type === "merge") stats.merges += c;
    if (status === "completed") stats.completed += c;
    if (status === "processing") stats.processing += c;
    if (status === "failed") stats.failed += c;
  }
  return stats;
}
