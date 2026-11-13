import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Media MCP Studio — استوديو الوسائط بالذكاء الاصطناعي",
  description:
    "توليد ودمج الصور والفيديوهات بالذكاء الاصطناعي عبر KIE.ai — خادم MCP متوافق مع ChatGPT + لوحة تحكم على Vercel",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            <span className="brand-mark">◈</span>
            <span>
              Media MCP <b>Studio</b>
            </span>
          </Link>
          <nav className="nav">
            <Link href="/">لوحة التحكم</Link>
            <Link href="/history">السجل</Link>
            <a href="/api/health" target="_blank" rel="noreferrer">
              الحالة
            </a>
          </nav>
        </header>
        <main className="container">{children}</main>
        <footer className="footer">
          Media MCP Studio · توليد ودمج الوسائط عبر KIE.ai · خادم MCP على <code>/api/mcp</code>
        </footer>
      </body>
    </html>
  );
}
