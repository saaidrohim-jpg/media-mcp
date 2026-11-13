import { ensureSchema, getDb } from "./db";

export const KIE_BASE = process.env.KIE_BASE_URL || "https://api.kie.ai";
export const KIE_UPLOAD_BASE = process.env.KIE_UPLOAD_BASE_URL || "https://kieai.redpandaai.co";

/** HTTP / API codes that mean the key is dead (no balance, invalid, rate-limited). */
const EXHAUSTED_HTTP = new Set([401, 402, 403, 429]);
const EXHAUSTED_MSG = [
  /insufficient/i,
  /balance/i,
  /quota/i,
  /exceed/i,
  /unauthorized/i,
  /invalid\s*(api\s*)?key/i,
  /invalid\s*token/i,
  /无效/,
  /欠费/,
];

/** Validation errors mean the payload is wrong — retrying with another key will not help. */
const VALIDATION_MSG = /required|cannot be empty|invalid param|参数|parameter|field|unsupported/i;
/** Missing task / not found errors should also stop immediately. */
const NOT_FOUND_MSG = /is null|not found/i;

export class KieError extends Error {
  httpStatus: number;
  apiCode: number;
  constructor(message: string, httpStatus = 0, apiCode = 0) {
    super(message);
    this.name = "KieError";
    this.httpStatus = httpStatus;
    this.apiCode = apiCode;
  }
}

export function maskKey(key: string): string {
  if (key.length <= 10) return "****";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export type ActiveKey = { id: string; name: string; apiKey: string };

/** Active keys ordered by insertion time — key #1 is tried first (auto-fallback/rotation). */
export async function getActiveKeys(): Promise<ActiveKey[]> {
  await ensureSchema();
  const res = await getDb().execute(
    "SELECT id, name, api_key FROM api_keys WHERE status = 'active' ORDER BY created_at ASC, rowid ASC"
  );
  return res.rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    apiKey: String(r.api_key),
  }));
}

async function markKey(
  id: string,
  fields: { status?: string; usageInc?: number; failInc?: number; touch?: boolean }
): Promise<void> {
  const sets: string[] = [];
  const args: (string | number)[] = [];
  if (fields.status) {
    sets.push("status = ?");
    args.push(fields.status);
  }
  if (fields.usageInc) {
    sets.push("usage_count = usage_count + ?");
    args.push(fields.usageInc);
  }
  if (fields.failInc) {
    sets.push("fail_count = fail_count + ?");
    args.push(fields.failInc);
  }
  if (sets.length === 0 && !fields.touch) return;
  sets.push("last_used_at = datetime('now')");
  args.push(id);
  try {
    await getDb().execute({ sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`, args });
  } catch {
    // bookkeeping failures must never break the request
  }
}

export type KieJson = {
  code?: number;
  msg?: string;
  message?: string;
  success?: boolean;
  data?: Record<string, unknown>;
};

/**
 * Calls a KIE.ai endpoint on api.kie.ai with automatic key rotation:
 * exhausted/invalid keys are marked in the DB and the next active key is tried immediately.
 */
export async function kieRequest(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {}
): Promise<KieJson> {
  const keys = await getActiveKeys();
  if (keys.length === 0) {
    throw new KieError("لا يوجد مفتاح KIE API نشط. أضف مفتاحاً من لوحة التحكم أو عبر متغير KIE_API_KEY.");
  }
  let lastError: KieError | null = null;

  for (const key of keys) {
    try {
      const res = await fetch(`${KIE_BASE}${path}`, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${key.apiKey}`,
          Accept: "application/json",
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });

      let json: KieJson = {};
      try {
        json = (await res.json()) as KieJson;
      } catch {
        // non-JSON response
      }
      const code = Number(json.code ?? 0);
      const msg = String(json.msg || json.message || "");
      const httpStatus = res.status;

      // 1) Key is dead → mark exhausted, fall through to the next key.
      if (EXHAUSTED_HTTP.has(httpStatus) || EXHAUSTED_HTTP.has(code) || EXHAUSTED_MSG.some((re) => re.test(msg))) {
        await markKey(key.id, { status: "exhausted", failInc: 1 });
        lastError = new KieError(
          `المفتاح «${key.name}» (${maskKey(key.apiKey)}) نفد رصيده أو غير مصرّح (${msg || `HTTP ${httpStatus}`}). تم الانتقال تلقائياً للمفتاح التالي.`,
          httpStatus,
          code
        );
        continue;
      }

      // 2) Payload problems → do not burn the remaining keys.
      if (VALIDATION_MSG.test(msg) || NOT_FOUND_MSG.test(msg)) {
        await markKey(key.id, { touch: true });
        throw new KieError(`خطأ في الطلب من KIE: ${msg || `HTTP ${httpStatus}`}`, httpStatus, code);
      }

      // 3) Server-side failure → try the next key.
      if (httpStatus >= 500 || code >= 500) {
        await markKey(key.id, { failInc: 1 });
        lastError = new KieError(
          `خطأ في خادم KIE (HTTP ${httpStatus}${code ? `, code ${code}` : ""}): ${msg || "غير معروف"}`,
          httpStatus,
          code
        );
        continue;
      }

      // 4) Any other client error → try next key but remember the error.
      if (!res.ok || (code !== 0 && code !== 200)) {
        await markKey(key.id, { failInc: 1 });
        lastError = new KieError(
          `خطأ من KIE (HTTP ${httpStatus}${code ? `, code ${code}` : ""}): ${msg || "غير معروف"}`,
          httpStatus,
          code
        );
        continue;
      }

      await markKey(key.id, { usageInc: 1 });
      return json;
    } catch (err) {
      if (err instanceof KieError && err.httpStatus > 0 && err.apiCode >= 400 && err.apiCode < 500 && !EXHAUSTED_HTTP.has(err.apiCode)) {
        throw err; // validation / not-found errors are fatal for this request
      }
      if (err instanceof KieError && /خطأ في الطلب/.test(err.message)) throw err;
      await markKey(key.id, { failInc: 1 });
      lastError = new KieError(`تعذر الاتصال بـ KIE باستخدام المفتاح «${key.name}»: ${(err as Error).message}`);
    }
  }

  throw lastError ?? new KieError("فشل تنفيذ الطلب عبر جميع المفاتيح النشطة.");
}

/**
 * Uploads a file to KIE storage (kieai.redpandaai.co) with key rotation and returns the permanent direct URL.
 * Endpoint: POST /api/file-stream-upload (multipart/form-data: file, fileName, uploadPath).
 */
export async function kieUploadFile(
  bytes: Uint8Array,
  fileName: string,
  uploadPath: string,
  mime: string
): Promise<string> {
  const keys = await getActiveKeys();
  if (keys.length === 0) {
    throw new KieError("لا يوجد مفتاح KIE API نشط لرفع الملف.");
  }
  let lastError: Error | null = null;

  for (const key of keys) {
    try {
      const form = new FormData();
      form.append("file", new Blob([bytes as unknown as BlobPart], { type: mime }), fileName);
      form.append("fileName", fileName);
      form.append("uploadPath", uploadPath);

      const res = await fetch(`${KIE_UPLOAD_BASE}/api/file-stream-upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(280_000),
      });
      const json = (await res.json().catch(() => ({}))) as KieJson & { data?: { downloadUrl?: string } };
      const msg = String(json.msg || json.message || "");

      if (EXHAUSTED_HTTP.has(res.status) || EXHAUSTED_MSG.some((re) => re.test(msg))) {
        await markKey(key.id, { status: "exhausted", failInc: 1 });
        lastError = new KieError(`المفتاح «${key.name}» نفد رصيده أثناء رفع الملف (${msg || res.status}).`);
        continue;
      }
      if (!res.ok || json.success === false) {
        await markKey(key.id, { failInc: 1 });
        lastError = new KieError(`فشل رفع الملف إلى تخزين KIE: ${msg || `HTTP ${res.status}`}`, res.status);
        continue;
      }
      const url = json?.data?.downloadUrl;
      if (!url) {
        throw new KieError("لم يُرجع KIE رابط التنزيل بعد رفع الملف.");
      }
      await markKey(key.id, { usageInc: 1 });
      return String(url);
    } catch (err) {
      if (err instanceof KieError && err.message.includes("لم يُرجع KIE")) throw err;
      await markKey(key.id, { failInc: 1 });
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new KieError("فشل رفع الملف عبر جميع المفاتيح النشطة.");
}
