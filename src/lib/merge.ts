import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { KieError, kieUploadFile } from "./keys";

const MAX_INPUT_BYTES = 250 * 1024 * 1024; // 250 MB per clip
const DOWNLOAD_TIMEOUT_MS = 120_000;
const FFMPEG_TIMEOUT_MS = 280_000;

function ffmpegBinary(): string {
  const p = ffmpegStatic as unknown as string | null;
  if (!p || !existsSync(p)) {
    throw new KieError("لم يُعثر على ملف ffmpeg التنفيذي (ffmpeg-static). أعد تثبيت الحزم.");
  }
  return p;
}

function runFfmpeg(args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBinary(), args, { cwd });
    let stderrTail = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new KieError("انتهت مهلة تنفيذ ffmpeg قبل اكتمال الدمج."));
    }, FFMPEG_TIMEOUT_MS);
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new KieError(`تعذر تشغيل ffmpeg: ${err.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new KieError(`فشل ffmpeg (رمز الخروج ${code}). آخر الأخطاء:\n${stderrTail.slice(-800)}`));
    });
  });
}

async function downloadClip(url: string, dest: string, index: number): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    throw new KieError(`تعذر تنزيل المقطع رقم ${index + 1}: ${(err as Error).message}`);
  }
  if (!res.ok || !res.body) {
    throw new KieError(`تعذر تنزيل المقطع رقم ${index + 1} (HTTP ${res.status}). تأكد أن الرابط مباشر وعام.`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0) throw new KieError(`المقطع رقم ${index + 1} فارغ.`);
  if (buf.byteLength > MAX_INPUT_BYTES) {
    throw new KieError(`المقطع رقم ${index + 1} يتجاوز الحد الأقصى (250MB).`);
  }
  await writeFile(dest, buf);
}

export type MergeOutcome = { url: string; sizeBytes: number };

/**
 * Downloads all clips, concatenates them in order into one MP4 (re-encoded H.264/AAC),
 * uploads the result to KIE storage and returns its direct URL.
 * Strategies are tried in order: concat demuxer → filter with audio → filter video-only.
 */
export async function mergeVideoFiles(urls: string[]): Promise<MergeOutcome> {
  if (urls.length < 2) throw new KieError("يلزم مقطعان على الأقل لدمج الفيديو.");
  if (urls.length > 10) throw new KieError("الحد الأقصى للدمج هو 10 مقاطع في المرة الواحدة.");

  const dir = await mkdtemp(path.join(tmpdir(), "media-mcp-merge-"));
  try {
    const inputs: string[] = [];
    for (let i = 0; i < urls.length; i++) {
      const dest = path.join(dir, `input-${i}.mp4`);
      await downloadClip(urls[i], dest, i);
      inputs.push(`input-${i}.mp4`);
    }

    const outName = "merged.mp4";
    const outPath = path.join(dir, outName);

    // Strategy A: concat demuxer with re-encode (fastest; clips from the same model are uniform).
    const listName = "list.txt";
    const listContent = inputs.map((f) => `file '${f}'`).join("\n") + "\n";
    await writeFile(path.join(dir, listName), listContent, "utf8");
    const codecArgs = [
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
    ];

    const attempts: { name: string; args: string[] }[] = [
      {
        name: "concat-demuxer",
        args: ["-y", "-f", "concat", "-safe", "0", "-i", listName, ...codecArgs, outName],
      },
      {
        name: "filter-with-audio",
        args: [
          "-y",
          ...inputs.flatMap((f) => ["-i", f]),
          "-filter_complex",
          `${inputs.map((_, i) => `[${i}:v][${i}:a]`).join("")}concat=n=${inputs.length}:v=1:a=1[v][a]`,
          "-map", "[v]", "-map", "[a]",
          ...codecArgs,
          outName,
        ],
      },
      {
        name: "filter-video-only",
        args: [
          "-y",
          ...inputs.flatMap((f) => ["-i", f]),
          "-filter_complex",
          `${inputs.map((_, i) => `[${i}:v]`).join("")}concat=n=${inputs.length}:v=1:a=0[v]`,
          "-map", "[v]", "-an",
          ...codecArgs.slice(0, 6),
          "-movflags", "+faststart",
          outName,
        ],
      },
    ];

    let lastError: Error | null = null;
    let merged = false;
    for (const attempt of attempts) {
      try {
        await runFfmpeg(attempt.args, dir);
        const info = await stat(outPath).catch(() => null);
        if (info && info.size > 0) {
          merged = true;
          break;
        }
        lastError = new KieError(`أنتج ffmpeg ملفاً فارغاً في المحاولة (${attempt.name}).`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    if (!merged) {
      throw new KieError(
        `فشل دمج المقاطع بجميع الطرق. غالباً لأن أحد الروابط ليس ملف فيديو صالحاً. تفاصيل آخر محاولة: ${(lastError as Error | null)?.message ?? "غير معروفة"}`
      );
    }

    const bytes = await readFile(outPath);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `merged-${stamp}.mp4`;
    const uploadPath = `media-mcp/merges/${fileName}`;
    const url = await kieUploadFile(new Uint8Array(bytes), fileName, uploadPath, "video/mp4");
    return { url, sizeBytes: bytes.byteLength };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
