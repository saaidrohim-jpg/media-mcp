import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  IMAGE_WAIT_MS,
  MERGE_WAIT_MS,
  VIDEO_WAIT_MS,
  formatRecordSummary,
  refreshRecordFromKie,
  runImageGeneration,
  runVideoGeneration,
} from "./generate";
import { IMAGE_MODEL, VIDEO_MODEL } from "./kie";
import { mergeVideoFiles } from "./merge";
import { createMediaRecord, getMediaRecord, getMediaRecordByTask, listMediaRecords, updateMediaRecord } from "./media";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string) {
  return { ...textResult(`❌ ${text}`), isError: true as const };
}

function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "media-mcp-studio", version: "1.0.0" },
    {
      instructions:
        "AI media studio: generate images (text-to-image), generate videos (6/10/15 seconds, text or image to video), " +
        "merge multiple video URLs into one MP4 in order, and check the status of any previous task. " +
        "If a tool answers 'still processing', call check_task with the returned taskId to fetch the result.",
    }
  );

  // ---------- generate_image ----------
  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description: `Generate an AI image from a text prompt using the configured KIE.ai image model (${IMAGE_MODEL}). Returns direct image URL(s) when finished in time.`,
      inputSchema: {
        prompt: z.string().min(1).max(4000).describe("What the image should show. Can be any language."),
        aspect_ratio: z
          .string()
          .optional()
          .describe("Optional aspect ratio like '1:1', '16:9', '9:16', '4:3', '3:4'. Defaults to auto."),
      },
    },
    async (args) => {
      try {
        const r = await runImageGeneration({
          prompt: args.prompt,
          aspectRatio: args.aspect_ratio,
          waitMs: intEnv("MCP_IMAGE_WAIT_MS", IMAGE_WAIT_MS),
        });
        if (r.status === "completed") {
          return textResult(`✅ تم توليد الصورة بنجاح — Image ready:\n\n${r.urls.join("\n")}\n\nRecord ID: ${r.recordId}`);
        }
        if (r.status === "failed") return errorResult(r.error || "فشل توليد الصورة.");
        return textResult(
          `⏳ الصورة قيد المعالجة بعد ${Math.round(intEnv("MCP_IMAGE_WAIT_MS", IMAGE_WAIT_MS) / 1000)} ثانية من الانتظار.\nTask ID: ${r.taskId}\nRecord ID: ${r.recordId}\nCall check_task with this taskId to fetch the result.`
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
  );

  // ---------- generate_video ----------
  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description: `Generate an AI video (6, 10 or 15 seconds — default 15) with the configured KIE.ai video model (${VIDEO_MODEL}). Supports text-to-video and image-to-video (pass image_url). Returns the direct video URL when finished in time.`,
      inputSchema: {
        prompt: z.string().min(1).max(5000).describe("Motion prompt: describe what moves, how fast, and camera behavior."),
        duration_seconds: z
          .union([z.literal(6), z.literal(10), z.literal(15)])
          .optional()
          .describe("Clip length in seconds. Default 15."),
        resolution: z.enum(["480p", "720p"]).optional().describe("Output resolution. Default 480p."),
        image_url: z
          .string()
          .url()
          .optional()
          .describe("Optional public image URL (jpeg/png/webp, max 10MB) to animate (image-to-video)."),
      },
    },
    async (args) => {
      try {
        const r = await runVideoGeneration({
          prompt: args.prompt,
          durationSeconds: args.duration_seconds,
          resolution: args.resolution,
          imageUrl: args.image_url,
          waitMs: intEnv("MCP_VIDEO_WAIT_MS", VIDEO_WAIT_MS),
        });
        if (r.status === "completed") {
          return textResult(`✅ تم توليد الفيديو بنجاح — Video ready:\n\n${r.urls.join("\n")}\n\nRecord ID: ${r.recordId}`);
        }
        if (r.status === "failed") return errorResult(r.error || "فشل توليد الفيديو.");
        return textResult(
          `⏳ الفيديو قيد المعالجة (توليد الفيديو يستغرق عادة من دقيقتين إلى ثماني دقائق).\nTask ID: ${r.taskId}\nRecord ID: ${r.recordId}\nCall check_task with this taskId after a minute or two to get the video URL.`
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
  );

  // ---------- merge_videos ----------
  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description:
        "Merge 2-10 video URLs, in the given order, into one continuous MP4 file (re-encoded H.264/AAC) and return its direct URL. " +
        "All URLs must be publicly downloadable video files.",
      inputSchema: {
        video_urls: z
          .array(z.string().url())
          .min(2)
          .max(10)
          .describe("Ordered list of direct video URLs to concatenate (first item plays first)."),
      },
    },
    async (args) => {
      const urls = args.video_urls;
      const record = await createMediaRecord({
        type: "merge",
        model: "ffmpeg-concat",
        prompt: urls.join(" | "),
        meta: { inputs: urls, source: "mcp" },
      });
      try {
        const started = Date.now();
        const outcome = await mergeVideoFiles(urls);
        const seconds = Math.round((Date.now() - started) / 1000);
        await updateMediaRecord(record.id, {
          status: "completed",
          urls: [outcome.url],
          error: null,
          meta: { inputs: urls, sizeBytes: outcome.sizeBytes, tookSeconds: seconds, source: "mcp" },
        });
        return textResult(
          `✅ تم دمج ${urls.length} مقاطع في ملف MP4 واحد — Merged video ready:\n\n${outcome.url}\n\n(Size: ${(outcome.sizeBytes / 1048576).toFixed(1)} MB, took ${seconds}s, Record ID: ${record.id})`
        );
      } catch (err) {
        const message = (err as Error).message;
        await updateMediaRecord(record.id, { status: "failed", error: message }).catch(() => {});
        return errorResult(message);
      }
    }
  );

  // ---------- check_task ----------
  server.registerTool(
    "check_task",
    {
      title: "Check Task",
      description:
        "Check the status of a previous generation task (image or video) by its taskId or Record ID. Refreshes the result from KIE and returns the direct URLs when done.",
      inputSchema: {
        task_id: z.string().min(1).describe("The taskId (from generate_image / generate_video) or the Record ID."),
      },
    },
    async (args) => {
      try {
        const record = (await getMediaRecordByTask(args.task_id)) ?? (await getMediaRecord(args.task_id));
        if (!record) {
          return errorResult(`لا توجد مهمة بالمعرف ${args.task_id}.`);
        }
        const fresh = await refreshRecordFromKie(record);
        const header =
          fresh.status === "completed"
            ? "✅ المهمة مكتملة — Task completed:"
            : fresh.status === "failed"
              ? "❌ المهمة فشلت — Task failed:"
              : "⏳ لا تزال قيد المعالجة — Still processing (try again later):";
        return textResult(`${header}\n\n${formatRecordSummary(fresh)}`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
  );

  // ---------- list_media ----------
  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description: "List the most recent generated/merged media records (images, videos, merges) with their URLs.",
      inputSchema: {
        limit: z.number().int().min(1).max(20).optional().describe("How many records to return (1-20). Default 10."),
      },
    },
    async (args) => {
      try {
        const records = await listMediaRecords(args.limit ?? 10);
        if (records.length === 0) return textResult("لا توجد سجلات بعد — no media records yet.");
        const body = records
          .map((rec, i) => {
            const urls = rec.urls.length ? rec.urls.join("\n  ") : "(no URL yet)";
            return `${i + 1}. [${rec.type}] ${rec.status} — ${rec.created_at}\n  prompt: ${(rec.prompt ?? "").slice(0, 120)}\n  ${urls}`;
          })
          .join("\n\n");
        return textResult(`آخر ${records.length} سجل:\n\n${body}`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }
  );

  return server;
}

/** Exported for the dashboard merge route: runs a merge and keeps a DB record in sync. */
export async function runMergeWithRecord(urls: string[], source: string): Promise<{ recordId: string; url?: string; error?: string; sizeBytes?: number }> {
  const record = await createMediaRecord({
    type: "merge",
    model: "ffmpeg-concat",
    prompt: urls.join(" | "),
    meta: { inputs: urls, source },
  });
  try {
    const outcome = await mergeVideoFiles(urls);
    await updateMediaRecord(record.id, {
      status: "completed",
      urls: [outcome.url],
      error: null,
      meta: { inputs: urls, sizeBytes: outcome.sizeBytes, source },
    });
    return { recordId: record.id, url: outcome.url, sizeBytes: outcome.sizeBytes };
  } catch (err) {
    const message = (err as Error).message;
    await updateMediaRecord(record.id, { status: "failed", error: message }).catch(() => {});
    return { recordId: record.id, error: message };
  }
}
