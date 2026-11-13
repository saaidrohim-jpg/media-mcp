import { requireAdminJson } from "@/lib/admin";
import { deleteMediaRecord, getMediaStats, listMediaRecords, type MediaType } from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/media?limit=120&type=image — dashboard history + stats. */
export async function GET(req: Request): Promise<Response> {
  const denied = await requireAdminJson();
  if (denied) return denied;
  try {
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get("limit") ?? 120);
    const typeParam = url.searchParams.get("type");
    const type = (["image", "video", "merge"] as const).find((t) => t === typeParam) as MediaType | undefined;
    const records = await listMediaRecords(Number.isFinite(limit) ? limit : 120, type);
    const stats = await getMediaStats();
    return Response.json({ records, stats });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}

/** DELETE /api/media?id=... — remove a record from history. */
export async function DELETE(req: Request): Promise<Response> {
  const denied = await requireAdminJson();
  if (denied) return denied;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return Response.json({ error: "معرف السجل مفقود." }, { status: 400 });
  await deleteMediaRecord(id);
  return Response.json({ ok: true });
}
