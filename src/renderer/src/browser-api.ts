import {
  createPaperXcelApi,
  type PaperXcelTransport,
} from "../../shared/paperxcel-api";
import type { PaperXcelApi } from "../../shared/contracts";

type Listener = (_event: unknown, ...args: unknown[]) => void;
const PREFIX = "/__paperxcel";

/** The browser uses the same application API against its local Electron owner. */
export async function connectBrowserApi(): Promise<PaperXcelApi> {
  const listeners = new Map<string, Set<Listener>>();
  let token = "";
  let events: EventSource | undefined;
  let connecting: Promise<void> | undefined;
  const assetUrl = (url: string) =>
    `${PREFIX}/asset?session=${encodeURIComponent(token)}&url=${encodeURIComponent(url)}`;
  const rewriteResources = (value: unknown): unknown => {
    if (
      typeof value === "string" &&
      /^paperxcel:\/\/(?:paper|selection)\/[^\s]+$/.test(value)
    )
      return assetUrl(value);
    if (Array.isArray(value)) return value.map(rewriteResources);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [
          key,
          rewriteResources(nested),
        ]),
      );
    return value;
  };
  async function connect() {
    if (connecting) return connecting;
    connecting = (async () => {
      events?.close();
      const response = await fetch(`${PREFIX}/session`, { cache: "no-store" });
      if (!response.ok)
        throw new Error("桌面开发后端尚未连接，请使用 npm run dev 启动项目。");
      const session = (await response.json()) as { token: string };
      token = session.token;
      await new Promise<void>((resolve, reject) => {
        const source = new EventSource(
          `${PREFIX}/events?session=${encodeURIComponent(token)}`,
        );
        events = source;
        const timeout = window.setTimeout(() => {
          source.close();
          reject(new Error("连接桌面事件流超时。"));
        }, 10_000);
        source.onmessage = (event) => {
          const message = JSON.parse(event.data) as {
            channel: string;
            args: unknown[];
          };
          if (message.channel === "bridge:ready") {
            window.clearTimeout(timeout);
            resolve();
            return;
          }
          for (const listener of listeners.get(message.channel) ?? [])
            listener(undefined, ...message.args.map(rewriteResources));
        };
        source.onerror = () => {
          window.clearTimeout(timeout);
          source.close();
          if (events === source) events = undefined;
          reject(new Error("与桌面后端的连接已断开，请刷新页面重新连接。"));
        };
      });
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  }
  const invoke: PaperXcelTransport["invoke"] = async (channel, ...args) => {
    if (!events) await connect();
    const response = await fetch(`${PREFIX}/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-paperxcel-session": token,
      },
      body: JSON.stringify({ channel, args }, (_key, value: unknown) =>
        value instanceof Uint8Array
          ? { __paperxcelBytes: toBase64(value) }
          : value,
      ),
    });
    const body = (await response.json()) as {
      result?: unknown;
      error?: string;
    };
    if (!response.ok) throw new Error(body.error ?? "桌面操作未完成。");
    return rewriteResources(body.result);
  };
  const transport = {
    invoke,
    getPathForFile: () => "",
    on(channel: string, callback: Listener) {
      let callbacks = listeners.get(channel);
      if (!callbacks) {
        callbacks = new Set();
        listeners.set(channel, callbacks);
      }
      callbacks.add(callback);
      return transport;
    },
    removeListener(channel: string, callback: Listener) {
      listeners.get(channel)?.delete(callback);
      return transport;
    },
  } as unknown as PaperXcelTransport;
  await connect();
  const api = createPaperXcelApi(transport);
  api.papers.importDroppedPdf = async (file, input) =>
    invoke(
      "browser:import-pdf",
      { data: new Uint8Array(await file.arrayBuffer()), fileName: file.name },
      input,
    );
  api.selectionImages.url = (id) =>
    assetUrl(`paperxcel://selection/${encodeURIComponent(id)}`);
  window.addEventListener("pagehide", () => events?.close(), { once: true });
  return api;
}

function toBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32_768)
    chunks.push(
      String.fromCharCode(...bytes.subarray(offset, offset + 32_768)),
    );
  return btoa(chunks.join(""));
}
