import { app, net } from "electron";
import { readFile, stat } from "node:fs/promises";
import { request } from "node:http";
import { isAbsolute, join } from "node:path";
import type { ZoteroConfigInput, ZoteroTestResult } from "../shared/contracts";
import { isImportableZoteroItem, type ZoteroItem } from "../shared/zotero";

export type ResolvedZoteroConfig = ZoteroConfigInput & { apiKey: string };

export interface ZoteroDownloadedPdf {
  data: Buffer;
  fileName: string;
  url: string;
}

interface ZoteroCollection {
  key: string;
  data?: {
    name?: string;
  };
}

interface ZoteroResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: {
    get: (name: string) => string | null;
  };
  arrayBuffer: () => Promise<ArrayBuffer>;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

const PAGE_SIZE = 100;
const MAX_ZOTERO_PDF_BYTES = 120 * 1024 * 1024;

export async function testZoteroConnection(
  config: ResolvedZoteroConfig,
): Promise<ZoteroTestResult> {
  const collectionKeys = await resolveCollectionKeys(config);
  const endpoint = collectionKeys?.[0]
    ? `/collections/${collectionKeys[0]}/items/top`
    : "/items/top";
  const { items, total } = await fetchZoteroPage<ZoteroItem>(
    config,
    endpoint,
    0,
    1,
  );
  return {
    ok: true,
    detail: config.collection
      ? `已连接 Zotero，集合“${config.collection}”可用。`
      : "已连接 Zotero 文献库。",
    itemCount: total ?? items.length,
  };
}

export async function listZoteroLibraryItems(
  config: ResolvedZoteroConfig,
): Promise<ZoteroItem[]> {
  const collectionKeys = await resolveCollectionKeys(config);
  const endpoints = collectionKeys?.length
    ? collectionKeys.map((key) => `/collections/${key}/items/top`)
    : ["/items/top"];
  const byKey = new Map<string, ZoteroItem>();
  for (const endpoint of endpoints) {
    const items = await fetchAllZoteroItems<ZoteroItem>(config, endpoint);
    for (const item of items) {
      if (isImportableZoteroItem(item)) byKey.set(item.key, item);
    }
  }
  return [...byKey.values()];
}

export async function listZoteroItemChildren(
  config: ResolvedZoteroConfig,
  itemKey: string,
): Promise<ZoteroItem[]> {
  return fetchAllZoteroItems<ZoteroItem>(
    config,
    `/items/${encodeURIComponent(itemKey)}/children`,
  );
}

export async function downloadZoteroAttachment(
  config: ResolvedZoteroConfig,
  attachment: ZoteroItem,
): Promise<ZoteroDownloadedPdf | undefined> {
  const fileName = attachment.data.filename?.trim() || `${attachment.key}.pdf`;
  if (config.mode === "local" || config.dataDir.trim()) {
    const localData = await readLocalZoteroAttachment(
      config,
      attachment,
      fileName,
    );
    if (localData) {
      return {
        data: localData,
        fileName,
        url:
          attachment.links?.alternate?.href ||
          `zotero://open-pdf/library/items/${attachment.key}`,
      };
    }
  }

  const response = await fetchZotero(
    config,
    `/items/${encodeURIComponent(attachment.key)}/file`,
    {
      Accept: "application/pdf,*/*;q=0.8",
    },
  );
  if (!response.ok) return undefined;
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_ZOTERO_PDF_BYTES) return undefined;
  const data = Buffer.from(await response.arrayBuffer());
  if (!isPdf(data, response.headers.get("content-type"))) return undefined;
  return {
    data,
    fileName,
    url:
      attachment.links?.alternate?.href ||
      zoteroEndpoint(config, `/items/${attachment.key}/file`),
  };
}

async function resolveCollectionKeys(
  config: ResolvedZoteroConfig,
): Promise<string[] | undefined> {
  const requested = config.collection.trim().toLocaleLowerCase();
  if (!requested) return undefined;
  const collections = await fetchAllZoteroItems<ZoteroCollection>(
    config,
    "/collections",
  );
  const exact = collections.find(
    (collection) =>
      collection.data?.name?.trim().toLocaleLowerCase() === requested,
  );
  const partials = collections.filter((collection) =>
    collection.data?.name?.trim().toLocaleLowerCase().includes(requested),
  );
  const root = exact ?? (partials.length === 1 ? partials[0] : undefined);
  if (!root) {
    throw new Error(`Zotero 中未找到集合“${config.collection}”。`);
  }

  const keys: string[] = [];
  const pending = [root.key];
  const seen = new Set<string>();
  while (pending.length) {
    const key = pending.shift()!;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
    const children = await fetchAllZoteroItems<ZoteroCollection>(
      config,
      `/collections/${encodeURIComponent(key)}/collections`,
    );
    pending.push(...children.map((collection) => collection.key));
  }
  return keys;
}

async function fetchAllZoteroItems<T>(
  config: ResolvedZoteroConfig,
  endpoint: string,
): Promise<T[]> {
  const all: T[] = [];
  let start = 0;
  while (true) {
    const { items } = await fetchZoteroPage<T>(
      config,
      endpoint,
      start,
      PAGE_SIZE,
    );
    all.push(...items);
    if (items.length < PAGE_SIZE) return all;
    start += items.length;
  }
}

async function fetchZoteroPage<T>(
  config: ResolvedZoteroConfig,
  endpoint: string,
  start: number,
  limit: number,
): Promise<{ items: T[]; total?: number }> {
  const url = new URL(zoteroEndpoint(config, endpoint));
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("start", String(start));
  const response = await fetchZotero(config, url.toString());
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    if (
      config.mode === "local" &&
      response.status === 403 &&
      /local api is not enabled/i.test(detail)
    ) {
      throw new Error(
        "Zotero 本地 API 未启用，请在 Zotero 中启用本地 API，或改用 Web API。",
      );
    }
    throw new Error(`Zotero 请求失败 (${response.status})：${detail}`);
  }
  return {
    items: (await response.json()) as T[],
    total: parseOptionalNumber(response.headers.get("zotero-total-results")),
  };
}

async function fetchZotero(
  config: ResolvedZoteroConfig,
  endpointOrUrl: string,
  headers: Record<string, string> = { Accept: "application/json" },
): Promise<ZoteroResponse> {
  const url = /^https?:\/\//i.test(endpointOrUrl)
    ? endpointOrUrl
    : zoteroEndpoint(config, endpointOrUrl);
  const requestHeaders = {
    "Zotero-API-Version": "3",
    ...(config.mode === "web" && config.apiKey
      ? { "Zotero-API-Key": config.apiKey }
      : {}),
    ...headers,
  };
  try {
    return config.mode === "local"
      ? await fetchLocalZotero(url, requestHeaders)
      : await net.fetch(url, { headers: requestHeaders });
  } catch (error) {
    if (config.mode === "local") {
      throw new Error("无法连接 Zotero 本地 API，请先启动 Zotero。", {
        cause: error,
      });
    }
    throw error;
  }
}

function fetchLocalZotero(
  url: string,
  headers: Record<string, string>,
): Promise<ZoteroResponse> {
  return new Promise((resolve, reject) => {
    const clientRequest = request(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_ZOTERO_PDF_BYTES) {
          clientRequest.destroy(new Error("Zotero 响应超过 120 MB 限制。"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const data = Buffer.concat(chunks);
        const status = response.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          statusText: response.statusMessage ?? "",
          headers: {
            get: (name) => {
              const value = response.headers[name.toLowerCase()];
              return Array.isArray(value) ? value.join(", ") : (value ?? null);
            },
          },
          arrayBuffer: async () =>
            data.buffer.slice(
              data.byteOffset,
              data.byteOffset + data.byteLength,
            ) as ArrayBuffer,
          json: async () => JSON.parse(data.toString("utf8")) as unknown,
          text: async () => data.toString("utf8"),
        });
      });
    });
    clientRequest.setTimeout(60_000, () => {
      clientRequest.destroy(new Error("Zotero 本地 API 请求超时。"));
    });
    clientRequest.on("error", reject);
    clientRequest.end();
  });
}

function zoteroEndpoint(
  config: ResolvedZoteroConfig,
  endpoint: string,
): string {
  const normalized = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  if (config.mode === "local") {
    return `http://127.0.0.1:23119/api/users/0${normalized}`;
  }
  const scope =
    config.libraryType === "group"
      ? `groups/${encodeURIComponent(config.libraryId)}`
      : `users/${encodeURIComponent(config.libraryId)}`;
  return `https://api.zotero.org/${scope}${normalized}`;
}

async function readLocalZoteroAttachment(
  config: ResolvedZoteroConfig,
  attachment: ZoteroItem,
  fileName: string,
): Promise<Buffer | undefined> {
  const dataDir = config.dataDir.trim() || join(app.getPath("home"), "Zotero");
  const paths = new Set<string>();
  const attachmentPath = attachment.data.path?.trim();
  if (attachmentPath?.startsWith("storage:")) {
    paths.add(
      join(
        dataDir,
        "storage",
        attachment.key,
        attachmentPath.slice("storage:".length),
      ),
    );
  } else if (attachmentPath && isAbsolute(attachmentPath)) {
    paths.add(attachmentPath);
  }
  paths.add(join(dataDir, "storage", attachment.key, fileName));

  for (const path of paths) {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_ZOTERO_PDF_BYTES) continue;
      const data = await readFile(path);
      if (isPdf(data, "application/pdf")) return data;
    } catch {
      continue;
    }
  }
  return undefined;
}

function isPdf(data: Buffer, contentType: string | null): boolean {
  return (
    data.byteLength <= MAX_ZOTERO_PDF_BYTES &&
    (contentType?.toLowerCase().includes("pdf") === true ||
      data.subarray(0, 5).toString("ascii") === "%PDF-")
  );
}

async function readErrorDetail(response: ZoteroResponse): Promise<string> {
  try {
    return (await response.text()).trim().slice(0, 180) || response.statusText;
  } catch {
    return response.statusText;
  }
}

function parseOptionalNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
