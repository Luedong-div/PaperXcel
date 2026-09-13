import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const PREFIX = "/__paperxcel";
const MAX_BODY = 110 * 1024 * 1024;
let browserSenderId = -1;

export interface DevBrowserBridgeOptions {
  enabled: boolean;
  port?: number;
  nonce?: string;
  rendererUrl?: string;
  readAsset(url: string): Promise<Response>;
}

/** Only called in development; the production app never starts an HTTP API. */
export function installDevBrowserBridge(
  ipc: IpcMain,
  options: DevBrowserBridgeOptions,
) {
  if (
    !options.enabled ||
    !options.port ||
    !options.nonce ||
    !options.rendererUrl
  )
    return undefined;
  const renderer = new URL(options.rendererUrl);
  if (!isLoopback(renderer.hostname) || renderer.protocol !== "http:")
    throw new Error("浏览器开发桥仅允许本机 HTTP 地址。");
  const port = options.port;
  const nonce = options.nonce;
  const handlers = new Map<string, Handler>();
  const register = ipc.handle.bind(ipc);
  ipc.handle = ((channel: string, listener: Handler) => {
    handlers.set(channel, listener);
    register(channel, listener);
  }) as IpcMain["handle"];
  const clients = new Map<string, BrowserSender>();
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (!response.headersSent)
        json(response, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      else response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store");
    if (!authorizedProxy(request))
      return json(response, 403, { error: "开发桥拒绝此来源。" });
    const url = new URL(request.url ?? "/", renderer.origin);
    if (request.method === "GET" && url.pathname === `${PREFIX}/session`) {
      const token = randomBytes(32).toString("hex");
      const sender = new BrowserSender(--browserSenderId);
      clients.set(token, sender);
      sender.once("destroyed", () => clients.delete(token));
      return json(response, 200, { token });
    }
    const token = String(
      request.headers["x-paperxcel-session"] ??
        url.searchParams.get("session") ??
        "",
    );
    const sender = clients.get(token);
    if (!sender || sender.isDestroyed())
      return json(response, 401, { error: "浏览器连接已失效，请刷新页面。" });
    if (request.method === "GET" && url.pathname === `${PREFIX}/events`) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      sender.connect(response);
      return;
    }
    if (request.method === "GET" && url.pathname === `${PREFIX}/asset`) {
      const assetUrl = url.searchParams.get("url") ?? "";
      const asset = new URL(assetUrl);
      if (
        asset.protocol !== "paperxcel:" ||
        !["paper", "selection"].includes(asset.hostname)
      )
        return json(response, 400, { error: "无效的文献资源。" });
      const result = await options.readAsset(assetUrl);
      response.statusCode = result.status;
      response.setHeader(
        "Content-Type",
        result.headers.get("content-type") ?? "application/octet-stream",
      );
      const bytes = Buffer.from(await result.arrayBuffer());
      response.setHeader("Content-Length", bytes.byteLength);
      response.end(bytes);
      return;
    }
    if (request.method !== "POST" || url.pathname !== `${PREFIX}/invoke`)
      return json(response, 404, { error: "Unknown route" });
    if (!String(request.headers["content-type"]).startsWith("application/json"))
      return json(response, 415, { error: "JSON required" });
    const body = (await readJson(request)) as {
      channel?: unknown;
      args?: unknown;
    };
    if (!body || typeof body.channel !== "string" || !Array.isArray(body.args))
      return json(response, 400, { error: "无效的请求。" });
    if (["papers:import-path", "chat:attach-file"].includes(body.channel))
      return json(response, 403, { error: "浏览器不能指定本地文件路径。" });
    let result: unknown;
    const args = decodeValues(body.args) as unknown[];
    const event = { sender } as unknown as IpcMainInvokeEvent;
    if (body.channel === "browser:import-pdf") {
      const input = args[0] as { data?: unknown; fileName?: unknown };
      if (
        !(input?.data instanceof Uint8Array) ||
        !String(input.fileName).toLowerCase().endsWith(".pdf")
      )
        throw new Error("只能导入 PDF 文件。");
      const directory = await mkdtemp(
        join(tmpdir(), "paperxcel-browser-upload-"),
      );
      try {
        const path = join(directory, "upload.pdf");
        await writeFile(path, input.data);
        result = await handlers.get("papers:import-path")?.(
          event,
          path,
          args[1],
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    } else {
      const handler = handlers.get(body.channel);
      if (!handler) return json(response, 404, { error: "不支持此操作。" });
      result = await handler(event, ...args);
    }
    json(response, 200, { result });
  }

  function authorizedProxy(request: IncomingMessage): boolean {
    if (!isLoopback(request.socket.remoteAddress ?? "")) return false;
    if (request.headers["x-paperxcel-proxy"] !== nonce) return false;
    let host: URL;
    try {
      host = new URL(`http://${request.headers.host}`);
    } catch {
      return false;
    }
    if (!isLoopback(host.hostname) || host.port !== renderer.port) return false;
    const origin = request.headers.origin;
    if (origin && origin !== host.origin) return false;
    const site = request.headers["sec-fetch-site"];
    return !site || site === "same-origin" || site === "none";
  }

  return {
    async start(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
    },
    forwardWebContents(contents: WebContents): void {
      const send = contents.send.bind(contents);
      contents.send = ((channel: string, ...args: unknown[]) => {
        for (const client of clients.values()) client.send(channel, ...args);
        send(channel, ...args);
      }) as WebContents["send"];
    },
    close(): void {
      for (const client of clients.values()) client.destroy();
      server.closeAllConnections();
      server.close();
      ipc.handle = register;
    },
  };
}

class BrowserSender extends EventEmitter {
  private response?: ServerResponse;
  private destroyed = false;
  private readonly initialTimeout: ReturnType<typeof setTimeout>;
  constructor(readonly id: number) {
    super();
    this.initialTimeout = setTimeout(() => this.destroy(), 30_000);
    this.initialTimeout.unref();
  }
  connect(response: ServerResponse): void {
    clearTimeout(this.initialTimeout);
    this.response?.end();
    this.response = response;
    response.write(
      `data: ${JSON.stringify({ channel: "bridge:ready", args: [] })}\n\n`,
    );
    const heartbeat = setInterval(
      () => response.write(": keepalive\n\n"),
      15_000,
    );
    heartbeat.unref();
    response.once("close", () => {
      clearInterval(heartbeat);
      if (this.response === response) this.destroy();
    });
  }
  send(channel: string, ...args: unknown[]): void {
    if (!this.destroyed)
      this.response?.write(`data: ${JSON.stringify({ channel, args })}\n\n`);
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.initialTimeout);
    this.emit("destroyed");
    this.response?.end();
  }
}

function isLoopback(host: string): boolean {
  return [
    "localhost",
    "127.0.0.1",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
  ].includes(host);
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("浏览器上传文件过大。");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function decodeValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValues);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (
      typeof object.__paperxcelBytes === "string" &&
      Object.keys(object).length === 1
    )
      return new Uint8Array(Buffer.from(object.__paperxcelBytes, "base64"));
    return Object.fromEntries(
      Object.entries(object).map(([key, nested]) => [
        key,
        decodeValues(nested),
      ]),
    );
  }
  return value;
}
