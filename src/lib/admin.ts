import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const ADMIN_COOKIE = "admin_session";

/** SHA-256 of the configured ADMIN_PASSWORD (null when no password is configured). */
export function adminHash(): string | null {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return null;
  return createHash("sha256").update(`media-mcp:${password}`).digest("hex");
}

/** True when the dashboard may be used: either no password is configured, or the cookie matches. */
export async function isAdmin(): Promise<boolean> {
  const hash = adminHash();
  if (!hash) return true;
  const store = await cookies();
  const value = store.get(ADMIN_COOKIE)?.value ?? "";
  if (!value) return false;
  try {
    return timingSafeEqual(Buffer.from(value, "utf8"), Buffer.from(hash, "utf8"));
  } catch {
    return false;
  }
}

/** Returns a 401 JSON response when not authorized, otherwise null. */
export async function requireAdminJson(): Promise<Response | null> {
  if (await isAdmin()) return null;
  return new Response(JSON.stringify({ error: "غير مصرح — سجّل الدخول من لوحة التحكم أولاً." }), {
    status: 401,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
