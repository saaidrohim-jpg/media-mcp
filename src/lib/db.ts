import { createClient, type Client } from "@libsql/client";

let client: Client | null = null;
let schemaPromise: Promise<void> | null = null;

/** Returns the shared Turso (libSQL) client. Throws a friendly error when env vars are missing. */
export function getDb(): Client {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    throw new Error(
      "متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN غير مضبوطة. أضفهما في إعدادات Vercel ثم أعد النشر."
    );
  }
  if (!client) {
    client = createClient({ url, authToken });
  }
  return client;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    api_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    usage_count INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS media_records (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    model TEXT,
    prompt TEXT,
    task_id TEXT,
    status TEXT NOT NULL DEFAULT 'processing',
    urls TEXT NOT NULL DEFAULT '[]',
    meta TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
  )`,
];

/** Creates tables if missing and seeds the default KIE key (from env) when the keys table is empty. Runs once per process. */
export async function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = getDb();
      for (const stmt of SCHEMA_STATEMENTS) {
        await db.execute(stmt);
      }
      const defaultKey = process.env.KIE_API_KEY;
      if (defaultKey) {
        const count = await db.execute("SELECT COUNT(*) AS c FROM api_keys");
        if (Number(count.rows[0]?.c ?? 0) === 0) {
          await db.execute({
            sql: `INSERT INTO api_keys (id, name, api_key, status, usage_count, fail_count, created_at)
                  VALUES (?, ?, ?, 'active', 0, 0, datetime('now'))`,
            args: [crypto.randomUUID(), "المفتاح الافتراضي (من متغيرات البيئة)", defaultKey],
          });
        }
      }
    })().catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}
