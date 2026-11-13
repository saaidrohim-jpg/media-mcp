"use client";

import { useCallback, useEffect, useState } from "react";

type MediaRecord = {
  id: string;
  type: "image" | "video" | "merge";
  model: string | null;
  prompt: string | null;
  task_id: string | null;
  status: "processing" | "completed" | "failed";
  urls: string[];
  meta: Record<string, unknown>;
  error: string | null;
  created_at: string;
  updated_at: string | null;
};

type Filter = "all" | "image" | "video" | "merge";

const TYPE_LABEL: Record<MediaRecord["type"], string> = {
  image: "🖼️ صورة",
  video: "🎬 فيديو",
  merge: "🧩 دمج",
};

function fmtDate(sqliteUtc: string): string {
  try {
    const d = new Date(sqliteUtc.replace(" ", "T") + (sqliteUtc.endsWith("Z") ? "" : "Z"));
    return d.toLocaleString("ar", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return sqliteUtc;
  }
}

function statusBadge(status: MediaRecord["status"]) {
  if (status === "completed") return <span className="badge ok">مكتمل</span>;
  if (status === "processing") return <span className="badge warn">قيد المعالجة</span>;
  return <span className="badge bad">فشل</span>;
}

export default function HistoryGallery() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [records, setRecords] = useState<MediaRecord[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch("/api/media?limit=200");
    if (res.status === 401) {
      setAuthed(false);
      setLoading(false);
      return;
    }
    const data = await res.json();
    setRecords(data.records ?? []);
    setAuthed(true);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // auto-refresh while any record is still processing
  useEffect(() => {
    if (!records.some((r) => r.status === "processing")) return;
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [records, load]);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setLoginError(null);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      setPassword("");
      await load();
    } else {
      const data = await res.json().catch(() => ({}));
      setLoginError(data.error ?? "فشل تسجيل الدخول.");
    }
  }

  async function remove(id: string) {
    await fetch(`/api/media?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    await load();
  }

  if (authed === false) {
    return (
      <div className="login-box panel">
        <h2>تسجيل دخول لعرض السجل</h2>
        <form onSubmit={login}>
          <label className="field">كلمة المرور</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          <div style={{ marginTop: 14 }}>
            <button className="btn primary" type="submit">
              دخول
            </button>
          </div>
          {loginError && <div className="result-box error" style={{ marginTop: 12 }}>{loginError}</div>}
        </form>
      </div>
    );
  }

  const filtered = records.filter(
    (r) =>
      (filter === "all" || r.type === filter) &&
      (search.trim() === "" || (r.prompt ?? "").toLowerCase().includes(search.trim().toLowerCase()))
  );

  return (
    <>
      <h1>سجل الأعمال المولّدة والمدمجة</h1>
      <p className="subtitle">كل صورة وفيديو ودمج يُسجَّل تلقائياً في قاعدة بيانات Turso مع روابطه المباشرة.</p>

      <div className="filters">
        {(
          [
            ["all", "الكل"],
            ["image", "🖼️ صور"],
            ["video", "🎬 فيديو"],
            ["merge", "🧩 دمج"],
          ] as [Filter, string][]
        ).map(([key, label]) => (
          <button key={key} className={`tab ${filter === key ? "active" : ""}`} onClick={() => setFilter(key)}>
            {label}
          </button>
        ))}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="بحث في الأوصاف…"
          style={{ maxWidth: 240 }}
        />
        <button className="btn small" onClick={() => void load()}>
          ⟳ تحديث
        </button>
      </div>

      {loading ? (
        <div className="empty">
          <span className="spinner" /> جارٍ التحميل…
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty">لا توجد سجلات مطابقة بعد — ابدأ بالتوليد من لوحة التحكم أو عبر ChatGPT.</div>
      ) : (
        <div className="gallery">
          {filtered.map((rec) => (
            <div className="card" key={rec.id}>
              <div className="media">
                {rec.status === "completed" && rec.urls[0] ? (
                  rec.type === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="media" src={rec.urls[0]} alt={rec.prompt ?? "generated"} loading="lazy" />
                  ) : (
                    <video className="media" controls preload="metadata" src={rec.urls[0]} />
                  )
                ) : rec.status === "processing" ? (
                  <>
                    <span className="spinner" />&nbsp; جارٍ العمل…
                  </>
                ) : (
                  "—"
                )}
              </div>
              <div className="body">
                <div className="meta">
                  <span className="badge">{TYPE_LABEL[rec.type]}</span>
                  {statusBadge(rec.status)}
                  <span>{fmtDate(rec.created_at)}</span>
                </div>
                {rec.prompt && <div className="prompt">{rec.prompt}</div>}
                {rec.model && (
                  <div className="meta">
                    <span dir="ltr">{rec.model}</span>
                  </div>
                )}
                {rec.error && <div className="err">{rec.error}</div>}
                <div className="actions">
                  {rec.urls.map((u, i) => (
                    <a key={u} className="btn small" href={u} target="_blank" rel="noreferrer">
                      {rec.urls.length > 1 ? `فتح ${i + 1}` : "فتح الرابط"}
                    </a>
                  ))}
                  <button className="btn small danger" onClick={() => void remove(rec.id)}>
                    حذف
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
