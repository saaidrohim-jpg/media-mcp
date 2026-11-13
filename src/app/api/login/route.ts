import { cookies } from "next/headers";
import { ADMIN_COOKIE, adminHash } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/login { password } — sets the admin session cookie. */
export async function POST(req: Request): Promise<Response> {
  const hash = adminHash();
  if (!hash) {
    return Response.json({ ok: true, open: true, message: "لا توجد كلمة مرور مضبوطة — اللوحة مفتوحة." });
  }
  let body: { password?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "صيغة الطلب غير صالحة." }, { status: 400 });
  }
  if (String(body.password ?? "") !== (process.env.ADMIN_PASSWORD ?? "")) {
    return Response.json({ error: "كلمة المرور غير صحيحة." }, { status: 401 });
  }
  const store = await cookies();
  store.set(ADMIN_COOKIE, hash, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
  return Response.json({ ok: true });
}

/** DELETE /api/login — logout (clears the cookie). */
export async function DELETE(): Promise<Response> {
  const store = await cookies();
  store.delete(ADMIN_COOKIE);
  return Response.json({ ok: true });
}
