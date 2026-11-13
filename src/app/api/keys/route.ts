import { ensureSchema, getDb } from "@/lib/db";
import { requireAdminJson } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type KeyRow = Record<string, unknown>;

function maskKey(key: string): string {
  if (key.length <= 10) return "****";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function rowToKey(r: KeyRow) {
  const fullKey = String(r.api_key ?? "");
  return {
    id: String(r.id),
    name: String(r.name ?? ""),
    masked_key: maskKey(fullKey),
    status: String(r.status ?? "active"),
    usage_count: Number(r.usage_count ?? 0),
    fail_count: Number(r.fail_count ?? 0),
    last_used_at: r.last_used_at == null ? null : String(r.last_used_at),
    created_at: String(r.created_at ?? ""),
  };
}

/** GET /api/keys — list keys (masked). */
export async function GET(): Promise<Response> {
  const denied = await requireAdminJson();
  if (denied) return denied;
  await ensureSchema();
  const res = await getDb().execute("SELECT * FROM api_keys ORDER BY created_at ASC, rowid ASC");
  const keys = res.rows.map(rowToKey);
  return Response.json({ keys });
}

/** POST /api/keys — add a new KIE API key { name, api_key }. */
export async function POST(req: Request): Promise<Response> {
  const denied = await requireAdminJson();
  if (denied) return denied;
  await ensureSchema();

  let body: { name?: string; api_key?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "صيغة الطلب غير صالحة." }, { status: 400 });
  }
  const name = String(body.name ?? "").trim() || "مفتاح بدون اسم";
  const apiKey = String(body.api_key ?? "").trim();
  if (apiKey.length < 8) {
    return Response.json({ error: "مفتاح API غير صالح — يجب أن يكون طويلاً بما يكفي." }, { status: 400 });
  }

  const id = crypto.randomUUID();
  await getDb().execute({
    sql: `INSERT INTO api_keys (id, name, api_key, status, usage_count, fail_count, created_at)
          VALUES (?, ?, ?, 'active', 0, 0, datetime('now'))`,
    args: [id, name, apiKey],
  });
  return Response.json({ ok: true, id });
}

/** PATCH /api/keys — change key status { id, status } where status ∈ active|disabled|exhausted. */
export async function PATCH(req: Request): Promise<Response> {
  const denied = await requireAdminJson();
  if (denied) return denied;
  await ensureSchema();

  let body: { id?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "صيغة الطلب غير صالحة." }, { status: 400 });
  }
  const id = String(body.id ?? "");
  const status = String(body.status ?? "");
  if (!id || !["active", "disabled", "exhausted"].includes(status)) {
    return Response.json({ error: "معرف أو حالة غير صالحة." }, { status: 400 });
  }
  await getDb().execute({ sql: "UPDATE api_keys SET status = ?, fail_count = 0 WHERE id = ?", args: [status, id] });
  return Response.json({ ok: true });
}

/** DELETE /api/keys?id=... — remove a key. */
export async function DELETE(req: Request): Promise<Response> {
  const denied = await requireAdminJson();
  if (denied) return denied;
  await ensureSchema();
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return Response.json({ error: "معرف المفتاح مفقود." }, { status: 400 });
  await getDb().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
  return Response.json({ ok: true });
}
