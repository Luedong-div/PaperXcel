import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
  shell,
} from "electron";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AskPaperInput,
  ChatMessage,
  ComparePapersInput,
  CreateLibraryFolderInput,
  OpenAlexConfigInput,
  ImportPdfInput,
  LibrarySearchInput,
  LibrarySearchHit,
  Paper,
  PaperIdentifier,
  PaperMetadata,
  ProviderProfileInput,
  TranslationConfigInput,
  TranslationInput,
  ZoteroConfigInput,
  ZoteroPullResult,
} from "../shared/contracts";
import { buildCitationGraphSnapshot } from "../shared/citationGraph";
import {
  buildComparisonReportExport,
  comparisonReportFileName,
} from "../shared/comparisons";
import { buildPaperNoteExport, paperNoteFileName } from "../shared/notes";
import {
  mapZoteroItem,
  safeZoteroPdfFileName,
  selectZoteroPdfAttachment,
} from "../shared/zotero";
import {
  buildScihubPageUrls,
  DEFAULT_SCIHUB_MIRRORS,
  extractChemrxivPdfCandidates,
  extractCorePdfCandidates,
  extractCrossrefPdfCandidates,
  extractDoiResolverPdfCandidates,
  extractEuropePmcPdfCandidates,
  extractOpenAlexPdfCandidates,
  extractScihubPdfCandidates,
  extractSemanticScholarPdfCandidates,
  extractUnpaywallPdfCandidates,
  isLikelyScihubChallenge,
  looksLikePdfNetworkResponse,
  looksLikeScihubBlock,
  parseArxivAtomFeed,
  parsePaperIdentifier,
  normalizeDoiInput,
  resolvePdfCandidatesInOrder,
  shouldAttemptOpenAccessPdf,
  uniquePdfCandidates,
  type ArxivLookupResult,
  type CoreSearchResponse,
  type CrossrefMessageWithLinks,
  type EuropePmcResponse,
  type OpenAlexWork,
  type PdfCandidate,
  type SemanticScholarPaper,
  type UnpaywallResponse,
} from "./doiSources";
import {
  findPaperForMetadata,
  isWeakPaperTitle,
  mergePaperMetadata,
  shouldResumePaperProcessing,
} from "./paper-import";
import { AppStore } from "./store";
import {
  readSelectionImageDataUrl,
  removeSelectionImages,
  saveSelectionImage,
  selectionImagePath,
  selectionImageUrl,
} from "./selection-images";
import { refreshCitationGraphData } from "./citation-graph-service";
import { OpenAlexClient } from "./openalex-client";
import { BaiduTranslationClient } from "./baidu-translation-client";
import {
  downloadZoteroAttachment,
  listZoteroItemChildren,
  listZoteroLibraryItems,
  testZoteroConnection,
} from "./zotero-client";
import {
  askPaper,
  comparePapers,
  generatePaperNote,
  listProviderModels,
  testProvider,
} from "./provider";
import { WorkerClient } from "./worker-client";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "paperxcel",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

if (process.env.PAPERXCEL_E2E_USER_DATA) {
  app.setPath("userData", process.env.PAPERXCEL_E2E_USER_DATA);
}

const sessionDataPath = join(app.getPath("userData"), "session-data");
app.setPath("sessionData", sessionDataPath);
app.commandLine.appendSwitch("disk-cache-dir", join(sessionDataPath, "Cache"));
app.commandLine.appendSwitch(
  "gpu-disk-cache-dir",
  join(sessionDataPath, "GPUCache"),
);

let mainWindow: BrowserWindow | null = null;
let store: AppStore;
const worker = new WorkerClient();
const chatAbortControllers = new Map<string, AbortController>();
const MAX_AUTO_PDF_BYTES = 120 * 1024 * 1024;
const SCIHUB_SESSION_PARTITION = "persist:paperxcel-scihub";
let scihubVerificationWindow: BrowserWindow | null = null;

function selectCitationPapers(papers: Paper[], paperIds: unknown): Paper[] {
  if (!Array.isArray(paperIds)) return papers;
  const selectedIds = new Set(
    paperIds.filter(
      (paperId): paperId is string => typeof paperId === "string",
    ),
  );
  return papers.filter((paper) => selectedIds.has(paper.id));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

interface PaperLookupResult {
  metadata: PaperMetadata;
  pdfCandidates: PdfCandidate[];
}

interface DownloadedPdf {
  data: Buffer;
  url: string;
  source: string;
  fileName?: string;
}

interface PdfResolution {
  downloaded?: DownloadedPdf;
  manualUrl?: string;
  scihubChallengeDetected?: boolean;
}

interface ScihubLookupResult {
  candidates: PdfCandidate[];
  challengeUrl?: string;
}

worker.on(
  "progress",
  (payload: { paper_id?: string; stage?: string; progress?: number }) => {
    if (!store || !payload.paper_id) return;
    const paper = store.getPaper(payload.paper_id);
    if (!paper || paper.status === "error" || paper.status === "ready") return;
    emitPaper(
      store.savePaper({
        ...paper,
        status: "processing",
        progress: Math.max(0, Math.min(payload.progress ?? paper.progress, 99)),
        statusText: payload.stage || paper.statusText,
        updatedAt: new Date().toISOString(),
      }),
    );
  },
);

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    icon: join(__dirname, "../renderer/paperxcel.png"),
    backgroundColor: "#f4f5f1",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#f4f5f1",
      symbolColor: "#202420",
      height: 32,
    },
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  store = new AppStore();
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  await protocol.handle("paperxcel", async (request) => {
    const url = new URL(request.url);
    if (url.hostname === "selection") {
      try {
        const id = decodeURIComponent(url.pathname.slice(1));
        return net.fetch(pathToFileURL(selectionImagePath(id)).toString());
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }
    if (url.hostname !== "paper")
      return new Response("Not found", { status: 404 });
    const id = decodeURIComponent(url.pathname.slice(1));
    const filePath = store.resolvePaperPath(id);
    if (!filePath) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString());
  });
  await migrateLegacySelectionImages();
  registerIpc();
  createWindow();
  resumeRecoverablePaperProcessing();
  void worker.start();
  if (process.env.PAPERXCEL_E2E_FIXTURE_PDF) {
    void importPdf(process.env.PAPERXCEL_E2E_FIXTURE_PDF);
  }
  if (process.env.PAPERXCEL_E2E_FIXTURE_PDF_2) {
    void importPdf(process.env.PAPERXCEL_E2E_FIXTURE_PDF_2);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => worker.stop());

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

function resumeRecoverablePaperProcessing(): void {
  for (const paper of store.listPapers()) {
    const filePath = store.resolvePaperPath(paper.id);
    if (!shouldResumePaperProcessing(paper, Boolean(filePath))) continue;
    queuePaperProcessing(paper);
  }
}

function queuePaperProcessing(
  paper: Paper,
  statusText = "绛夊緟閲嶆柊瑙ｆ瀽",
): Paper {
  const queued = store.savePaper({
    ...paper,
    status: "queued",
    progress: 2,
    statusText,
    error: undefined,
    updatedAt: new Date().toISOString(),
  });
  emitPaper(queued);
  void processPaper(queued);
  return queued;
}

function registerIpc(): void {
  ipcMain.handle("clipboard:write-text", (_event, text: string) => {
    clipboard.writeText(typeof text === "string" ? text : String(text ?? ""));
  });

  ipcMain.handle("papers:list", () => store.listPapers());
  ipcMain.handle("papers:file-url", (_event, id: string) => {
    return store.resolvePaperPath(id)
      ? `paperxcel://paper/${encodeURIComponent(id)}`
      : null;
  });
  ipcMain.handle("papers:import", async (_event, input?: ImportPdfInput) => {
    const selected = await dialog.showOpenDialog(mainWindow!, {
      title: "导入 PDF 文献",
      properties: ["openFile"],
      filters: [{ name: "PDF 文献", extensions: ["pdf"] }],
    });
    if (selected.canceled || !selected.filePaths[0]) return null;
    return importPdf(
      selected.filePaths[0],
      input?.mergeIntoId,
      input?.folderId,
    );
  });
  ipcMain.handle(
    "papers:import-path",
    (_event, sourcePath: string, input?: ImportPdfInput) => {
      if (
        !sourcePath ||
        !isAbsolute(sourcePath) ||
        extname(sourcePath).toLowerCase() !== ".pdf"
      ) {
        throw new Error("只能拖入本机 PDF 文件。");
      }
      return importPdf(sourcePath, input?.mergeIntoId, input?.folderId);
    },
  );
  ipcMain.handle("papers:add-identifier", async (_event, input: string) => {
    const identifier = parsePaperIdentifier(input);
    return addPaperFromIdentifier(identifier);
  });
  ipcMain.handle("papers:remove", async (_event, id: string) => {
    const imageIds = selectionImageIds(store.listChatMessages(id));
    store.removePaper(id);
    const indexPath = join(app.getPath("userData"), "indexes", `${id}.sqlite3`);
    await Promise.all([
      rm(join(app.getPath("userData"), "library", id), {
        recursive: true,
        force: true,
      }),
      rm(indexPath, { force: true }),
      rm(`${indexPath}-wal`, { force: true }),
      rm(`${indexPath}-shm`, { force: true }),
    ]);
    await removeSelectionImages(imageIds);
  });
  ipcMain.handle("papers:reorder", (_event, paperIds: string[]) =>
    store.reorderPapers(paperIds),
  );
  ipcMain.handle("papers:toggle-star", (_event, id: string) => {
    const paper = store.getPaper(id);
    if (!paper) throw new Error("文献不存在。");
    return store.savePaper({
      ...paper,
      starred: !paper.starred,
      updatedAt: new Date().toISOString(),
    });
  });
  ipcMain.handle(
    "papers:set-archive",
    (_event, id: string, archived: boolean) =>
      store.setPaperArchived(id, archived),
  );
  ipcMain.handle(
    "papers:move-folder",
    (_event, id: string, folderId?: string) => {
      const paper = store.movePaperToFolder(id, folderId);
      emitPaper(paper);
      return paper;
    },
  );
  ipcMain.handle("folders:list", () => store.listFolders());
  ipcMain.handle("folders:create", (_event, input: CreateLibraryFolderInput) =>
    store.createFolder(input),
  );
  ipcMain.handle("folders:rename", (_event, id: string, name: string) =>
    store.renameFolder(id, name),
  );
  ipcMain.handle("folders:remove", (_event, id: string) =>
    store.removeFolder(id),
  );
  ipcMain.handle("papers:reprocess", (_event, id: string) => {
    const paper = store.getPaper(id);
    if (!paper || !store.resolvePaperPath(id)) {
      throw new Error("当前文献没有可重新解析的 PDF。");
    }
    const queued = store.savePaper({
      ...paper,
      status: "queued",
      progress: 2,
      statusText: "等待重新解析",
      error: undefined,
      updatedAt: new Date().toISOString(),
    });
    emitPaper(queued);
    void processPaper(queued);
    return queued;
  });
  ipcMain.handle("papers:open-source", async (_event, id: string) => {
    const url = store.getPaper(id)?.sourceUrl;
    if (url?.startsWith("https://")) await shell.openExternal(url);
  });
  ipcMain.handle("papers:open-manual-pdf-page", async (_event, id: string) => {
    const url = store.getPaper(id)?.manualPdfUrl;
    if (url?.startsWith("https://")) await shell.openExternal(url);
  });
  ipcMain.handle("papers:show-in-folder", (_event, id: string) => {
    const filePath = store.resolvePaperPath(id);
    if (!filePath) throw new Error("当前文献没有本地 PDF。");
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle("settings:get-scihub-enabled", () => store.getScihubEnabled());
  ipcMain.handle("settings:set-scihub-enabled", (_event, enabled: boolean) => {
    store.setScihubEnabled(Boolean(enabled));
    return store.getScihubEnabled();
  });
  ipcMain.handle("translation:get-config", () => store.getTranslationConfig());
  ipcMain.handle(
    "translation:save-config",
    (_event, input: TranslationConfigInput) =>
      store.saveTranslationConfig(input),
  );
  ipcMain.handle(
    "translation:test",
    (_event, input: TranslationConfigInput) => {
      const credentials = store.resolveTranslationCredentials(input);
      return new BaiduTranslationClient(
        credentials.appId,
        credentials.secretKey,
      ).test();
    },
  );
  ipcMain.handle("translation:translate", (_event, input: TranslationInput) => {
    const credentials = store.resolveTranslationCredentials();
    return new BaiduTranslationClient(
      credentials.appId,
      credentials.secretKey,
    ).translate(input.text);
  });

  ipcMain.handle("openalex:get-config", () => store.getOpenAlexConfig());
  ipcMain.handle("openalex:save-config", (_event, input: OpenAlexConfigInput) =>
    store.saveOpenAlexConfig(input),
  );
  ipcMain.handle("openalex:test", (_event, input: OpenAlexConfigInput) =>
    new OpenAlexClient(store.resolveOpenAlexApiKey(input)).test(),
  );
  ipcMain.handle("citation-graph:get", (_event, paperIds?: unknown) =>
    buildCitationGraphSnapshot(
      selectCitationPapers(store.listPapers(), paperIds),
      store.getCitationGraphCache(),
    ),
  );
  ipcMain.handle(
    "citation-graph:refresh",
    async (_event, force = false, paperIds?: unknown) => {
      const papers = selectCitationPapers(store.listPapers(), paperIds);
      const { cache, result } = await refreshCitationGraphData({
        papers,
        cache: store.getCitationGraphCache(),
        client: new OpenAlexClient(store.resolveOpenAlexApiKey()),
        force: Boolean(force),
        extractLocalReferenceDois: async (paper) => {
          if (paper.status !== "ready") return [];
          return worker.request<string[]>(
            "reference_dois",
            {
              paper_id: paper.id,
              index_dir: join(app.getPath("userData"), "indexes"),
            },
            30_000,
          );
        },
        extractLocalReferenceCitations: async (paper) => {
          if (paper.status !== "ready") return [];
          return worker.request<string[]>(
            "reference_citations",
            {
              paper_id: paper.id,
              index_dir: join(app.getPath("userData"), "indexes"),
            },
            30_000,
          );
        },
      });
      store.saveCitationGraphCache(cache);
      return result;
    },
  );

  ipcMain.handle("zotero:get-config", () => store.getZoteroConfig());
  ipcMain.handle("zotero:save-config", (_event, input: ZoteroConfigInput) =>
    store.saveZoteroConfig(input),
  );
  ipcMain.handle("zotero:choose-data-dir", async () => {
    const selected = await dialog.showOpenDialog(mainWindow!, {
      title: "选择 Zotero 数据目录",
      properties: ["openDirectory"],
    });
    return selected.canceled ? null : (selected.filePaths[0] ?? null);
  });
  ipcMain.handle("zotero:test", (_event, input: ZoteroConfigInput) =>
    testZoteroConnection(store.resolveZoteroConfig(input)),
  );
  ipcMain.handle("zotero:pull", (_event, input: ZoteroConfigInput) =>
    importZoteroLibrary(input),
  );

  ipcMain.handle("providers:list", () => store.listProviders());
  ipcMain.handle("providers:save", (_event, input: ProviderProfileInput) =>
    store.saveProvider(input),
  );
  ipcMain.handle("providers:remove", (_event, id: string) =>
    store.removeProvider(id),
  );
  ipcMain.handle("providers:set-active", (_event, id: string) =>
    store.setActiveProvider(id),
  );
  ipcMain.handle("providers:test", (_event, input: ProviderProfileInput) =>
    testProvider(resolveProviderInput(input)),
  );
  ipcMain.handle("providers:models", (_event, input: ProviderProfileInput) =>
    listProviderModels(resolveProviderInput(input)),
  );

  ipcMain.handle("chat:list", (_event, paperId: string) =>
    store.listChatMessages(paperId),
  );
  ipcMain.handle(
    "chat:append",
    async (_event, paperId: string, message: ChatMessage) => {
      const previousImageIds = selectionImageIds(
        store.listChatMessages(paperId),
      );
      const next = store.appendChatMessage(paperId, message);
      const nextImageIds = new Set(selectionImageIds(next));
      await removeSelectionImages(
        previousImageIds.filter((id) => !nextImageIds.has(id)),
      );
      return next;
    },
  );
  ipcMain.handle("chat:clear", async (_event, paperId: string) => {
    const imageIds = selectionImageIds(store.listChatMessages(paperId));
    store.clearChatMessages(paperId);
    await removeSelectionImages(imageIds);
  });
  ipcMain.handle(
    "chat:replace",
    async (_event, paperId: string, messages: ChatMessage[]) => {
      const previousImageIds = selectionImageIds(
        store.listChatMessages(paperId),
      );
      const next = store.replaceChatMessages(paperId, messages);
      const nextImageIds = new Set(selectionImageIds(next));
      await removeSelectionImages(
        previousImageIds.filter((id) => !nextImageIds.has(id)),
      );
      return next;
    },
  );
  ipcMain.handle("selection-images:save", async (_event, dataUrl: string) => {
    const id = await saveSelectionImage(dataUrl);
    return { id, url: selectionImageUrl(id) };
  });
  ipcMain.handle("chat:ask", async (_event, input: AskPaperInput) => {
    const controller = new AbortController();
    if (input.requestId) {
      chatAbortControllers.set(input.requestId, controller);
    }
    try {
      return await askPaper(
        store.getActiveProvider(),
        worker,
        {
          ...input,
          selectedSnippets: await hydrateSelectionImages(
            input.selectedSnippets,
          ),
          indexDir: join(app.getPath("userData"), "indexes"),
        } as AskPaperInput & { indexDir: string },
        { signal: controller.signal },
      );
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        return { cancelled: true };
      }
      throw error;
    } finally {
      if (input.requestId) {
        chatAbortControllers.delete(input.requestId);
      }
    }
  });
  ipcMain.handle("chat:cancel", (_event, requestId: string) => {
    const controller = chatAbortControllers.get(requestId);
    if (!controller) return false;
    controller.abort();
    chatAbortControllers.delete(requestId);
    return true;
  });

  ipcMain.handle("notes:get", (_event, paperId: string) =>
    store.getPaperNote(paperId),
  );
  ipcMain.handle("notes:save", (_event, paperId: string, content: string) =>
    store.savePaperNote(paperId, content),
  );
  ipcMain.handle("notes:generate", async (_event, paperId: string) => {
    const paper = store.getPaper(paperId);
    if (!paper) throw new Error("文献不存在。");
    const result = await generatePaperNote(store.getActiveProvider(), worker, {
      paperId,
      title: paper.title,
      indexDir: join(app.getPath("userData"), "indexes"),
    });
    return {
      note: store.savePaperNote(paperId, result.content),
      protocol: result.protocol,
      model: result.model,
    };
  });
  ipcMain.handle("notes:export-markdown", async (_event, paperId: string) => {
    const paper = store.getPaper(paperId);
    const note = store.getPaperNote(paperId);
    if (!paper) throw new Error("文献不存在。");
    if (!note?.content.trim()) throw new Error("当前文献还没有可导出的笔记。");
    const selected = await dialog.showSaveDialog(mainWindow!, {
      title: "导出阅读笔记",
      defaultPath: join(app.getPath("documents"), paperNoteFileName(paper)),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (selected.canceled || !selected.filePath) return false;
    await writeFile(
      selected.filePath,
      buildPaperNoteExport(paper, note),
      "utf8",
    );
    return true;
  });

  ipcMain.handle("comparisons:list", () => store.listComparisonReports());
  ipcMain.handle(
    "comparisons:generate",
    async (_event, input: ComparePapersInput) => {
      const paperIds = [...new Set(input.paperIds)];
      if (paperIds.length < 2 || paperIds.length > 5) {
        throw new Error("请选择 2 至 5 篇文献进行比较。");
      }
      const papers = paperIds.map((paperId) => store.getPaper(paperId));
      if (papers.some((paper) => !paper)) {
        throw new Error("所选文献中包含已移除的项目。");
      }
      const readyPapers = papers.filter(
        (paper): paper is Paper => paper?.status === "ready",
      );
      if (readyPapers.length !== papers.length) {
        throw new Error("只能比较已完成索引的文献。");
      }
      const result = await comparePapers(store.getActiveProvider(), worker, {
        papers: readyPapers.map((paper) => ({
          id: paper.id,
          title: paper.title,
        })),
        question: input.question,
        indexDir: join(app.getPath("userData"), "indexes"),
      });
      return store.saveComparisonReport({
        id: crypto.randomUUID(),
        ...result,
        createdAt: new Date().toISOString(),
      });
    },
  );
  ipcMain.handle("comparisons:remove", (_event, reportId: string) =>
    store.removeComparisonReport(reportId),
  );
  ipcMain.handle(
    "comparisons:export-markdown",
    async (_event, reportId: string) => {
      const report = store.getComparisonReport(reportId);
      if (!report) throw new Error("比较报告不存在。");
      const selected = await dialog.showSaveDialog(mainWindow!, {
        title: "导出跨文献研究矩阵",
        defaultPath: join(
          app.getPath("documents"),
          comparisonReportFileName(report),
        ),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (selected.canceled || !selected.filePath) return false;
      await writeFile(
        selected.filePath,
        buildComparisonReportExport(report, store.listPapers()),
        "utf8",
      );
      return true;
    },
  );

  ipcMain.handle(
    "search:library",
    async (_event, input: LibrarySearchInput): Promise<LibrarySearchHit[]> => {
      const query = input.query.trim();
      if (!query) return [];
      if (query.length > 500) {
        throw new Error("全库搜索问题不能超过 500 个字符。");
      }
      const paperIds = store
        .listPapers()
        .filter((paper) => paper.status === "ready")
        .map((paper) => paper.id);
      if (!paperIds.length) return [];
      const hits = await worker.request<
        Array<{
          paper_id: string;
          chunk_id: string;
          page: number;
          text: string;
          score: number;
        }>
      >(
        "search_library",
        {
          paper_ids: paperIds,
          query,
          index_dir: join(app.getPath("userData"), "indexes"),
          limit: Math.max(1, Math.min(input.limit ?? 30, 60)),
          per_paper_limit: 4,
        },
        240_000,
      );
      return hits.map((hit) => ({
        paperId: hit.paper_id,
        chunkId: hit.chunk_id,
        page: hit.page,
        text: hit.text,
        score: hit.score,
      }));
    },
  );

  ipcMain.handle("worker:status", () => worker.status());
}

async function hydrateSelectionImages(
  snippets: AskPaperInput["selectedSnippets"],
): Promise<AskPaperInput["selectedSnippets"]> {
  if (!snippets?.length) return snippets;
  return Promise.all(
    snippets.map(async (snippet) => ({
      ...snippet,
      imageDataUrl:
        snippet.imageDataUrl ??
        (snippet.imageAssetId
          ? await readSelectionImageDataUrl(snippet.imageAssetId)
          : undefined),
    })),
  );
}

function selectionImageIds(messages: ChatMessage[]): string[] {
  return messages.flatMap((message) =>
    (message.selectedSnippets ?? [])
      .map((snippet) => snippet.imageAssetId)
      .filter((id): id is string => Boolean(id)),
  );
}

async function migrateLegacySelectionImages(): Promise<void> {
  for (const paper of store.listPapers()) {
    const messages = store.listChatMessages(paper.id);
    let changed = false;
    const migrated = await Promise.all(
      messages.map(async (message) => ({
        ...message,
        selectedSnippets: message.selectedSnippets
          ? await Promise.all(
              message.selectedSnippets.map(async (snippet) => {
                if (!snippet.imageDataUrl || snippet.imageAssetId)
                  return snippet;
                try {
                  const imageAssetId = await saveSelectionImage(
                    snippet.imageDataUrl,
                  );
                  changed = true;
                  const {
                    imageDataUrl: _legacyImageDataUrl,
                    ...withoutImageData
                  } = snippet;
                  return { ...withoutImageData, imageAssetId };
                } catch {
                  return snippet;
                }
              }),
            )
          : undefined,
      })),
    );
    if (changed) store.replaceChatMessages(paper.id, migrated);
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      /aborted|aborterror|apiuseraborterror|cancelled|canceled/i.test(
        error.message,
      ))
  );
}

async function importZoteroLibrary(
  input: ZoteroConfigInput,
): Promise<ZoteroPullResult> {
  const config = store.resolveZoteroConfig(input);
  const items = await listZoteroLibraryItems(config);
  const imported: Paper[] = [];
  const queued: Paper[] = [];
  let skipped = 0;
  let withoutPdf = 0;
  let failed = 0;

  const existingPapers = store.listPapers();
  const libraryId =
    config.mode === "local"
      ? "local"
      : `${config.libraryType}:${config.libraryId}`;
  const byZoteroKey = new Map(
    existingPapers
      .filter(
        (paper) => paper.zoteroItemKey && paper.zoteroLibraryId === libraryId,
      )
      .map((paper) => [paper.zoteroItemKey!, paper]),
  );
  const byDoi = new Map(
    existingPapers
      .filter((paper) => paper.doi)
      .map((paper) => [paper.doi!.toLocaleLowerCase(), paper]),
  );
  for (const item of items) {
    const metadata = mapZoteroItem(
      item,
      config.mode === "web" && config.libraryType === "user"
        ? config.libraryId
        : undefined,
    );
    let paper =
      byZoteroKey.get(item.key) ??
      (metadata.doi ? byDoi.get(metadata.doi.toLocaleLowerCase()) : undefined);
    if (paper?.fileName) {
      skipped += 1;
      continue;
    }

    const now = new Date().toISOString();
    paper = store.savePaper({
      id: paper?.id ?? crypto.randomUUID(),
      title: paper?.title || metadata.title,
      authors: paper?.authors.length ? paper.authors : metadata.authors,
      journal: paper?.journal || metadata.journal,
      year: paper?.year || metadata.year,
      doi: paper?.doi || metadata.doi,
      arxivId: paper?.arxivId,
      arxivVersion: paper?.arxivVersion,
      abstract: paper?.abstract || metadata.abstract,
      sourceUrl: paper?.sourceUrl || metadata.sourceUrl,
      zoteroItemKey: item.key,
      zoteroLibraryId: libraryId,
      status: "needs_file",
      progress: 0,
      statusText: "正在从 Zotero 获取 PDF",
      starred: paper?.starred ?? false,
      archived: paper?.archived ?? false,
      tags: [...new Set([...(paper?.tags ?? []), ...metadata.tags])],
      createdAt: paper?.createdAt ?? now,
      updatedAt: now,
    });
    emitPaper(paper);
    byZoteroKey.set(item.key, paper);
    if (paper.doi) byDoi.set(paper.doi.toLocaleLowerCase(), paper);

    try {
      const children = await listZoteroItemChildren(config, item.key);
      const attachment = selectZoteroPdfAttachment(children);
      if (!attachment) {
        paper = store.savePaper({
          ...paper,
          statusText: "Zotero 条目未找到 PDF",
          updatedAt: new Date().toISOString(),
        });
        emitPaper(paper);
        imported.push(paper);
        withoutPdf += 1;
        continue;
      }

      const downloaded = await downloadZoteroAttachment(config, attachment);
      if (!downloaded) {
        paper = store.savePaper({
          ...paper,
          statusText: "Zotero PDF 无法读取或下载",
          updatedAt: new Date().toISOString(),
        });
        emitPaper(paper);
        imported.push(paper);
        failed += 1;
        continue;
      }

      const queuedPaper = await attachDownloadedPdf(
        paper,
        {
          data: downloaded.data,
          fileName: downloaded.fileName,
          url: downloaded.url,
          source: "Zotero",
        },
        { process: false },
      );
      imported.push(queuedPaper);
      queued.push(queuedPaper);
    } catch (error) {
      const failedPaper = store.savePaper({
        ...paper,
        statusText: "Zotero 拉取失败",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      });
      emitPaper(failedPaper);
      imported.push(failedPaper);
      failed += 1;
    }
  }

  if (queued.length) void processPapersSequentially(queued);
  const detail = `Zotero 拉取完成：导入 ${imported.length} 篇，跳过 ${skipped} 篇，缺少 PDF ${withoutPdf} 篇，失败 ${failed} 篇。`;
  return { imported, skipped, withoutPdf, failed, detail };
}

async function processPapersSequentially(papers: Paper[]): Promise<void> {
  for (const paper of papers) {
    const current = store.getPaper(paper.id);
    if (!current || current.status !== "queued") continue;
    await processPaper(current);
  }
}

async function importPdf(
  sourcePath: string,
  mergeIntoId?: string,
  folderId?: string,
): Promise<Paper> {
  const existing = mergeIntoId ? store.getPaper(mergeIntoId) : undefined;
  const id = existing?.id ?? crypto.randomUUID();
  const directory = join(app.getPath("userData"), "library", id);
  await mkdir(directory, { recursive: true });
  await copyFile(sourcePath, join(directory, "source.pdf"));
  const fileInfo = await stat(sourcePath);
  const fileName = sourcePath.split(/[\\/]/).pop() || "paper.pdf";
  const now = new Date().toISOString();
  const paper = store.savePaper({
    id,
    title: existing?.title || fileName.replace(/\.pdf$/i, ""),
    authors: existing?.authors ?? [],
    journal: existing?.journal,
    year: existing?.year,
    doi: existing?.doi,
    arxivId: existing?.arxivId,
    arxivVersion: existing?.arxivVersion,
    abstract: existing?.abstract,
    sourceUrl: existing?.sourceUrl,
    fileName,
    fileSize: fileInfo.size,
    status: "queued",
    progress: 2,
    statusText: "等待解析",
    starred: existing?.starred ?? false,
    archived: existing?.archived ?? false,
    folderId: folderId ?? existing?.folderId,
    tags: existing?.tags ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  emitPaper(paper);
  void processPaper(paper);
  return paper;
}

async function addPaperFromIdentifier(
  identifier: PaperIdentifier,
): Promise<Paper> {
  if (identifier.kind === "doi") {
    let doiLookup: PaperLookupResult | undefined;
    let doiError: unknown;
    try {
      doiLookup = await lookupDoiWithPdfLinks(identifier.doi);
    } catch (error) {
      doiError = error;
    }

    // Crossref 不是所有 DOI 的唯一元数据来源。即使它失败，也继续用 DOI
    // 查询 arXiv；arXiv 条目可能已经记录了出版社 DOI 和自己的 PDF。
    const arxivLookup = await lookupArxivByDoi(identifier.doi);
    if (!doiLookup && !arxivLookup) {
      throw doiError instanceof Error
        ? doiError
        : new Error(`未找到 DOI ${identifier.doi} 对应的论文。`);
    }

    if (!doiLookup) {
      const metadata: PaperMetadata = {
        ...arxivLookup!.metadata,
        doi: identifier.doi,
      };
      return saveImportedPaper(metadata, arxivLookup!.pdfCandidates, true);
    }

    const doi = doiLookup.metadata.doi;
    const linkedArxivLookup =
      doi && doi.toLowerCase() === identifier.doi.toLowerCase()
        ? arxivLookup
        : await lookupArxivByDoi(doi ?? identifier.doi);
    const metadata: PaperMetadata = {
      ...doiLookup.metadata,
      arxivId: linkedArxivLookup?.metadata.arxivId,
      arxivVersion: linkedArxivLookup?.metadata.arxivVersion,
    };
    return saveImportedPaper(
      metadata,
      [...doiLookup.pdfCandidates, ...(linkedArxivLookup?.pdfCandidates ?? [])],
      Boolean(linkedArxivLookup?.metadata.arxivId),
    );
  }

  const arxivLookup = await lookupArxivWithPdfLinks(identifier);
  let crossrefLookup: PaperLookupResult | undefined;
  if (arxivLookup.metadata.doi) {
    try {
      crossrefLookup = await lookupDoiWithPdfLinks(arxivLookup.metadata.doi);
    } catch {
      crossrefLookup = undefined;
    }
  }
  const metadata: PaperMetadata = {
    ...arxivLookup.metadata,
    journal: crossrefLookup?.metadata.journal || arxivLookup.metadata.journal,
    year: crossrefLookup?.metadata.year || arxivLookup.metadata.year,
    doi: crossrefLookup?.metadata.doi || arxivLookup.metadata.doi,
    sourceUrl: arxivLookup.metadata.sourceUrl,
  };
  return saveImportedPaper(
    metadata,
    [...arxivLookup.pdfCandidates, ...(crossrefLookup?.pdfCandidates ?? [])],
    true,
  );
}

async function saveImportedPaper(
  metadata: PaperMetadata,
  pdfCandidates: PdfCandidate[],
  forceOpenAccessPdf: boolean,
): Promise<Paper> {
  const existing = findPaperForMetadata(store.listPapers(), metadata);
  const now = new Date().toISOString();
  const paper = existing
    ? store.savePaper(mergePaperMetadata(existing, metadata, now))
    : store.savePaper({
        id: crypto.randomUUID(),
        title: metadata.title,
        authors: metadata.authors,
        journal: metadata.journal,
        year: metadata.year,
        doi: metadata.doi,
        arxivId: metadata.arxivId,
        arxivVersion: metadata.arxivVersion,
        abstract: metadata.abstract,
        sourceUrl: metadata.sourceUrl,
        status: "needs_file",
        progress: 0,
        statusText:
          forceOpenAccessPdf || shouldAttemptOpenAccessPdf(metadata.year)
            ? "正在查找开放获取 PDF"
            : undefined,
        starred: false,
        archived: false,
        tags: [],
        createdAt: now,
        updatedAt: now,
      });
  if (
    paper.status === "error" &&
    paper.error === "PDF file does not exist." &&
    store.resolvePaperPath(paper.id)
  ) {
    return queuePaperProcessing(paper);
  }
  emitPaper(paper);
  return addOpenAccessPdfIfAvailable(
    paper,
    metadata,
    pdfCandidates,
    forceOpenAccessPdf,
  );
}

async function addOpenAccessPdfIfAvailable(
  paper: Paper,
  metadata: PaperMetadata,
  crossrefCandidates: PdfCandidate[],
  force = false,
): Promise<Paper> {
  if (
    paper.status !== "needs_file" ||
    (!force && !shouldAttemptOpenAccessPdf(metadata.year))
  ) {
    return paper;
  }

  if (!metadata.doi && metadata.arxivId) {
    return attachArxivPdfIfAvailable(paper, crossrefCandidates);
  }
  if (!metadata.doi) return paper;

  const resolution = await resolveOpenAccessPdf(
    metadata.doi,
    crossrefCandidates,
  );
  if (!resolution.downloaded) {
    const manualPdfUrl =
      resolution.manualUrl ||
      metadata.sourceUrl ||
      `https://doi.org/${metadata.doi}`;
    const updated = store.savePaper({
      ...paper,
      manualPdfUrl,
      statusText: resolution.scihubChallengeDetected
        ? "Sci-Hub 需要人机验证。请在浏览器完成验证并下载 PDF，然后拖入或点击“添加 PDF”。"
        : "未在开放获取来源找到可直接下载的 PDF。可在浏览器打开来源页面，或手动添加 PDF。",
      updatedAt: new Date().toISOString(),
    });
    emitPaper(updated);
    return updated;
  }

  return attachDownloadedPdf(paper, resolution.downloaded);
}

async function attachArxivPdfIfAvailable(
  paper: Paper,
  candidates: PdfCandidate[],
): Promise<Paper> {
  const downloaded = await resolvePdfCandidatesInOrder(
    [() => Promise.resolve(candidates)],
    downloadPdfCandidate,
  );
  if (!downloaded) {
    const updated = store.savePaper({
      ...paper,
      statusText: "未能从 arXiv 下载 PDF，请稍后重试或手动添加 PDF",
      updatedAt: new Date().toISOString(),
    });
    emitPaper(updated);
    return updated;
  }
  return attachDownloadedPdf(paper, downloaded);
}

async function attachDownloadedPdf(
  existing: Paper,
  downloaded: DownloadedPdf,
  options: { process?: boolean } = {},
): Promise<Paper> {
  const directory = join(app.getPath("userData"), "library", existing.id);
  const fileName = safeZoteroPdfFileName(downloaded.fileName);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, fileName), downloaded.data);
  const now = new Date().toISOString();
  const paper = store.savePaper({
    ...existing,
    sourceUrl: existing.sourceUrl || downloaded.url,
    manualPdfUrl: undefined,
    fileName,
    fileSize: downloaded.data.byteLength,
    status: "queued",
    progress: 2,
    statusText: `已从 ${downloaded.source} 获取 PDF，等待解析`,
    updatedAt: now,
  });
  emitPaper(paper);
  if (options.process !== false) void processPaper(paper);
  return paper;
}

async function processPaper(paper: Paper): Promise<void> {
  try {
    emitPaper(
      store.savePaper({
        ...paper,
        status: "processing",
        progress: 8,
        statusText: "解析页面与公式区域",
        updatedAt: new Date().toISOString(),
      }),
    );
    const result = await worker.request<{
      page_count: number;
      title_guess?: string;
      authors_guess?: string[];
      journal_guess?: string;
      year_guess?: number;
      doi_guess?: string;
      chunk_count: number;
      semantic_ready: boolean;
    }>(
      "extract",
      {
        paper_id: paper.id,
        pdf_path: store.resolvePaperPath(paper.id),
        index_dir: join(app.getPath("userData"), "indexes"),
      },
      900_000,
    );
    const current = store.getPaper(paper.id);
    if (!current) return;
    const detectedDoi = current.doi || result.doi_guess;
    let doiMetadata: PaperMetadata | undefined;
    if (
      detectedDoi &&
      (isWeakPaperTitle(current.title, current.fileName) ||
        current.authors.length === 0 ||
        !current.year ||
        !current.journal)
    ) {
      try {
        doiMetadata = await lookupDoi(detectedDoi);
      } catch {
        doiMetadata = undefined;
      }
    }
    const replaceTitle = isWeakPaperTitle(current.title, current.fileName);
    emitPaper(
      store.savePaper({
        ...current,
        title: replaceTitle
          ? doiMetadata?.title || result.title_guess || current.title
          : current.title,
        authors:
          current.authors.length > 0
            ? current.authors
            : doiMetadata?.authors.length
              ? doiMetadata.authors
              : (result.authors_guess ?? []),
        journal:
          current.journal || doiMetadata?.journal || result.journal_guess,
        year: current.year || doiMetadata?.year || result.year_guess,
        doi: current.doi || doiMetadata?.doi || result.doi_guess,
        abstract: current.abstract || doiMetadata?.abstract,
        sourceUrl: current.sourceUrl || doiMetadata?.sourceUrl,
        pageCount: result.page_count,
        status: "ready",
        progress: 100,
        statusText: result.semantic_ready
          ? `已索引 ${result.chunk_count} 个证据片段`
          : `已建立关键词索引，共 ${result.chunk_count} 个片段`,
        updatedAt: new Date().toISOString(),
      }),
    );
  } catch (error) {
    const current = store.getPaper(paper.id);
    if (!current) return;
    emitPaper(
      store.savePaper({
        ...current,
        status: "error",
        progress: 0,
        statusText: "解析失败",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      }),
    );
  }
}

function resolveProviderInput(
  input: ProviderProfileInput,
): ProviderProfileInput {
  if (input.apiKey?.trim() || !input.id) return input;
  try {
    return {
      ...input,
      apiKey: store.getProviderCredentials(input.id).apiKey,
    };
  } catch {
    return input;
  }
}

async function lookupDoi(value: string): Promise<PaperMetadata> {
  return (await lookupDoiWithPdfLinks(value)).metadata;
}

async function lookupDoiWithPdfLinks(
  value: string,
): Promise<PaperLookupResult> {
  const doi = normalizeDoiInput(value);
  let response: Response;
  try {
    response = await net.fetch(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
      { headers: { Accept: "application/json" } },
    );
  } catch {
    throw new Error("无法连接 Crossref，请检查网络后重试。");
  }
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Crossref 未找到该 DOI (${response.status})。`);
    }
    throw new Error(`Crossref 查询失败 (${response.status})。`);
  }
  const payload = (await response.json()) as {
    message: {
      title?: string[];
      author?: Array<{ given?: string; family?: string }>;
      "container-title"?: string[];
      published?: { "date-parts"?: number[][] };
      created?: { "date-parts"?: number[][] };
      abstract?: string;
      URL?: string;
      DOI?: string;
    } & CrossrefMessageWithLinks;
  };
  const message = payload.message;
  return {
    metadata: {
      title: message.title?.[0] || doi,
      authors:
        message.author?.map(({ given, family }) =>
          [given, family].filter(Boolean).join(" "),
        ) ?? [],
      journal: message["container-title"]?.[0],
      year:
        message.published?.["date-parts"]?.[0]?.[0] ??
        message.created?.["date-parts"]?.[0]?.[0],
      doi: message.DOI || doi,
      abstract: stripJats(message.abstract),
      sourceUrl: message.URL || `https://doi.org/${doi}`,
    },
    pdfCandidates: uniquePdfCandidates([
      ...extractDoiResolverPdfCandidates(doi),
      ...extractCrossrefPdfCandidates(message),
      ...extractChemrxivPdfCandidates(doi),
    ]),
  };
}

async function lookupArxivWithPdfLinks(
  identifier: Extract<PaperIdentifier, { kind: "arxiv" }>,
): Promise<ArxivLookupResult> {
  const requestedId = `${identifier.arxivId}${
    identifier.version ? `v${identifier.version}` : ""
  }`;
  const url = new URL("https://export.arxiv.org/api/query");
  url.searchParams.set("id_list", requestedId);
  url.searchParams.set("max_results", "1");
  let response: Response;
  try {
    response = await net.fetch(url.toString(), {
      headers: {
        Accept: "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
      },
    });
  } catch {
    throw new Error("无法连接 arXiv，请检查网络后重试。");
  }
  if (!response.ok) {
    throw new Error(`arXiv 查询失败 (${response.status})。`);
  }
  const result = parseArxivAtomFeed(await response.text());
  if (
    !result ||
    result.metadata.arxivId?.toLowerCase() !== identifier.arxivId.toLowerCase()
  ) {
    throw new Error(`arXiv 未找到论文 ${requestedId}。`);
  }
  if (
    identifier.version &&
    result.metadata.arxivVersion !== identifier.version
  ) {
    throw new Error(`arXiv 未找到论文版本 ${requestedId}。`);
  }
  return result;
}

async function lookupArxivByDoi(
  doi: string,
): Promise<ArxivLookupResult | undefined> {
  const url = new URL("https://export.arxiv.org/api/query");
  url.searchParams.set("search_query", `doi:${doi}`);
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", "3");
  try {
    const response = await net.fetch(url.toString(), {
      headers: {
        Accept: "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
      },
    });
    if (!response.ok) return undefined;
    const result = parseArxivAtomFeed(await response.text());
    return result?.metadata.doi?.toLowerCase() === doi.toLowerCase()
      ? result
      : undefined;
  } catch {
    return undefined;
  }
}

async function resolveOpenAccessPdf(
  doi: string,
  crossrefCandidates: PdfCandidate[],
): Promise<PdfResolution> {
  const downloaded = await resolvePdfCandidatesInOrder(
    [
      () => Promise.resolve(crossrefCandidates),
      () => lookupEuropePmcPdfCandidates(doi),
      () => lookupUnpaywallPdfCandidates(doi),
      () => lookupOpenAlexPdfCandidates(doi),
      () => lookupSemanticScholarPdfCandidates(doi),
      () => lookupArxivPdfCandidates(doi),
      () => lookupCorePdfCandidates(doi),
    ],
    downloadPdfCandidate,
  );
  if (downloaded) return { downloaded };

  // Sci-Hub 作为最后兜底：仅在合法来源均无结果时尝试。
  const scihub = await lookupScihubPdfCandidates(doi);
  console.log(`[scihub] DOI ${doi} 找到 ${scihub.candidates.length} 个候选`);
  for (const candidate of scihub.candidates) {
    const downloaded = await downloadPdfCandidate(candidate);
    if (downloaded) {
      console.log(
        `[scihub] 已验证并下载 PDF：${candidate.url} (${downloaded.data.byteLength} bytes)`,
      );
      return { downloaded };
    }
    console.log(`[scihub] 候选下载失败（非 PDF 或被拒）：${candidate.url}`);
  }

  return {
    manualUrl: scihub.challengeUrl,
    scihubChallengeDetected: Boolean(scihub.challengeUrl),
  };
}

async function lookupUnpaywallPdfCandidates(
  doi: string,
): Promise<PdfCandidate[]> {
  const email = process.env.PAPERXCEL_UNPAYWALL_EMAIL?.trim();
  if (!email) return [];
  const payload = await fetchJson<UnpaywallResponse>(
    `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`,
  );
  return payload ? extractUnpaywallPdfCandidates(payload) : [];
}

async function lookupEuropePmcPdfCandidates(
  doi: string,
): Promise<PdfCandidate[]> {
  const url = new URL(
    "https://www.ebi.ac.uk/europepmc/webservices/rest/search",
  );
  url.searchParams.set("query", `DOI:"${doi}"`);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageSize", "3");
  url.searchParams.set("resultType", "core");
  const payload = await fetchJson<EuropePmcResponse>(url.toString());
  return payload ? extractEuropePmcPdfCandidates(payload) : [];
}

async function lookupOpenAlexPdfCandidates(
  doi: string,
): Promise<PdfCandidate[]> {
  const url = new URL(`https://api.openalex.org/works/doi:${doi}`);
  const email = process.env.PAPERXCEL_OPENALEX_EMAIL?.trim();
  const apiKey = store?.resolveOpenAlexApiKey();
  if (email) url.searchParams.set("mailto", email);
  if (apiKey) url.searchParams.set("api_key", apiKey);
  const payload = await fetchJson<OpenAlexWork>(url.toString());
  return payload ? extractOpenAlexPdfCandidates(payload) : [];
}

async function lookupSemanticScholarPdfCandidates(
  doi: string,
): Promise<PdfCandidate[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const apiKey = process.env.PAPERXCEL_SEMANTIC_SCHOLAR_API_KEY?.trim();
  if (apiKey) headers["x-api-key"] = apiKey;
  const payload = await fetchJson<SemanticScholarPaper>(
    `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(
      `DOI:${doi}`,
    )}?fields=openAccessPdf`,
    headers,
  );
  return payload ? extractSemanticScholarPdfCandidates(payload) : [];
}

async function lookupArxivPdfCandidates(doi: string): Promise<PdfCandidate[]> {
  const result = await lookupArxivByDoi(doi);
  return result?.pdfCandidates ?? [];
}

async function lookupCorePdfCandidates(doi: string): Promise<PdfCandidate[]> {
  const apiKey = process.env.PAPERXCEL_CORE_API_KEY?.trim();
  if (!apiKey) return [];
  const url = new URL("https://api.core.ac.uk/v3/search/works");
  url.searchParams.set("q", `doi:"${doi}"`);
  url.searchParams.set("limit", "3");
  const payload = await fetchJson<CoreSearchResponse>(url.toString(), {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  });
  return payload ? extractCorePdfCandidates(payload) : [];
}

async function lookupScihubPdfCandidates(
  doi: string,
): Promise<ScihubLookupResult> {
  // 出于合规考虑，仅在用户于设置中接受免责声明后（或显式设置环境变量）才尝试 Sci-Hub。
  const enabledByEnv = process.env.PAPERXCEL_SCIHUB_ENABLED?.trim() === "1";
  if (!enabledByEnv && !store.getScihubEnabled()) return { candidates: [] };
  if (!doi.startsWith("10.")) return { candidates: [] };

  const configured = process.env.PAPERXCEL_SCIHUB_MIRRORS?.split(",")
    .map((mirror) => mirror.trim())
    .filter(Boolean);
  const mirrors =
    configured && configured.length > 0 ? configured : DEFAULT_SCIHUB_MIRRORS;

  // Sci-Hub 仅作为最后兜底：每个镜像和 DOI URL 变体只尝试一次，避免阻塞导入流程。
  const scihubSession = session.fromPartition(SCIHUB_SESSION_PARTITION);
  scihubSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  let challengeUrl: string | undefined;
  for (const mirror of mirrors) {
    for (const pageUrl of buildScihubPageUrls(mirror, doi)) {
      const page = await fetchScihubPage(pageUrl);
      if (!page) continue;
      if (isLikelyScihubChallenge(page.status, page.html)) {
        challengeUrl ??= pageUrl;
        break;
      }

      const candidates = tagScihubCandidates(
        extractScihubPdfCandidates(page.html, page.url),
        page.url,
      );
      if (candidates.length > 0) return { candidates };
    }
  }
  console.log(`[scihub] 单次兜底未命中 DOI ${doi}`);

  if (challengeUrl) {
    console.log(`[scihub] DOI ${doi} 需要用户完成人机验证：${challengeUrl}`);
    const candidates = await openScihubVerificationWindow(challengeUrl);
    return {
      candidates,
      challengeUrl,
    };
  }

  return { candidates: [] };
}

async function fetchScihubPage(
  url: string,
): Promise<{ status: number; html: string; url: string } | undefined> {
  const visited = new Set<string>();
  let currentUrl = url;
  try {
    for (let redirectCount = 0; redirectCount < 5; redirectCount += 1) {
      if (visited.has(currentUrl)) return undefined;
      visited.add(currentUrl);
      const response = await session
        .fromPartition(SCIHUB_SESSION_PARTITION)
        .fetch(currentUrl, {
          redirect: "manual",
          headers: {
            "User-Agent": "Mozilla/5.0",
            Accept: "text/html,*/*;q=0.8",
          },
        });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        const redirectUrl = resolveHttpUrl(location, currentUrl);
        if (!redirectUrl) return undefined;
        currentUrl = redirectUrl;
        continue;
      }
      return {
        status: response.status,
        html: await response.text(),
        url: currentUrl,
      };
    }
  } catch {
    // A malformed Location header must not become the verification window URL.
  }
  return undefined;
}

function tagScihubCandidates(
  candidates: PdfCandidate[],
  referer: string,
): PdfCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    sessionPartition: SCIHUB_SESSION_PARTITION,
    referer,
  }));
}

async function openScihubVerificationWindow(
  startUrl: string,
): Promise<PdfCandidate[]> {
  scihubVerificationWindow?.close();
  const scihubSession = session.fromPartition(SCIHUB_SESSION_PARTITION);

  return new Promise((resolve) => {
    let settled = false;
    let inspectionRunning = false;
    const verificationWindow = new BrowserWindow({
      parent: mainWindow ?? undefined,
      width: 1060,
      height: 800,
      minWidth: 760,
      minHeight: 560,
      show: true,
      autoHideMenuBar: true,
      title: "PaperXcel - 请完成人机验证",
      backgroundColor: "#ffffff",
      webPreferences: {
        session: scihubSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    scihubVerificationWindow = verificationWindow;
    verificationWindow.show();
    verificationWindow.focus();

    const finish = (candidates: PdfCandidate[]): void => {
      if (settled) return;
      settled = true;
      scihubSession.webRequest.onHeadersReceived(null);
      clearInterval(pollTimer);
      resolve(candidates);
      if (!verificationWindow.isDestroyed()) verificationWindow.close();
    };

    const inspectPage = async (): Promise<void> => {
      if (
        settled ||
        inspectionRunning ||
        verificationWindow.isDestroyed() ||
        verificationWindow.webContents.isLoading()
      ) {
        return;
      }
      inspectionRunning = true;
      try {
        const pageUrl = verificationWindow.webContents.getURL();
        const directPdfUrl = extractHttpPdfUrl(pageUrl);
        if (directPdfUrl) {
          finish(
            tagScihubCandidates(
              [{ url: directPdfUrl, source: "Sci-Hub" }],
              startUrl,
            ),
          );
          return;
        }

        const html = await verificationWindow.webContents.executeJavaScript(
          "document.documentElement ? document.documentElement.outerHTML : ''",
          true,
        );
        if (typeof html !== "string" || !html || looksLikeScihubBlock(html)) {
          return;
        }
        const candidates = extractScihubPdfCandidates(html, pageUrl);
        if (candidates.length > 0) {
          finish(tagScihubCandidates(candidates, pageUrl));
        }
      } catch {
        // 页面仍在跳转或挑战脚本尚未完成，下一轮继续检查。
      } finally {
        inspectionRunning = false;
      }
    };

    let failurePageShown = false;
    const showVerificationLoadError = (
      errorCode: number,
      errorDescription: string,
      failedUrl: string,
    ): void => {
      if (
        failurePageShown ||
        settled ||
        verificationWindow.isDestroyed()
      ) {
        return;
      }
      failurePageShown = true;
      const escapeHtml = (value: string): string =>
        value.replace(
          /[&<>"']/g,
          (character) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            })[character] ?? character,
        );
      const html = `<!doctype html>
<meta charset="utf-8">
<title>PaperXcel - Sci-Hub verification</title>
<style>
  body { margin: 0; padding: 48px; font: 16px system-ui, sans-serif; color: #202420; background: #f4f5f1; }
  main { max-width: 760px; margin: 0 auto; padding: 32px; background: white; border: 1px solid #d9ded8; border-radius: 12px; }
  h1 { margin-top: 0; font-size: 22px; }
  code { display: block; margin: 16px 0; padding: 12px; overflow-wrap: anywhere; background: #f1f3ef; border-radius: 8px; }
  a { color: #147d71; }
</style>
<main>
  <h1>Sci-Hub verification page could not be loaded</h1>
  <p>Keep this window open and try the link below, or close it and use the manual PDF import action in PaperXcel.</p>
  <p>Error: ${escapeHtml(errorDescription || "Unknown navigation error")} (${errorCode})</p>
  <code>${escapeHtml(failedUrl)}</code>
  <a href="${escapeHtml(failedUrl)}">Retry verification page</a>
</main>`;
      const dataUrl = `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
      void verificationWindow.loadURL(dataUrl).catch(() => undefined);
    };

    verificationWindow.on("ready-to-show", () => {
      verificationWindow.show();
      verificationWindow.focus();
    });
    verificationWindow.on("page-title-updated", (event) => {
      event.preventDefault();
      verificationWindow.setTitle("PaperXcel - 请完成人机验证");
    });
    verificationWindow.on("closed", () => {
      if (scihubVerificationWindow === verificationWindow) {
        scihubVerificationWindow = null;
      }
      finish([]);
    });
    verificationWindow.webContents.setWindowOpenHandler(({ url }) => {
      const directPdfUrl = extractHttpPdfUrl(url);
      if (directPdfUrl) {
        finish(
          tagScihubCandidates(
            [{ url: directPdfUrl, source: "Sci-Hub" }],
            verificationWindow.webContents.getURL() || startUrl,
          ),
        );
      } else if (/^https?:\/\//i.test(url)) {
        void verificationWindow.loadURL(url);
      }
      return { action: "deny" };
    });
    verificationWindow.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith("data:text/html") && !/^https?:\/\//i.test(url)) {
        event.preventDefault();
      }
    });
    verificationWindow.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return;
        console.error(
          `[scihub] verification window failed: ${errorDescription} (${errorCode}) ${validatedURL}`,
        );
        showVerificationLoadError(
          errorCode,
          errorDescription,
          validatedURL || startUrl,
        );
      },
    );
    verificationWindow.webContents.on("did-finish-load", () => {
      failurePageShown = false;
      void inspectPage();
    });
    verificationWindow.webContents.on("did-navigate-in-page", () => {
      void inspectPage();
    });
    const pollTimer = setInterval(() => void inspectPage(), 1000);
    scihubSession.webRequest.onHeadersReceived(
      { urls: ["http://*/*", "https://*/*"] },
      (details, callback) => {
        callback({ responseHeaders: details.responseHeaders });
        if (
          settled ||
          details.webContentsId !== verificationWindow.webContents.id ||
          !looksLikePdfNetworkResponse(details.url, details.responseHeaders)
        ) {
          return;
        }
        const referer =
          details.referrer ||
          verificationWindow.webContents.getURL() ||
          startUrl;
        queueMicrotask(() => {
          finish(
            tagScihubCandidates(
              [{ url: details.url, source: "Sci-Hub" }],
              referer,
            ),
          );
        });
      },
    );

    void verificationWindow.loadURL(startUrl).catch((error: unknown) => {
      const description = error instanceof Error ? error.message : String(error);
      console.error(`[scihub] verification navigation failed: ${description}`);
      showVerificationLoadError(-1, description, startUrl);
    });
  });
}

function extractHttpPdfUrl(value: string): string | undefined {
  const url = resolveHttpUrl(value);
  return url && /(?:\.pdf(?:$|[?#])|\/pdf(?:\/|$|[?#]))/i.test(url)
    ? url
    : undefined;
}

function resolveHttpUrl(
  value?: string | null,
  base?: string,
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, base);
    if (url.protocol === "chrome-extension:") {
      const embedded = url.searchParams.get("file");
      return embedded ? resolveHttpUrl(embedded) : undefined;
    }
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    if (!url.hostname) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

async function fetchJson<T>(
  url: string,
  headers: Record<string, string> = { Accept: "application/json" },
): Promise<T | undefined> {
  try {
    const response = await net.fetch(url, { headers });
    if (!response.ok) return undefined;
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

async function downloadPdfCandidate(
  candidate: PdfCandidate,
): Promise<DownloadedPdf | undefined> {
  try {
    const headers: Record<string, string> = {
      // 部分来源（尤其 Sci-Hub 存储服务器）会拒绝没有浏览器 UA 的请求。
      "User-Agent": "Mozilla/5.0",
      Accept: "application/pdf,*/*;q=0.8",
    };
    if (candidate.referer) headers.Referer = candidate.referer;
    const response = candidate.sessionPartition
      ? await session
          .fromPartition(candidate.sessionPartition)
          .fetch(candidate.url, { headers })
      : await globalThis.fetch(candidate.url, { headers });
    if (!response.ok) return undefined;
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_AUTO_PDF_BYTES) return undefined;

    const data = Buffer.from(await response.arrayBuffer());
    if (
      data.byteLength > MAX_AUTO_PDF_BYTES ||
      !isPdfResponse(response, data) ||
      !hasPdfEndMarker(data)
    ) {
      return undefined;
    }
    return {
      ...candidate,
      data,
      fileName: inferPdfFileName(candidate.url),
    };
  } catch {
    return undefined;
  }
}

function isPdfResponse(response: Response, data: Buffer): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return (
    contentType.includes("pdf") ||
    data.subarray(0, 5).toString("ascii") === "%PDF-"
  );
}

function hasPdfEndMarker(data: Buffer): boolean {
  const tail = data.subarray(Math.max(0, data.byteLength - 2_048));
  return tail.includes(Buffer.from("%%EOF"));
}

function inferPdfFileName(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const name = decodeURIComponent(pathname.split("/").pop() || "").trim();
    return /\.pdf$/i.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

function stripJats(value?: string): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function emitPaper(paper: Paper): void {
  mainWindow?.webContents.send("paper:updated", paper);
}
