"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type KeyRow = {
  id: string;
  name: string;
  masked_key: string;
  status: string;
  usage_count: number;
  fail_count: number;
  last_used_at: string | null;
  created_at: string;
};

type Stats = { total: number; completed: number; processing: number; failed: number; images: number; videos: number; merges: number };

type OpResult = {
  recordId?: string;
  taskId?: string | null;
  status?: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
};

type Tab = "image" | "video" | "merge";

function statusBadge(status: string) {
  if (status === "active") return <span className="badge ok">نشط</span>;
  if (status === "exhausted") return <span className="badge bad">نفد رصيده</span>;
  return <span className="badge warn">معطّل</span>;
}

export default function Dashboard() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);

  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyValue, setNewKeyValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>("image");
  const [imgPrompt, setImgPrompt] = useState("");
  const [imgRatio, setImgRatio] = useState("auto");
  const [vidPrompt, setVidPrompt] = useState("");
  const [vidDuration, setVidDuration] = useState("15");
  const [vidResolution, setVidResolution] = useState("480p");
  const [vidImageUrl, setVidImageUrl] = useState("");
  const [mergeUrls, setMergeUrls] = useState("");
  const [op, setOp] = useState<OpResult | null>(null);
  const [opBusy, setOpBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadKeys = useCallback(async () => {
    const res = await fetch("/api/keys");
    if (res.status === 401) {
      setAuthed(false);
      return;
    }
    const data = await res.json();
    setKeys(data.keys ?? []);
    setAuthed(true);
    if (data.keys?.length === 0) {
      setMessage("لا توجد مفاتيح بعد — أضف مفتاح KIE API الأول لبدء التوليد.");
    }
  }, []);

  const loadStats = useCallback(async () => {
    const res = await fetch("/api/media?limit=1");
    if (res.status !== 401) {
      const data = await res.json();
      setStats(data.stats ?? null);
    }
  }, []);

  useEffect(() => {
    void loadKeys();
    void loadStats();
  }, [loadKeys, loadStats]);

  // poll the record while the last operation is still processing
  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (op?.status === "processing" && op.recordId) {
      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch("/api/media?limit=150");
          if (!res.ok) return;
          const data = await res.json();
          const rec = (data.records ?? []).find((r: { id: string }) => r.id === op.recordId);
          if (rec) {
            setOp({ recordId: rec.id, taskId: rec.task_id, status: rec.status, urls: rec.urls, error: rec.error });
            if (rec.status !== "processing") void loadStats();
          }
        } catch {
          /* ignore transient errors */
        }
      }, 8000);
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [op, loadStats]);

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
      await loadKeys();
      await loadStats();
    } else {
      const data = await res.json().catch(() => ({}));
      setLoginError(data.error ?? "فشل تسجيل الدخول.");
    }
  }

  async function addKey(e: React.FormEvent) {
    e.preventDefault();
    if (!newKeyValue.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newKeyName, api_key: newKeyValue }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "فشل إضافة المفتاح.");
      setNewKeyName("");
      setNewKeyValue("");
      setMessage("تمت إضافة المفتاح — سيُستخدم تلقائياً بعد نفاد رصيد المفاتيح الأسبق منه.");
      await loadKeys();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function keyAction(id: string, action: "activate" | "disable" | "delete") {
    setBusy(true);
    try {
      if (action === "delete") {
        await fetch(`/api/keys?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      } else {
        await fetch("/api/keys", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, status: action === "activate" ? "active" : "disabled" }),
        });
      }
      await loadKeys();
    } finally {
      setBusy(false);
    }
  }

  async function runOp(endpoint: string, payload: Record<string, unknown>) {
    setOpBusy(true);
    setOp({ status: "processing" });
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as OpResult & { error?: string };
      if (!res.ok) {
        setOp({ status: "failed", error: data.error ?? `فشل الطلب (HTTP ${res.status}).` });
      } else {
        setOp(data);
        if (data.status === "completed") void loadStats();
      }
    } catch (err) {
      setOp({ status: "failed", error: (err as Error).message });
    } finally {
      setOpBusy(false);
    }
  }

  if (authed === false) {
    return (
      <div className="login-box panel">
        <h2>تسجيل دخول لوحة التحكم</h2>
        <p className="subtitle">هذه اللوحة محمية بكلمة مرور (ADMIN_PASSWORD).</p>
        <form onSubmit={login}>
          <label className="field">كلمة المرور</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoFocus
          />
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

  if (authed === null) {
    return (
      <div className="empty">
        <span className="spinner" /> جارٍ التحميل…
      </div>
    );
  }

  return (
    <>
      <h1>استوديو الوسائط — توليد ودمج بالذكاء الاصطناعي</h1>
      <p className="subtitle">
        توليد الصور عبر <code>gpt-image-2-6/flare-text-to-image</code> والفيديو (15 ثانية) عبر{" "}
        <code>grok-imagine-video-1-5-preview</code> من KIE.ai، مع دمج الفيديوهات وتبديل تلقائي بين مفاتيح API، وخادم MCP
        جاهز لربطه بـ ChatGPT.
      </p>

      <div className="grid-stats">
        <div className="stat">
          <div className="num">{stats?.total ?? 0}</div>
          <div className="lbl">إجمالي الأعمال</div>
        </div>
        <div className="stat">
          <div className="num">{stats?.images ?? 0}</div>
          <div className="lbl">صور مولّدة</div>
        </div>
        <div className="stat">
          <div className="num">{stats?.videos ?? 0}</div>
          <div className="lbl">فيديوهات مولّدة</div>
        </div>
        <div className="stat">
          <div className="num">{stats?.merges ?? 0}</div>
          <div className="lbl">عمليات دمج</div>
        </div>
        <div className="stat">
          <div className="num">{stats?.processing ?? 0}</div>
          <div className="lbl">قيد المعالجة</div>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>🔑 مفاتيح KIE API والتبديل التلقائي</h2>
          <span className="badge">{keys.filter((k) => k.status === "active").length} نشط من {keys.length}</span>
        </div>
        <p className="subtitle" style={{ marginBottom: 10 }}>
          يجرّب النظام المفاتيح النشطة بالترتيب: إذا نفد رصيد مفتاح أو رُفض، يُعلَّم «نفد رصيده» فوراً وينتقل للمفتاح التالي
          دون تدخل.
        </p>
        {keys.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="keys-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>الاسم</th>
                  <th>المفتاح</th>
                  <th>الحالة</th>
                  <th>الاستخدام</th>
                  <th>إخفاقات</th>
                  <th>آخر استخدام</th>
                  <th>إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k, i) => (
                  <tr key={k.id}>
                    <td>{i + 1}</td>
                    <td>{k.name}</td>
                    <td className="mono">{k.masked_key}</td>
                    <td>{statusBadge(k.status)}</td>
                    <td>{k.usage_count}</td>
                    <td>{k.fail_count}</td>
                    <td style={{ color: "var(--muted)", fontSize: 12 }}>{k.last_used_at ?? "—"}</td>
                    <td>
                      <div style={{ display: "flex", gap: 6 }}>
                        {k.status !== "active" && (
                          <button className="btn small" disabled={busy} onClick={() => keyAction(k.id, "activate")}>
                            تنشيط
                          </button>
                        )}
                        {k.status === "active" && keys.filter((x) => x.status === "active").length > 1 && (
                          <button className="btn small" disabled={busy} onClick={() => keyAction(k.id, "disable")}>
                            تعطيل
                          </button>
                        )}
                        <button className="btn small danger" disabled={busy} onClick={() => keyAction(k.id, "delete")}>
                          حذف
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form onSubmit={addKey} style={{ marginTop: 16 }}>
          <div className="row">
            <div>
              <label className="field">اسم المفتاح (اختياري)</label>
              <input
                type="text"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="مثال: حساب KIE الثاني"
              />
            </div>
            <div style={{ flex: 2 }}>
              <label className="field">مفتاح API</label>
              <input
                type="text"
                value={newKeyValue}
                onChange={(e) => setNewKeyValue(e.target.value)}
                placeholder="الصق مفتاح KIE API هنا"
                dir="ltr"
              />
            </div>
            <div style={{ flex: 0 }}>
              <button className="btn primary" type="submit" disabled={busy || !newKeyValue.trim()}>
                + إضافة مفتاح
              </button>
            </div>
          </div>
        </form>
        {message && <div className="result-box" style={{ marginTop: 12 }}>{message}</div>}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>🎛️ التوليد والدمج</h2>
          <a href="/history">عرض السجل الكامل ←</a>
        </div>
        <div className="tabs">
          <button className={`tab ${tab === "image" ? "active" : ""}`} onClick={() => setTab("image")}>
            🖼️ توليد صورة
          </button>
          <button className={`tab ${tab === "video" ? "active" : ""}`} onClick={() => setTab("video")}>
            🎬 توليد فيديو (15 ثانية)
          </button>
          <button className={`tab ${tab === "merge" ? "active" : ""}`} onClick={() => setTab("merge")}>
            🧩 دمج فيديوهات
          </button>
        </div>

        {tab === "image" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runOp("/api/generate/image", { prompt: imgPrompt, aspect_ratio: imgRatio });
            }}
          >
            <label className="field">وصف الصورة (بأي لغة)</label>
            <textarea
              value={imgPrompt}
              onChange={(e) => setImgPrompt(e.target.value)}
              placeholder="مثال: ملصق سينمائي لمدينة ليلية بانعكاسات النيون على شارع ممطر"
            />
            <div className="row">
              <div>
                <label className="field">نسبة الأبعاد</label>
                <select value={imgRatio} onChange={(e) => setImgRatio(e.target.value)}>
                  <option value="auto">تلقائي</option>
                  <option value="1:1">1:1</option>
                  <option value="16:9">16:9</option>
                  <option value="9:16">9:16</option>
                  <option value="4:3">4:3</option>
                  <option value="3:4">3:4</option>
                </select>
              </div>
              <div style={{ flex: 0 }}>
                <button className="btn primary" type="submit" disabled={opBusy || !imgPrompt.trim()}>
                  {opBusy ? "جارٍ التوليد…" : "توليد الصورة"}
                </button>
              </div>
            </div>
          </form>
        )}

        {tab === "video" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runOp("/api/generate/video", {
                prompt: vidPrompt,
                duration_seconds: Number(vidDuration),
                resolution: vidResolution,
                image_url: vidImageUrl.trim() || undefined,
              });
            }}
          >
            <label className="field">وصف الحركة (ما يتحرك، سرعته، سلوك الكاميرا)</label>
            <textarea
              value={vidPrompt}
              onChange={(e) => setVidPrompt(e.target.value)}
              placeholder="مثال: لقطة مقربة لفنجان قهوة يتصاعد منه البخار ببطء، الكاميرا تدور حوله ببطء، إضاءة دافئة"
            />
            <div className="row">
              <div>
                <label className="field">المدة (ثانية)</label>
                <select value={vidDuration} onChange={(e) => setVidDuration(e.target.value)}>
                  <option value="15">15 (الافتراضية)</option>
                  <option value="10">10</option>
                  <option value="6">6</option>
                </select>
              </div>
              <div>
                <label className="field">الدقة</label>
                <select value={vidResolution} onChange={(e) => setVidResolution(e.target.value)}>
                  <option value="480p">480p</option>
                  <option value="720p">720p</option>
                </select>
              </div>
              <div>
                <label className="field">رابط صورة للتحريك (اختياري)</label>
                <input
                  type="text"
                  value={vidImageUrl}
                  onChange={(e) => setVidImageUrl(e.target.value)}
                  placeholder="https://… (اختياري)"
                  dir="ltr"
                />
              </div>
              <div style={{ flex: 0 }}>
                <button className="btn primary" type="submit" disabled={opBusy || !vidPrompt.trim()}>
                  {opBusy ? "جارٍ التوليد…" : "توليد الفيديو"}
                </button>
              </div>
            </div>
          </form>
        )}

        {tab === "merge" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const urls = mergeUrls
                .split("\n")
                .map((u) => u.trim())
                .filter(Boolean);
              void runOp("/api/merge", { urls });
            }}
          >
            <label className="field">روابط المقاطع — رابط واحد في كل سطر (بالترتيب المطلوب، من 2 إلى 10 روابط)</label>
            <textarea
              value={mergeUrls}
              onChange={(e) => setMergeUrls(e.target.value)}
              placeholder={"https://example.com/clip1.mp4\nhttps://example.com/clip2.mp4"}
              dir="ltr"
            />
            <div style={{ marginTop: 12 }}>
              <button className="btn primary" type="submit" disabled={opBusy || mergeUrls.split("\n").filter((u) => u.trim()).length < 2}>
                {opBusy ? "جارٍ الدمج…" : "دمج الفيديوهات"}
              </button>
            </div>
          </form>
        )}

        {op && (
          <div className={`result-box ${op.status === "failed" ? "error" : ""}`}>
            {op.status === "processing" && (
              <>
                <span className="spinner" />{" "}
                {op.recordId
                  ? "قيد المعالجة — سيتم التحديث تلقائياً هنا وعند اكتمال النتيجة تظهر في السجل."
                  : op.error ?? "جارٍ إرسال الطلب…"}
              </>
            )}
            {op.status === "completed" && op.urls && op.urls.length > 0 && (
              <>
                ✅ اكتمل بنجاح!
                {op.urls.map((u) => (
                  <div key={u} style={{ marginTop: 10 }}>
                    {tab === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={u} alt="النتيجة" style={{ maxWidth: "100%", borderRadius: 10 }} />
                    ) : (
                      <video controls preload="metadata" src={u} style={{ width: "100%", borderRadius: 10 }} />
                    )}
                    <div className="mono" style={{ marginTop: 6 }}>
                      <a href={u} target="_blank" rel="noreferrer">
                        {u}
                      </a>
                    </div>
                  </div>
                ))}
              </>
            )}
            {op.status === "failed" && <>❌ {op.error ?? "فشلت العملية."}</>}
          </div>
        )}

        <div className="mcp-hint">
          اربط ChatGPT بالخادم: <code>{typeof window !== "undefined" ? `${window.location.origin}/api/mcp` : "/api/mcp"}</code>
          <span>(Streamable HTTP) أو <code>/api/sse</code> للنقل القديم</span>
        </div>
      </section>
    </>
  );
}
