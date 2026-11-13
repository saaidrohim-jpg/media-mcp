import { IncomingMessage, ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";

/**
 * Minimal Node.js IncomingMessage/ServerResponse pair backed by a Web Request,
 * used by the legacy SSE transport (which still speaks the Node HTTP API).
 * Writes to `res` are streamed straight into a Web ReadableStream, so the
 * returned web Response can be handed to the Next.js route handler.
 */
export type NodeAdapter = {
  req: IncomingMessage;
  res: ServerResponse & { toWebResponse(): Response };
  /** Resolves when the response stream closes/ends. */
  done: Promise<void>;
};

export function createNodeAdapter(webReq: Request, bodyText?: string): NodeAdapter {
  const url = new URL(webReq.url);

  // ---- fake IncomingMessage ----
  const reqReadable = Readable.from(
    (async function* () {
      if (bodyText !== undefined) yield Buffer.from(bodyText, "utf8");
    })()
  );
  const req = reqReadable as unknown as IncomingMessage;
  req.headers = Object.fromEntries(webReq.headers.entries());
  (req as unknown as Record<string, unknown>).method = webReq.method;
  (req as unknown as Record<string, unknown>).url = url.pathname + url.search;
  (req as unknown as Record<string, unknown>).httpVersion = "1.1";
  (req as unknown as Record<string, unknown>).socket = { encrypted: true, remoteAddress: "127.0.0.1" };
  webReq.signal.addEventListener(
    "abort",
    () => {
      try {
        reqReadable.destroy(new Error("client aborted"));
      } catch {
        /* ignore */
      }
    },
    { once: true }
  );

  // ---- fake ServerResponse streaming into a web ReadableStream ----
  const headers = new Map<string, string>();
  let statusCode = 200;
  let closed = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const closeStream = () => {
    if (closed) return;
    closed = true;
    try {
      streamController?.close();
    } catch {
      /* already closed */
    }
    resolveDone();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    cancel() {
      closeStream();
      try {
        res.emit("close");
      } catch {
        /* ignore */
      }
    },
  });

  const writable = new Writable({
    write(chunk, _enc, cb) {
      if (!closed && streamController) {
        try {
          streamController.enqueue(new Uint8Array(chunk as Buffer));
        } catch {
          /* client gone */
        }
      }
      cb();
    },
    final(cb) {
      closeStream();
      try {
        res.emit("finish");
        res.emit("close");
      } catch {
        /* ignore */
      }
      cb();
    },
    destroy(_err, cb) {
      closeStream();
      try {
        res.emit("close");
      } catch {
        /* ignore */
      }
      cb();
    },
  });

  const res = writable as unknown as ServerResponse & { toWebResponse(): Response };
  const asAny = res as unknown as Record<string, unknown>;

  asAny.statusCode = statusCode;
  asAny.headersSent = false;
  asAny.setHeader = (name: string, value: string | number | readonly string[]) => {
    headers.set(String(name).toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value));
    return res;
  };
  asAny.getHeader = (name: string) => headers.get(String(name).toLowerCase());
  asAny.removeHeader = (name: string) => {
    headers.delete(String(name).toLowerCase());
  };
  asAny.hasHeader = (name: string) => headers.has(String(name).toLowerCase());
  asAny.getHeaders = () => Object.fromEntries(headers);
  asAny.writeHead = (status: number, headersArg?: unknown, extraHeaders?: unknown) => {
    statusCode = status;
    const hh = (extraHeaders ?? headersArg) as Record<string, unknown> | undefined;
    if (hh && typeof hh === "object") {
      for (const [k, v] of Object.entries(hh)) {
        headers.set(k.toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v));
      }
    }
    asAny.headersSent = true;
    asAny.statusCode = status;
    return res; // transports use writeHead(...).end(...) chaining
  };
  asAny.flushHeaders = () => {};

  res.toWebResponse = () => {
    const h: Record<string, string> = {};
    headers.forEach((v, k) => {
      h[k] = v;
    });
    return new Response(stream, { status: statusCode, headers: h });
  };

  return { req, res, done };
}
