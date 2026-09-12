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
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  AskPaperInput,
  AgentEvent,
  ChatAttachment,
  ChatProgress,
  CitationContentMatchPriority,
  CitationDiscoveryInput,
  CitationGraphAnalysisOptions,
  CitationGraphExportRequest,
  CitationGraphExpansionResult,
  CitationGraphSnapshot,
  ChatMessage,
  CreateLibraryFolderInput,
  DocumentPageText,
  GenerateLibraryReviewInput,
  ImportPdfInput,
  KnowledgeBaseExportOptions,
  KnowledgeBaseMarkdownPreview,
  KnowledgeBaseRepairProgress,
  KnowledgeBaseMarkdownStream,
  LibraryAskInput,
  LibraryAskResult,
  LibrarySearchInput,
  LibrarySearchHit,
  OpenAlexConfigInput,
  Paper,
  PaperIdentifier,
  PaperMetadata,
  ProviderProfileInput,
  TranslationConfigInput,
  TranslationInput,
  ZoteroConfigInput,
  ZoteroPullResult,
} from "../shared/contracts";
import {
  CITATION_GRAPH_EXTERNAL_NODE_MAX,
  CITATION_GRAPH_FOCUSED_EXTERNAL_NODE_MAX,
  buildCitationGraphSnapshot,
} from "../shared/citationGraph";
import {
  buildLibraryReviewExport,
  buildPaperFullTextMarkdown,
  libraryReviewFileName,
} from "../shared/knowledge";
import { compareMarkdownVersions } from "../shared/markdownComparison";
import { buildPaperNoteExport, paperNoteFileName } from "../shared/notes";
import {
  mapZoteroItem,
  safeZoteroPdfFileName,
  selectZoteroPdfAttachment,
} from "../shared/zotero";
import {
  buildScihubPageUrls,
  DEFAULT_SCIHUB_MIRRORS,
  DOI_AUTO_FETCH_CUTOFF_YEAR,
  extractChemrxivPdfCandidates,
  extractCorePdfCandidates,
  extractCrossrefPdfCandidates,
  extractDoiResolverPdfCandidates,
  extractEuropePmcPdfCandidates,
  extractMatchingChemrxivPdfCandidates,
  extractOpenAlexPdfCandidates,
  extractScihubPdfCandidates,
  findMatchingArxivResult,
  isLikelyScihubChallenge,
  isScihubPageUrl,
  isChemrxivDoi,
  looksLikePdfNetworkResponse,
  looksLikeScihubBlock,
  parseArxivAtomEntries,
  parseArxivAtomFeed,
  parsePaperIdentifier,
  normalizeDoiInput,
  resolvePdfCandidatesInOrder,
  shouldAttemptOpenAccessPdf,
  uniquePdfCandidates,
  type ArxivLookupResult,
  type CoreSearchResponse,
  type CrossrefPreprintWork,
  type CrossrefMessageWithLinks,
  type EuropePmcResponse,
  type OpenAlexWork,
  type PdfCandidate,
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
import {
  removeChatAttachment,
  resolveChatAttachment,
  saveChatAttachment,
  saveChatAttachmentData,
  type ResolvedChatAttachment,
} from "./chat-attachments";
import {
  expandCitationGraphData,
  refreshCitationGraphData,
} from "./citation-graph-service";
import { discoverCitationWorks } from "./citation-discovery-service";
import { analyzeCitationNetwork } from "./citation-analysis-service";
import { OpenAlexClient } from "./openalex-client";
import { CrossrefClient } from "./crossref-client";
import { EuropePmcClient } from "./europe-pmc-client";
import { ArxivClient } from "./arxiv-client";
import { buildGoogleScholarSearchUrl } from "../shared/externalSearch";
import {
  importGoogleScholarText,
  searchGoogleScholarInteractively,
} from "./google-scholar-service";
import { BaiduTranslationClient } from "./baidu-translation-client";
import {
  downloadZoteroAttachment,
  listZoteroItemChildren,
  listZoteroLibraryItems,
  testZoteroConnection,
} from "./zotero-client";
import {
  answerLibraryQuestion,
  askPaper,
  compactPaperConversation,
  generateLibraryReview,
  generatePaperNote,
  listProviderModels,
  planPaperResearch,
  planLibraryResearch,
  repairKnowledgePaperExport,
  testProvider,
} from "./provider";
import type { PaperEvidenceCandidate } from "./paper-research";
import { ChatRunRegistry } from "./chat-run";
import { runPaperChat } from "./chat-service";
import { toPublicChatProgress } from "./agent-progress";
import { exportKnowledgeBase } from "./knowledge-base";
import {
  readKnowledgeMarkdownRepairCache,
  removeKnowledgeMarkdownRepairCache,
  writeKnowledgeMarkdownRepairCache,
} from "./knowledge-markdown-cache";
import {
  ensureCanonicalPaperPdf,
  paperArtifactDirectory,
  removeLegacyPaperSummaryArtifact,
  removePaperTextArtifacts,
  writePaperMetadataArtifact,
  writePaperNoteArtifact,
  writePaperTextArtifacts,
} from "./paper-artifacts";
import { DocumentEngineClient } from "./document-engine-client";
import { configureApplicationDataPaths } from "./portable-data";
import {
  createAgentBatchCheckpoint,
  createPaperAgentBatchCheckpoint,
} from "./agent-batch-checkpoint";

const mainDirectory = dirname(fileURLToPath(import.meta.url));

// The portable build removes Vulkan/WebGPU binaries. Chromium's CPU renderer
// still supports the PDF canvas and the rest of the desktop interface.
app.disableHardwareAcceleration();

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

configureApplicationDataPaths();

let mainWindow: BrowserWindow | null = null;
const LIBRARY_ASK_TIMEOUT_MS = 5 * 60_000;
const LIBRARY_SEARCH_TIMEOUT_MS = 90_000;
let store: AppStore;
const documentEngine = new DocumentEngineClient();
const chatRuns = new ChatRunRegistry();
const libraryAskAbortControllers = new Map<string, AbortController>();
const noteGenerationAbortControllers = new Map<string, AbortController>();
const reviewGenerationAbortControllers = new Map<string, AbortController>();
const knowledgeExportAbortControllers = new Map<string, AbortController>();
const knowledgeMarkdownRepairAbortControllers = new Map<
  string,
  AbortController
>();
const paperArtifactSyncs = new Map<string, Promise<void>>();
const paperMarkdownIndexSyncs = new Map<
  string,
  Promise<MarkdownReindexResult>
>();
const MAX_AUTO_PDF_BYTES = 120 * 1024 * 1024;
const MAX_CHAT_ATTACHMENT_COUNT = 6;
const MAX_CHAT_ATTACHMENT_FILE_BYTES = 50 * 1024 * 1024;
const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 80 * 1024 * 1024;
const MARKDOWN_REPAIR_TIMEOUT_MS = 20 * 60_000;
const SCIHUB_SESSION_PARTITION = "persist:paperxcel-scihub";
const SCIHUB_DIRECT_PAGE_TIMEOUT_MS = 30_000;
const SCIHUB_PDF_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
let scihubVerificationWindow: BrowserWindow | null = null;
let scihubVerificationPromise: Promise<PdfCandidate[]> | null = null;
let scihubLastVerifiedAt: string | undefined;

function selectCitationPapers(papers: Paper[], paperIds: unknown): Paper[] {
  const activePapers = papers.filter((paper) => !paper.archived);
  if (!Array.isArray(paperIds)) return activePapers;
  const selectedIds = new Set(
    paperIds.filter(
      (paperId): paperId is string => typeof paperId === "string",
    ),
  );
  return activePapers.filter((paper) => selectedIds.has(paper.id));
}

function normalizeCitationGraphAnalysisOptions(
  input: unknown,
): CitationGraphAnalysisOptions {
  if (!input || typeof input !== "object") return {};
  const value = input as {
    mode?: unknown;
    externalLimits?: { references?: unknown; citing?: unknown };
  };
  const mode =
    value.mode === "focused-two-hop" || value.mode === "standard"
      ? value.mode
      : undefined;
  const references = Number(value.externalLimits?.references);
  const citing = Number(value.externalLimits?.citing);
  const externalNodeMax =
    mode === "focused-two-hop"
      ? CITATION_GRAPH_FOCUSED_EXTERNAL_NODE_MAX
      : CITATION_GRAPH_EXTERNAL_NODE_MAX;
  const externalLimits =
    Number.isFinite(references) && Number.isFinite(citing)
      ? {
          references: Math.max(
            0,
            Math.min(externalNodeMax, Math.round(references)),
          ),
          citing: Math.max(0, Math.min(externalNodeMax, Math.round(citing))),
        }
      : undefined;
  return { mode, externalLimits };
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
  manualUrl?: string;
}

documentEngine.on(
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
    icon: join(mainDirectory, "../renderer/paperxcel.png"),
    backgroundColor: "#f4f5f1",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#f4f5f1",
      symbolColor: "#202420",
      height: 32,
    },
    webPreferences: {
      preload: join(mainDirectory, "../preload/index.cjs"),
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
    void mainWindow.loadFile(join(mainDirectory, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  store = new AppStore();
  await synchronizeStoredPaperArtifacts();
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
  void documentEngine.start();
  void synchronizeStoredPaperMarkdownIndexes();
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

app.on("before-quit", () => {
  chatRuns.cancelAll();
  for (const controller of [
    ...libraryAskAbortControllers.values(),
    ...noteGenerationAbortControllers.values(),
    ...reviewGenerationAbortControllers.values(),
    ...knowledgeExportAbortControllers.values(),
    ...knowledgeMarkdownRepairAbortControllers.values(),
  ]) {
    controller.abort();
  }
  documentEngine.stop();
});

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
  ipcMain.handle("clipboard:read-text", () => clipboard.readText());

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
    const attachmentIds = chatAttachmentIds(store.listChatMessages(id));
    store.removePaper(id);
    const indexPath = join(app.getPath("userData"), "indexes", `${id}.sqlite3`);
    const directory = resolvePaperArtifactDirectory(id);
    await Promise.all([
      rm(directory, {
        recursive: true,
        force: true,
      }),
      rm(indexPath, { force: true }),
      rm(`${indexPath}-wal`, { force: true }),
      rm(`${indexPath}-shm`, { force: true }),
      removeKnowledgeMarkdownRepairCache(
        directory,
        id,
        legacyKnowledgeMarkdownCacheRoot(),
      ),
      removeChatAttachments(attachmentIds),
    ]);
    await removeSelectionImages(imageIds);
  });
  ipcMain.handle("papers:reorder", (_event, paperIds: string[]) =>
    store.reorderPapers(paperIds),
  );
  ipcMain.handle("papers:toggle-star", (_event, id: string) => {
    const paper = store.getPaper(id);
    if (!paper) throw new Error("文献不存在。");
    const updated = store.savePaper({
      ...paper,
      starred: !paper.starred,
      updatedAt: new Date().toISOString(),
    });
    emitPaper(updated);
    return updated;
  });
  ipcMain.handle(
    "papers:set-archive",
    (_event, id: string, archived: boolean) => {
      const updated = store.setPaperArchived(id, archived);
      emitPaper(updated);
      return updated;
    },
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
  ipcMain.handle("folders:remove", (_event, id: string) => {
    const result = store.removeFolder(id);
    for (const paper of result.papers) queuePaperArtifactSync(paper);
    return result;
  });
  ipcMain.handle("papers:reprocess", async (_event, id: string) => {
    const paper = store.getPaper(id);
    if (!paper || !store.resolvePaperPath(id)) {
      throw new Error("当前文献没有可重新解析的 PDF。");
    }
    const directory = resolvePaperArtifactDirectory(id);
    await Promise.all([
      removePaperTextArtifacts(directory),
      removeKnowledgeMarkdownRepairCache(
        directory,
        id,
        legacyKnowledgeMarkdownCacheRoot(),
      ),
    ]);
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
    const paper = store.getPaper(id);
    const url = paper?.manualPdfUrl;
    if (!paper || !url?.startsWith("https://")) return;
    if (!isScihubManualUrl(paper, url)) {
      await shell.openExternal(url);
      return;
    }

    const candidates = await openScihubVerificationWindow(url);
    for (const candidate of candidates) {
      const downloaded = await downloadPdfCandidate(candidate);
      if (!downloaded) continue;
      await attachDownloadedPdf(paper, downloaded);
      return;
    }
    const current = store.getPaper(id);
    if (!current || current.status !== "needs_file") return;
    emitPaper(
      store.savePaper({
        ...current,
        statusText: candidates.length
          ? "已检测到 Sci-Hub PDF，但自动下载失败。可重新验证或手动添加 PDF。"
          : "Sci-Hub 验证窗口已关闭，尚未检测到 PDF。可点击继续验证。",
        updatedAt: new Date().toISOString(),
      }),
    );
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
  ipcMain.handle("settings:get-scihub-session-status", async () => {
    const cookies = await session
      .fromPartition(SCIHUB_SESSION_PARTITION)
      .cookies.get({});
    return {
      persistent: SCIHUB_SESSION_PARTITION.startsWith("persist:"),
      cookieCount: cookies.length,
      lastVerifiedAt: scihubLastVerifiedAt,
    };
  });
  ipcMain.handle("settings:clear-scihub-session", async () => {
    const scihubSession = session.fromPartition(SCIHUB_SESSION_PARTITION);
    await scihubSession.clearStorageData({
      storages: ["cookies", "localstorage", "cachestorage", "serviceworkers"],
    });
    await scihubSession.clearCache();
    scihubLastVerifiedAt = undefined;
    return {
      persistent: true,
      cookieCount: 0,
      lastVerifiedAt: undefined,
    };
  });
  ipcMain.handle("settings:get-preprint-fallback-enabled", () =>
    store.getPreprintFallbackEnabled(),
  );
  ipcMain.handle(
    "settings:set-preprint-fallback-enabled",
    (_event, enabled: boolean) =>
      store.setPreprintFallbackEnabled(Boolean(enabled)),
  );
  ipcMain.handle("settings:get-citation-content-match-priority", () =>
    store.getCitationContentMatchPriority(),
  );
  ipcMain.handle(
    "settings:set-citation-content-match-priority",
    (_event, priority: CitationContentMatchPriority) =>
      store.setCitationContentMatchPriority(priority),
  );
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
  ipcMain.handle("citation-graph:clear", () => store.clearCitationGraphCache());
  ipcMain.handle(
    "citation-graph:discover",
    async (_event, input: CitationDiscoveryInput) => {
      const papers = selectCitationPapers(store.listPapers(), input?.paperIds);
      const cache = store.getCitationGraphCache();
      const discoveryMode =
        input?.mode === "pure-search" ? "pure-search" : "contextual";
      const translationCredentials = store.resolveTranslationCredentials();
      const canTranslateDiscoveryQuery = Boolean(
        translationCredentials.appId && translationCredentials.secretKey,
      );
      const { result, works } = await discoverCitationWorks({
        papers,
        cache,
        client: new OpenAlexClient(store.resolveOpenAlexApiKey()),
        crossref: new CrossrefClient(),
        europePmc: new EuropePmcClient(),
        arxiv: new ArxivClient(),
        query: typeof input?.query === "string" ? input.query : "",
        mode: discoveryMode,
        limit:
          typeof input?.limit === "number" && Number.isFinite(input.limit)
            ? input.limit
            : undefined,
        contentMatchPriority: store.getCitationContentMatchPriority(),
        translateQuery: canTranslateDiscoveryQuery
          ? async (text) =>
              (
                await new BaiduTranslationClient(
                  translationCredentials.appId,
                  translationCredentials.secretKey,
                ).translate(text)
              ).translatedText
          : undefined,
      });
      // 纯搜索结果是灵感/证据临时结果，不写入图谱缓存，避免污染后续上下文发现。
      if (discoveryMode !== "pure-search") {
        for (const work of works) cache.works[work.openAlexId] = work;
      }
      if (discoveryMode !== "pure-search" && works.length > 0) {
        cache.updatedAt = new Date().toISOString();
        store.saveCitationGraphCache(cache);
      }
      return result;
    },
  );
  ipcMain.handle(
    "citation-graph:analyze",
    (_event, paperIds?: unknown, options?: unknown) =>
      analyzeCitationNetwork(
        selectCitationPapers(store.listPapers(), paperIds),
        store.getCitationGraphCache(),
        new Date(),
        normalizeCitationGraphAnalysisOptions(options),
      ),
  );
  ipcMain.handle(
    "citation-graph:open-google-scholar",
    async (_event, input: unknown) => {
      const query = typeof input === "string" ? input.trim() : "";
      if (!query) throw new Error("Google Scholar 搜索需要主题关键词。");
      await shell.openExternal(buildGoogleScholarSearchUrl(query));
      return true;
    },
  );
  ipcMain.handle(
    "citation-graph:search-google-scholar",
    async (_event, input: CitationDiscoveryInput) => {
      const mode = input?.mode === "pure-search" ? "pure-search" : "contextual";
      const query = typeof input?.query === "string" ? input.query.trim() : "";
      if (!query) throw new Error("Google Scholar 搜索需要主题关键词。");
      const papers =
        mode === "pure-search"
          ? []
          : selectCitationPapers(store.listPapers(), input?.paperIds);
      return searchGoogleScholarInteractively({
        parent: mainWindow ?? undefined,
        query,
        papers,
        cache: store.getCitationGraphCache(),
        client: new OpenAlexClient(store.resolveOpenAlexApiKey()),
        mode,
        limit:
          typeof input?.limit === "number" && Number.isFinite(input.limit)
            ? input.limit
            : undefined,
      });
    },
  );
  ipcMain.handle(
    "citation-graph:import-google-scholar-text",
    async (_event, input: CitationDiscoveryInput & { text?: unknown }) => {
      const mode = input?.mode === "pure-search" ? "pure-search" : "contextual";
      const query = typeof input?.query === "string" ? input.query.trim() : "";
      const text = typeof input?.text === "string" ? input.text : "";
      if (!query) throw new Error("Google Scholar 导入需要主题关键词。");
      if (!text.trim()) throw new Error("剪贴板中没有可导入文本。");
      const papers =
        mode === "pure-search"
          ? []
          : selectCitationPapers(store.listPapers(), input?.paperIds);
      return importGoogleScholarText({
        text,
        query,
        papers,
        cache: store.getCitationGraphCache(),
        client: new OpenAlexClient(store.resolveOpenAlexApiKey()),
        mode,
        limit:
          typeof input?.limit === "number" && Number.isFinite(input.limit)
            ? input.limit
            : undefined,
      });
    },
  );
  ipcMain.handle(
    "citation-graph:export",
    async (_event, input: CitationGraphExportRequest) => {
      if (
        !input ||
        (input.format !== "json" && input.format !== "html") ||
        typeof input.content !== "string"
      ) {
        throw new Error("图谱导出参数不正确。");
      }
      const config =
        input.format === "json"
          ? {
              title: "导出引文图谱数据",
              name: "JSON 数据",
              extension: "json",
              maximumLength: 80 * 1024 * 1024,
            }
          : {
              title: "导出交互式引文图谱",
              name: "HTML 网页",
              extension: "html",
              maximumLength: 40 * 1024 * 1024,
            };
      if (
        !input.content.length ||
        input.content.length > config.maximumLength
      ) {
        throw new Error("图谱导出内容为空或体积过大。");
      }
      const date = new Date().toISOString().slice(0, 10);
      const selected = await dialog.showSaveDialog(mainWindow!, {
        title: config.title,
        defaultPath: join(
          app.getPath("documents"),
          `PaperXcel-引文图谱-${date}.${config.extension}`,
        ),
        filters: [{ name: config.name, extensions: [config.extension] }],
      });
      if (selected.canceled || !selected.filePath) return false;
      const outputPath = selected.filePath
        .toLocaleLowerCase()
        .endsWith(`.${config.extension}`)
        ? selected.filePath
        : `${selected.filePath}.${config.extension}`;
      if (input.format === "json") {
        let document: unknown;
        try {
          document = JSON.parse(input.content);
        } catch {
          throw new Error("生成的引文图谱 JSON 文件无效。");
        }
        if (
          !document ||
          typeof document !== "object" ||
          (document as { schemaVersion?: unknown }).schemaVersion !== 1 ||
          !Array.isArray((document as { nodes?: unknown }).nodes) ||
          !Array.isArray((document as { edges?: unknown }).edges)
        ) {
          throw new Error("生成的引文图谱 JSON 数据结构无效。");
        }
        await writeFile(outputPath, input.content, "utf8");
      } else {
        if (
          !input.content
            .trimStart()
            .toLocaleLowerCase()
            .startsWith("<!doctype html>")
        ) {
          throw new Error("生成的交互式图谱文件无效。");
        }
        await writeFile(outputPath, input.content, "utf8");
      }
      return true;
    },
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
          return documentEngine.request<string[]>(
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
          return documentEngine.request<string[]>(
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
  ipcMain.handle(
    "citation-graph:expand",
    async (_event, paperId: unknown, force = false) => {
      if (typeof paperId !== "string" || !paperId.trim()) {
        throw new Error("同向二重图谱缺少目标论文。");
      }
      const paper = store
        .listPapers()
        .find((candidate) => candidate.id === paperId.trim());
      if (!paper) throw new Error("找不到要展开的目标论文。");
      const { cache, result } = await expandCitationGraphData({
        paper,
        cache: store.getCitationGraphCache(),
        client: new OpenAlexClient(store.resolveOpenAlexApiKey()),
        force: Boolean(force),
      });
      store.saveCitationGraphCache(cache);
      return result as CitationGraphExpansionResult;
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
    "chat:attach-file",
    async (_event, sourcePath: string, paperId?: string, mimeType?: string) => {
      if (paperId && !store.getPaper(paperId)) {
        throw new Error("文献不存在。");
      }
      if (!sourcePath || !isAbsolute(sourcePath)) {
        throw new Error("只能上传本机文件。");
      }
      return saveChatAttachment(app.getPath("userData"), sourcePath, {
        paperId,
        mimeType,
      });
    },
  );
  ipcMain.handle(
    "chat:attach-data",
    async (
      _event,
      input: { fileName: string; mimeType?: string; data: Uint8Array },
      paperId?: string,
    ) => {
      if (paperId && !store.getPaper(paperId)) {
        throw new Error("文献不存在。");
      }
      if (!input?.fileName || !input.data) {
        throw new Error("附件数据不完整。");
      }
      return saveChatAttachmentData(app.getPath("userData"), input, {
        paperId,
      });
    },
  );
  ipcMain.handle(
    "chat:attach-paper-markdown",
    async (_event, paperId: string) => {
      const paper = store.getPaper(paperId);
      if (!paper) throw new Error("文献不存在。");
      const sourcePath = await ensurePaperMarkdownArtifact(paperId);
      return saveChatAttachment(app.getPath("userData"), sourcePath, {
        paperId,
        fileName: "full.md",
        source: "library",
        mimeType: "text/markdown",
      });
    },
  );
  ipcMain.handle(
    "chat:remove-attachment",
    async (_event, attachmentId: string) =>
      removeChatAttachment(app.getPath("userData"), attachmentId),
  );
  ipcMain.handle(
    "chat:append",
    async (_event, paperId: string, message: ChatMessage) => {
      const previousMessages = store.listChatMessages(paperId);
      const previousImageIds = selectionImageIds(previousMessages);
      const previousAttachmentIds = chatAttachmentIds(previousMessages);
      const next = store.appendChatMessage(paperId, message);
      const nextImageIds = new Set(selectionImageIds(next));
      const nextAttachmentIds = new Set(chatAttachmentIds(next));
      await removeSelectionImages(
        previousImageIds.filter((id) => !nextImageIds.has(id)),
      );
      await removeChatAttachments(
        previousAttachmentIds.filter((id) => !nextAttachmentIds.has(id)),
      );
      return next;
    },
  );
  ipcMain.handle("chat:clear", async (_event, paperId: string) => {
    const messages = store.listChatMessages(paperId);
    const imageIds = selectionImageIds(messages);
    const attachmentIds = chatAttachmentIds(messages);
    store.clearChatMessages(paperId);
    await removeSelectionImages(imageIds);
    await removeChatAttachments(attachmentIds);
  });
  ipcMain.handle(
    "chat:replace",
    async (_event, paperId: string, messages: ChatMessage[]) => {
      const previousMessages = store.listChatMessages(paperId);
      const previousImageIds = selectionImageIds(previousMessages);
      const previousAttachmentIds = chatAttachmentIds(previousMessages);
      const next = store.replaceChatMessages(paperId, messages);
      const nextImageIds = new Set(selectionImageIds(next));
      const nextAttachmentIds = new Set(chatAttachmentIds(next));
      await removeSelectionImages(
        previousImageIds.filter((id) => !nextImageIds.has(id)),
      );
      await removeChatAttachments(
        previousAttachmentIds.filter((id) => !nextAttachmentIds.has(id)),
      );
      return next;
    },
  );
  ipcMain.handle("selection-images:save", async (_event, dataUrl: string) => {
    const id = await saveSelectionImage(dataUrl);
    return { id, url: selectionImageUrl(id) };
  });
  ipcMain.handle("chat:ask", (event, input: AskPaperInput) =>
    chatRuns.execute(
      event.sender,
      input,
      (run) =>
        runPaperChat(input, run, {
          getPaper: (paperId) => store.getPaper(paperId),
          getProvider: () => store.getActiveProvider(),
          askPaper,
          compactConversation: compactPaperConversation,
          planResearch: planPaperResearch,
          resolveAttachments: resolveRequestedChatAttachments,
          includePaperPdf: includeCurrentPaperPdf,
          searchEvidence: searchPaperEvidence,
          hydrateImages: hydrateSelectionImages,
          ensureMarkdown: ensurePaperMarkdownArtifact,
          repairMarkdown: runPaperMarkdownRepair,
        }),
      input.task === "repair-markdown"
        ? "Markdown 修复完成"
        : input.task === "compact"
          ? "上下文压缩完成"
          : "文献回答完成",
    ),
  );
  ipcMain.handle("chat:cancel", (event, requestId: string) =>
    chatRuns.cancel(event.sender.id, requestId),
  );

  ipcMain.handle("notes:list", () => store.listPaperNotes());
  ipcMain.handle("notes:get", (_event, paperId: string) =>
    store.getPaperNote(paperId),
  );
  ipcMain.handle(
    "notes:save",
    async (_event, paperId: string, content: string) => {
      const paper = store.getPaper(paperId);
      if (!paper) throw new Error("文献不存在。");
      const note = store.savePaperNote(paperId, content);
      await writePaperNoteArtifact(
        resolvePaperArtifactDirectory(paperId),
        paper,
        note,
      );
      return note;
    },
  );
  ipcMain.handle(
    "notes:generate",
    async (event, paperId: string, requestedId?: string) => {
      const requestId = requestedId || crypto.randomUUID();
      const controller = new AbortController();
      noteGenerationAbortControllers.set(requestId, controller);
      let sequence = 0;
      const emit = (
        value: Omit<AgentEvent, "requestId" | "sequence" | "timestamp">,
      ): void => {
        if (event.sender.isDestroyed()) return;
        event.sender.send("notes:agent-event", {
          requestId,
          sequence: ++sequence,
          timestamp: new Date().toISOString(),
          ...value,
        } satisfies AgentEvent);
      };
      try {
        const paper = store.getPaper(paperId);
        if (!paper) throw new Error("文献不存在。");
        const pdfPath = store.resolvePaperPath(paperId);
        if (!pdfPath) throw new Error("论文 PDF 文件不存在。");
        emit({
          type: "run.started",
          title: "开始生成阅读笔记",
          detail: paper.title,
          status: "running",
        });
        emit({
          type: "plan.created",
          title: "执行计划",
          detail: "准备全文 → 分批提取带页码证据 → 综合阅读笔记 → 保存并验证",
          status: "completed",
        });
        emit({
          type: "tool.started",
          title: "准备论文全文",
          detail: "检查 PDF.js 转换结果和本地全文缓存",
          tool: "prepare_paper_markdown",
          stepId: "prepare-markdown",
          status: "running",
        });
        const markdownPath = await ensurePaperMarkdownArtifact(paperId).catch(
          () => undefined,
        );
        if (controller.signal.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        emit({
          type: "tool.completed",
          title: "论文全文已准备",
          detail: markdownPath ? "使用本地 full.md" : "使用原始 PDF",
          tool: "prepare_paper_markdown",
          stepId: "prepare-markdown",
          status: "completed",
        });
        emit({
          type: "step.started",
          title: "提取分批证据并生成总结",
          detail: "长论文按页面分批处理，再执行 Map-Reduce 综合",
          stepId: "summarize-paper",
          status: "running",
        });
        const result = await generatePaperNote(
          store.getActiveProvider(),
          { paper, pdfPath, markdownPath },
          {
            signal: controller.signal,
            checkpoint: createPaperAgentBatchCheckpoint(
              resolvePaperArtifactDirectory(paperId),
            ),
            onProgress: (progress) => {
              const contentSnapshot = progress.answerContent;
              emit({
                type:
                  contentSnapshot !== undefined
                    ? "content.snapshot"
                    : progress.answerDelta
                      ? "content.delta"
                      : "progress.updated",
                title: progress.detail || "正在生成阅读笔记",
                detail: progress.answerDelta ? undefined : progress.detail,
                delta: progress.answerDelta,
                stepId: "summarize-paper",
                status: "running",
                metadata:
                  contentSnapshot !== undefined
                    ? { content: contentSnapshot }
                    : undefined,
              });
            },
          },
        );
        emit({
          type: "step.completed",
          title: "论文总结已生成",
          stepId: "summarize-paper",
          status: "completed",
          metadata: { source: result.source, model: result.model },
        });
        emit({
          type: "verification.started",
          title: "保存并验证阅读笔记",
          tool: "save_paper_note",
          status: "running",
        });
        const note = store.savePaperNote(paperId, result.content);
        await writePaperNoteArtifact(
          resolvePaperArtifactDirectory(paperId),
          paper,
          note,
        );
        emit({
          type: "verification.completed",
          title: "阅读笔记已保存",
          detail: "已写入本地笔记与 Markdown 工件",
          tool: "save_paper_note",
          status: "completed",
        });
        emit({
          type: "run.completed",
          title: "文献总结完成",
          status: "completed",
        });
        return {
          note,
          protocol: result.protocol,
          model: result.model,
          source: result.source,
          warning: result.warning,
        };
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          emit({
            type: "run.cancelled",
            title: "阅读笔记生成已停止",
            detail: "已完成的证据批次会在下次继续生成时复用",
            status: "failed",
          });
          return { cancelled: true as const };
        }
        emit({
          type: "run.failed",
          title: "阅读笔记生成失败",
          detail: error instanceof Error ? error.message : String(error),
          status: "failed",
        });
        throw error;
      } finally {
        noteGenerationAbortControllers.delete(requestId);
      }
    },
  );
  ipcMain.handle("notes:cancel", (_event, requestId: string) => {
    const controller = noteGenerationAbortControllers.get(requestId);
    if (!controller) return false;
    controller.abort();
    noteGenerationAbortControllers.delete(requestId);
    return true;
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

  ipcMain.handle("reviews:list", () => store.listLibraryReviews());
  ipcMain.handle(
    "reviews:generate",
    async (event, input: GenerateLibraryReviewInput) => {
      const requestId = input.requestId?.trim() || crypto.randomUUID();
      const controller = new AbortController();
      reviewGenerationAbortControllers.set(requestId, controller);
      let sequence = 0;
      const emit = (
        value: Omit<AgentEvent, "requestId" | "sequence" | "timestamp">,
      ): void => {
        if (event.sender.isDestroyed()) return;
        event.sender.send("reviews:agent-event", {
          requestId,
          sequence: ++sequence,
          timestamp: new Date().toISOString(),
          ...value,
        } satisfies AgentEvent);
      };
      try {
        const papers = store
          .listPapers()
          .filter((paper) => !paper.archived && paper.status === "ready");
        if (!papers.length) {
          throw new Error(
            "\u5f53\u524d\u6ca1\u6709\u53ef\u7528\u4e8e\u751f\u6210\u5168\u5e93\u7efc\u8ff0\u7684\u5df2\u7d22\u5f15\u6587\u732e\u3002",
          );
        }
        emit({
          type: "run.started",
          title: "\u5f00\u59cb\u751f\u6210\u5168\u5e93\u6587\u732e\u7efc\u8ff0",
          detail:
            input.focus?.trim() ||
            "\u7efc\u5408\u68b3\u7406\u5f53\u524d\u6587\u732e\u5e93",
          status: "running",
        });
        const notes = new Map(
          store.listPaperNotes().map((note) => [note.paperId, note]),
        );
        const missing = papers.filter(
          (paper) => !notes.get(paper.id)?.content.trim(),
        );
        if (missing.length) {
          throw new Error(
            `\u8fd8\u6709 ${missing.length} \u7bc7\u6587\u732e\u7f3a\u5c11\u8bba\u6587\u7b14\u8bb0\uff0c\u8bf7\u5148\u751f\u6210\u6216\u8865\u5168\u7b14\u8bb0\u3002`,
          );
        }
        emit({
          type: "tool.completed",
          title: "\u5df2\u6536\u96c6\u6587\u732e\u7b14\u8bb0",
          detail: `\u5171 ${papers.length} \u7bc7\u6587\u732e`,
          tool: "collect_library_notes",
          status: "completed",
        });
        const snapshot = buildCitationGraphSnapshot(
          papers,
          store.getCitationGraphCache(),
        );
        emit({
          type: "tool.completed",
          title: "\u5df2\u8bfb\u53d6\u5e93\u5185\u5f15\u7528\u5173\u7cfb",
          detail: `${snapshot.edges.length} \u6761\u5f15\u7528\u8fb9`,
          tool: "read_citation_graph",
          status: "completed",
        });
        const result = await generateLibraryReview(
          store.getActiveProvider(),
          {
            focus: input.focus ?? "",
            papers: papers.map((paper, index) => ({
              label: `P${index + 1}`,
              title: paper.title,
              authors: [...paper.authors],
              year: paper.year,
              doi: paper.doi,
              note: notes.get(paper.id)!,
            })),
            citationContext: buildLibraryReviewCitationContext(
              snapshot,
              papers,
            ),
          },
          {
            signal: controller.signal,
            checkpoint: createAgentBatchCheckpoint(
              join(app.getPath("userData"), "agent", "library-review"),
            ),
            onProgress: (progress) => {
              const contentSnapshot = progress.answerContent;
              emit({
                type:
                  contentSnapshot !== undefined
                    ? "content.snapshot"
                    : progress.answerDelta
                      ? "content.delta"
                      : "progress.updated",
                title:
                  progress.detail ||
                  "\u6b63\u5728\u751f\u6210\u6587\u732e\u7efc\u8ff0",
                detail: progress.answerDelta ? undefined : progress.detail,
                delta: progress.answerDelta,
                metadata:
                  contentSnapshot !== undefined
                    ? { content: contentSnapshot }
                    : undefined,
                status: "running",
              });
            },
          },
        );
        const review = store.saveLibraryReview({
          id: crypto.randomUUID(),
          ...result,
          paperIds: papers.map((paper) => paper.id),
          createdAt: new Date().toISOString(),
        });
        emit({
          type: "run.completed",
          title: "\u5168\u5e93\u6587\u732e\u7efc\u8ff0\u5df2\u4fdd\u5b58",
          detail: `\u5df2\u7efc\u5408 ${papers.length} \u7bc7\u6587\u732e`,
          status: "completed",
        });
        return review;
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          emit({
            type: "run.cancelled",
            title: "\u5168\u5e93\u7efc\u8ff0\u751f\u6210\u5df2\u505c\u6b62",
            status: "failed",
          });
          return { cancelled: true as const };
        }
        emit({
          type: "run.failed",
          title: "\u5168\u5e93\u7efc\u8ff0\u751f\u6210\u5931\u8d25",
          detail: error instanceof Error ? error.message : String(error),
          status: "failed",
        });
        throw error;
      } finally {
        reviewGenerationAbortControllers.delete(requestId);
      }
    },
  );
  ipcMain.handle("reviews:cancel", (_event, requestId: string) => {
    const controller = reviewGenerationAbortControllers.get(requestId);
    if (!controller) return false;
    controller.abort();
    reviewGenerationAbortControllers.delete(requestId);
    return true;
  });
  ipcMain.handle("reviews:remove", (_event, reviewId: string) =>
    store.removeLibraryReview(reviewId),
  );
  ipcMain.handle(
    "reviews:export-markdown",
    async (_event, reviewId: string) => {
      const review = store.getLibraryReview(reviewId);
      if (!review) throw new Error("全库综述不存在。");
      const selected = await dialog.showSaveDialog(mainWindow!, {
        title: "导出全库文献综述",
        defaultPath: join(
          app.getPath("documents"),
          libraryReviewFileName(review),
        ),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (selected.canceled || !selected.filePath) return false;
      await writeFile(
        selected.filePath,
        buildLibraryReviewExport(review, store.listPapers()),
        "utf8",
      );
      return true;
    },
  );

  ipcMain.handle(
    "knowledge-base:preview-markdown",
    async (_event, paperId: string, version?: "ai" | "original") => {
      const paper = store.listPapers().find((item) => item.id === paperId);
      if (!paper) throw new Error("论文不存在。");
      const pdfPath = store.resolvePaperPath(paperId);
      if (!pdfPath) throw new Error("论文 PDF 文件不存在。");
      const directory = resolvePaperArtifactDirectory(paperId);
      const cached = await readKnowledgeMarkdownRepairCache(
        directory,
        paperId,
        pdfPath,
        legacyKnowledgeMarkdownCacheRoot(),
      );
      if (cached && version !== "original") {
        await writePaperTextArtifacts(directory, paper, { repair: cached });
        await reindexPaperMarkdown(paperId);
        const originalMarkdown = await readFile(
          join(directory, "full.raw.md"),
          "utf8",
        ).catch(() => "");
        return {
          paperId,
          markdown: cached.markdown,
          pageCount: cached.pageCount,
          generatedAt: new Date().toISOString(),
          aiRepaired: true,
          hasAiRepairedVersion: true,
          model: cached.model,
          repairedAt: cached.repairedAt,
          warnings: cached.warnings,
          repairReport: cached.repairReport,
          comparison: originalMarkdown
            ? compareMarkdownVersions(originalMarkdown, cached.markdown)
            : undefined,
        };
      }
      const rawMarkdown = await readFile(
        join(directory, "full.raw.md"),
        "utf8",
      ).catch(() => "");
      const pages = rawMarkdown
        ? []
        : await documentEngine.request<DocumentPageText[]>(
            "document_text",
            {
              paper_id: paperId,
              index_dir: join(app.getPath("userData"), "indexes"),
            },
            60_000,
          );
      if (!rawMarkdown && !pages.length) {
        throw new Error("没有可读取的 PDF.js 页面文本。");
      }
      if (!rawMarkdown)
        await writePaperTextArtifacts(directory, paper, { rawPages: pages });
      return {
        paperId,
        markdown: rawMarkdown || buildPaperFullTextMarkdown(paper, pages),
        pageCount: rawMarkdown ? (paper.pageCount ?? 0) : pages.length,
        generatedAt: new Date().toISOString(),
        aiRepaired: false,
        hasAiRepairedVersion: Boolean(cached),
      };
    },
  );

  ipcMain.handle(
    "knowledge-base:repair-markdown",
    async (event, paperId: string, requestedRequestId?: string) => {
      const requestId = requestedRequestId?.trim() || crypto.randomUUID();
      const controller = new AbortController();
      let agentSequence = 0;
      const sendAgentEvent = (
        value: Omit<AgentEvent, "requestId" | "sequence" | "timestamp">,
      ): void => {
        if (event.sender.isDestroyed()) return;
        event.sender.send("knowledge-base:agent-event", {
          requestId,
          sequence: ++agentSequence,
          timestamp: new Date().toISOString(),
          ...value,
        } satisfies AgentEvent);
      };
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, MARKDOWN_REPAIR_TIMEOUT_MS);
      knowledgeMarkdownRepairAbortControllers.set(requestId, controller);

      try {
        sendAgentEvent({
          type: "run.started",
          title: "启动 Markdown 修复 Agent",
          detail: "将先检查本地提取质量，再只修复异常批次",
          status: "running",
        });
        sendAgentEvent({
          type: "plan.created",
          title: "执行计划",
          detail:
            "读取 PDF.js 原文 → 分批质量诊断 → 修复异常批次 → 完整性校验 → 写回缓存与索引",
          status: "completed",
        });
        const result = await runPaperMarkdownRepair(
          paperId,
          requestId,
          controller.signal,
          undefined,
          sendAgentEvent,
          (content, done) => {
            mainWindow?.webContents.send("knowledge-base:markdown-preview", {
              requestId,
              paperId,
              content,
              characters: content.length,
              done,
              previewOnly: !done,
              generatedAt: new Date().toISOString(),
            } satisfies KnowledgeBaseMarkdownStream);
          },
        );
        sendAgentEvent({
          type: "run.completed",
          title: "Markdown 修复 Agent 完成",
          detail: result.repairReport
            ? `共 ${result.repairReport.batchCount} 批，修复 ${result.repairReport.repairedBatchCount} 批，保留 ${result.repairReport.preservedBatchCount} 批`
            : `已完成 ${result.pageCount} 页处理`,
          status: "completed",
        });
        return result;
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          sendAgentEvent({
            type: "run.cancelled",
            title: timedOut ? "修复任务超时" : "修复任务已停止",
            status: "failed",
          });
          if (timedOut) {
            throw new Error("AI 文件修复超过 20 分钟，已自动停止。", {
              cause: error,
            });
          }
          mainWindow?.webContents.send("knowledge-base:progress", {
            requestId,
            phase: "cancelled",
            completed: 0,
            total: 1,
            paperId,
            detail: "文件修复已停止",
          } satisfies KnowledgeBaseRepairProgress);
          return { cancelled: true as const };
        }
        sendAgentEvent({
          type: "run.failed",
          title: "Markdown 修复失败",
          detail: error instanceof Error ? error.message : String(error),
          status: "failed",
        });
        throw error;
      } finally {
        clearTimeout(timeout);
        if (
          knowledgeMarkdownRepairAbortControllers.get(requestId) === controller
        ) {
          knowledgeMarkdownRepairAbortControllers.delete(requestId);
        }
      }
    },
  );

  ipcMain.handle(
    "knowledge-base:export",
    async (_event, options?: KnowledgeBaseExportOptions) => {
      const aiRepair = Boolean(options?.aiRepair);
      const requestId = options?.requestId || crypto.randomUUID();
      const controller = new AbortController();
      knowledgeExportAbortControllers.set(requestId, controller);
      const repairCredentials = aiRepair
        ? store.getActiveProvider()
        : undefined;
      try {
        const selected = await dialog.showOpenDialog(mainWindow!, {
          title: "选择知识库导出目录",
          properties: ["openDirectory", "createDirectory"],
        });
        if (selected.canceled || !selected.filePaths[0]) return null;
        if (controller.signal.aborted) return { cancelled: true as const };

        const activePapers = store
          .listPapers()
          .filter((paper) => !paper.archived);
        const requestedIds = options?.paperIds
          ? new Set(options.paperIds)
          : undefined;
        if (requestedIds && !requestedIds.size) {
          throw new Error("请至少选择一篇论文导出。");
        }
        const papers = requestedIds
          ? activePapers.filter((paper) => requestedIds.has(paper.id))
          : activePapers;
        if (requestedIds && papers.length !== requestedIds.size) {
          throw new Error("所选论文中包含已归档或已删除的项目。");
        }
        if (!papers.length) throw new Error("当前没有可导出的未归档文献。");
        const paperIds = new Set(papers.map((paper) => paper.id));
        const citationGraph = buildCitationGraphSnapshot(
          papers,
          store.getCitationGraphCache(),
        );
        const sendProgress = (progress: KnowledgeBaseRepairProgress): void => {
          mainWindow?.webContents.send("knowledge-base:progress", {
            ...progress,
            requestId,
          });
        };
        const result = await exportKnowledgeBase({
          destinationRoot: selected.filePaths[0],
          papers,
          folders: store.listFolders(),
          notes: store
            .listPaperNotes()
            .filter((note) => paperIds.has(note.paperId)),
          reviews: store.listLibraryReviews(),
          citationGraph,
          resolvePaperPath: (paperId) => store.resolvePaperPath(paperId),
          readDocumentPages: (paperId) =>
            documentEngine.request<DocumentPageText[]>(
              "document_text",
              {
                paper_id: paperId,
                index_dir: join(app.getPath("userData"), "indexes"),
              },
              60_000,
            ),
          signal: controller.signal,
          onProgress: sendProgress,
          aiRepair: repairCredentials
            ? {
                readCachedText: async (paper) => {
                  const pdfPath = store.resolvePaperPath(paper.id);
                  if (!pdfPath) return null;
                  const directory = resolvePaperArtifactDirectory(paper.id);
                  const cached = await readKnowledgeMarkdownRepairCache(
                    directory,
                    paper.id,
                    pdfPath,
                    legacyKnowledgeMarkdownCacheRoot(),
                  );
                  if (cached) {
                    await writePaperTextArtifacts(directory, paper, {
                      repair: cached,
                    });
                    await reindexPaperMarkdown(paper.id);
                  }
                  return cached;
                },
                saveRepairedText: async (paper, repairResult, rawPages) => {
                  const pdfPath = store.resolvePaperPath(paper.id);
                  if (!pdfPath) {
                    throw new Error(
                      "论文 PDF 文件不存在，无法保存 AI 正文缓存。",
                    );
                  }
                  const directory = resolvePaperArtifactDirectory(paper.id);
                  const cached = await writeKnowledgeMarkdownRepairCache(
                    directory,
                    paper.id,
                    pdfPath,
                    {
                      markdown: repairResult.markdown,
                      pageCount: repairResult.pageCount,
                      model: repairResult.model,
                      protocol: repairResult.textProtocol,
                      warnings: repairResult.textWarnings,
                      repairReport:
                        repairResult.batchCount !== undefined
                          ? {
                              batchCount: repairResult.batchCount,
                              repairedBatchCount:
                                repairResult.repairedBatchCount ?? 0,
                              preservedBatchCount:
                                repairResult.preservedBatchCount ?? 0,
                              detectedIssues: repairResult.detectedIssues ?? [],
                            }
                          : undefined,
                    },
                  );
                  await writePaperTextArtifacts(directory, paper, {
                    rawPages,
                    repair: cached,
                  });
                  await reindexPaperMarkdown(paper.id);
                  return cached;
                },
                repairPaper: (input, onStage, cachedMarkdown) =>
                  repairKnowledgePaperExport(
                    repairCredentials,
                    input,
                    onStage,
                    {
                      signal: controller.signal,
                      cachedMarkdown,
                      checkpoint: createPaperAgentBatchCheckpoint(
                        resolvePaperArtifactDirectory(input.paper.id),
                      ),
                    },
                  ),
              }
            : undefined,
        });
        shell.showItemInFolder(join(result.path, "manifest.json"));
        return result;
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          mainWindow?.webContents.send("knowledge-base:progress", {
            requestId,
            phase: "cancelled",
            completed: 0,
            total: 0,
            detail: "知识库导出已中断",
          } satisfies KnowledgeBaseRepairProgress);
          return { cancelled: true as const };
        }
        throw error;
      } finally {
        knowledgeExportAbortControllers.delete(requestId);
      }
    },
  );
  ipcMain.handle("knowledge-base:cancel", (_event, requestId: string) => {
    const controller =
      knowledgeExportAbortControllers.get(requestId) ??
      knowledgeMarkdownRepairAbortControllers.get(requestId);
    if (!controller) return false;
    controller.abort();
    knowledgeExportAbortControllers.delete(requestId);
    knowledgeMarkdownRepairAbortControllers.delete(requestId);
    return true;
  });

  ipcMain.handle(
    "search:library",
    async (_event, input: LibrarySearchInput): Promise<LibrarySearchHit[]> => {
      const query = input.query.trim();
      if (!query) return [];
      if (query.length > 500) {
        throw new Error("全库搜索问题不能超过 500 个字符。");
      }
      // Renderer 只提交查询文本；主进程负责选择论文、定位 SQLite，
      // 再把文档引擎返回的内部字段转换为前端使用的 LibrarySearchHit。
      const hits = await searchLibraryIndex(query, input.limit ?? 30);
      return hits.map((hit) => ({
        paperId: hit.paper_id,
        chunkId: hit.chunk_id,
        page: hit.page,
        text: hit.text,
        score: hit.score,
      }));
    },
  );
  ipcMain.handle(
    "search:ask-library",
    async (event, input: LibraryAskInput): Promise<LibraryAskResult> => {
      const requestId = input.requestId || crypto.randomUUID();
      const controller = new AbortController();
      let sequence = 0;
      let lastActivityAt = Date.now();
      const emitAgent = (
        value: Omit<AgentEvent, "requestId" | "sequence" | "timestamp">,
      ): void => {
        if (event.sender.isDestroyed()) return;
        event.sender.send("search:agent-event", {
          requestId,
          sequence: ++sequence,
          timestamp: new Date().toISOString(),
          ...value,
        } satisfies AgentEvent);
      };
      const emitProgress = (
        progress: Omit<ChatProgress, "requestId">,
      ): void => {
        if (event.sender.isDestroyed()) return;
        lastActivityAt = Date.now();
        const publicProgress = toPublicChatProgress(progress);
        event.sender.send("search:progress", {
          requestId,
          ...publicProgress,
        } satisfies ChatProgress);
        if (progress.answerDelta) {
          emitAgent({
            type: "content.delta",
            title: "正在生成全库回答",
            delta: progress.answerDelta,
            status: "running",
          });
        } else if (progress.answerContent !== undefined) {
          emitAgent({
            type: "content.snapshot",
            title: "正在生成全库回答",
            detail: progress.detail || "已收到回答快照",
            metadata: { content: progress.answerContent },
            status: "running",
          });
        } else if (progress.phase === "thinking") {
          emitAgent({
            type: "progress.updated",
            title: progress.detail || "正在分析证据",
            detail: "正在执行当前公开研究阶段；模型私有推理不会发送到界面。",
            status: "running",
          });
        }
      };
      libraryAskAbortControllers.set(requestId, controller);
      const progressHeartbeat = setInterval(() => {
        const silentForMs = Date.now() - lastActivityAt;
        if (silentForMs < 5_000 || event.sender.isDestroyed()) return;
        emitAgent({
          type: "progress.updated",
          title: "等待当前研究步骤返回",
          detail: `已连续 ${Math.floor(
            silentForMs / 1_000,
          )}s 未收到新的检索或模型事件`,
          status: "running",
        });
      }, 2_000);
      progressHeartbeat.unref();
      const totalTimeout = setTimeout(
        () => controller.abort(),
        LIBRARY_ASK_TIMEOUT_MS,
      );
      totalTimeout.unref();
      emitAgent({
        type: "run.started",
        title: "开始全库研究",
        detail: input.query.trim(),
        status: "running",
      });
      try {
        const query = input.query.trim();
        if (!query) throw new Error("请输入全库研究问题。");
        if (query.length > 500) {
          throw new Error("全库研究问题不能超过 500 个字符。");
        }
        const paperById = new Map(
          store.listPapers().map((paper) => [paper.id, paper]),
        );
        const seenHits = new Set<string>();
        const requestedHits = input.selectedHits ?? [];
        const selectedHits = requestedHits
          .slice(0, 30)
          .flatMap((hit): LibraryIndexHit[] => {
            const paperId = hit.paperId.trim();
            const chunkId = hit.chunkId.trim();
            const text = hit.text.trim().slice(0, 12_000);
            const page = Math.max(1, Math.trunc(hit.page));
            const key = `${paperId}:${chunkId}`;
            if (
              !paperId ||
              !chunkId ||
              !text ||
              !paperById.has(paperId) ||
              seenHits.has(key)
            ) {
              return [];
            }
            seenHits.add(key);
            return [
              {
                paper_id: paperId,
                chunk_id: chunkId,
                page,
                text,
                score: Number.isFinite(hit.score) ? hit.score : 0,
              },
            ];
          });
        const sourceMode = selectedHits.length ? "selected" : "retrieved";
        let researchQueries = [query];
        if (sourceMode === "retrieved") {
          emitAgent({
            type: "step.started",
            title: "制定研究检索计划",
            detail: "模型正在把问题拆成可执行的证据检索任务",
            stepId: "plan-research",
            status: "running",
          });
          try {
            const plan = await planLibraryResearch(
              store.getActiveProvider(),
              {
                question: query,
                history: (input.history ?? []).slice(-8),
                reasoningEffort: input.reasoningEffort,
              },
              { signal: controller.signal },
            );
            researchQueries = plan.queries;
            emitAgent({
              type: "plan.created",
              title: "研究计划已生成",
              detail: plan.rationale,
              stepId: "plan-research",
              status: "completed",
              metadata: {
                queries: plan.queries,
                expectedEvidence: plan.expectedEvidence,
              },
            });
          } catch (error) {
            if (controller.signal.aborted || isAbortError(error)) throw error;
            emitAgent({
              type: "plan.created",
              title: "使用保底检索计划",
              detail:
                error instanceof Error
                  ? `规划模型未返回有效计划，直接检索原问题：${error.message}`
                  : "规划模型未返回有效计划，直接检索原问题。",
              stepId: "plan-research",
              status: "completed",
              metadata: { queries: researchQueries, fallback: true },
            });
          }
        }
        let rawHits: LibraryIndexHit[];
        if (selectedHits.length) {
          emitAgent({
            type: "tool.started",
            title: "读取选中证据",
            detail: `${selectedHits.length} 个用户选中片段`,
            tool: "library-search",
            status: "running",
          });
          rawHits = selectedHits;
          emitAgent({
            type: "tool.completed",
            title: "选中证据已读取",
            detail: `${selectedHits.length} 个有效片段`,
            tool: "library-search",
            status: "completed",
          });
        } else {
          if (requestedHits.length) {
            emitAgent({
              type: "progress.updated",
              title: "选中证据已失效",
              detail: "固定片段不再存在，已自动切换为全文检索。",
              status: "completed",
            });
          }
          const queryHits = await Promise.all(
            researchQueries.map(async (researchQuery, queryIndex) => {
              if (controller.signal.aborted) {
                throw new DOMException(
                  "The operation was aborted.",
                  "AbortError",
                );
              }
              emitAgent({
                type: "tool.started",
                title: `检索文献库 ${queryIndex + 1}/${researchQueries.length}`,
                detail: researchQuery,
                tool: "library-search",
                status: "running",
                metadata: { query: researchQuery, queryIndex },
              });
              const result = await withTimeout(
                searchLibraryIndex(researchQuery, 30),
                LIBRARY_SEARCH_TIMEOUT_MS,
                `文献库检索超时：${researchQuery}`,
              );
              if (controller.signal.aborted) {
                throw new DOMException(
                  "The operation was aborted.",
                  "AbortError",
                );
              }
              emitAgent({
                type: "tool.completed",
                title: `文献库检索完成 ${queryIndex + 1}/${researchQueries.length}`,
                detail: `${researchQuery}：${result.length} 个候选片段`,
                tool: "library-search",
                status: "completed",
                metadata: {
                  query: researchQuery,
                  queryIndex,
                  evidenceCount: result.length,
                },
              });
              return result;
            }),
          );
          rawHits = queryHits.flat();
        }
        emitAgent({
          type: "step.completed",
          title: "证据检索全部完成",
          detail: `${rawHits.length} 个候选片段`,
          stepId: "retrieve-evidence",
          status: "completed",
        });
        const hits = rawHits
          .sort((left, right) => right.score - left.score)
          .filter((hit, index, all) => {
            const key = `${hit.paper_id}:${hit.chunk_id}`;
            return (
              all.findIndex(
                (candidate) =>
                  `${candidate.paper_id}:${candidate.chunk_id}` === key,
              ) === index
            );
          })
          .slice(0, 80);
        if (!hits.length) {
          throw new Error("尚未检索到可用论文内容，请等待文献解析完成。");
        }
        emitAgent({
          type: "step.completed",
          title: "论文证据已准备",
          detail: `${hits.length} 个去重片段，来自 ${researchQueries.length} 路检索`,
          stepId: "prepare-evidence",
          status: "completed",
          metadata: {
            queryCount: researchQueries.length,
            evidenceCount: hits.length,
          },
        });
        const paperIds = [...new Set(hits.map((hit) => hit.paper_id))].filter(
          (paperId) => paperById.has(paperId),
        );
        const labelByPaperId = new Map(
          paperIds.map((paperId, index) => [paperId, `P${index + 1}`]),
        );
        const sources = hits.flatMap((hit) => {
          const paperLabel = labelByPaperId.get(hit.paper_id);
          if (!paperLabel) return [];
          return [
            {
              paperId: hit.paper_id,
              paperLabel,
              chunk_id: hit.chunk_id,
              page: hit.page,
              text: hit.text,
            },
          ];
        });
        const history = (input.history ?? []).slice(-12).flatMap((message) => {
          const content = message.content.trim().slice(0, 12_000);
          if (
            !content ||
            (message.role !== "user" && message.role !== "assistant")
          ) {
            return [];
          }
          return [{ role: message.role, content }];
        });
        emitAgent({
          type: "step.started",
          title: "综合多篇论文证据",
          detail: `覆盖 ${paperIds.length} 篇论文`,
          stepId: "synthesize",
          status: "running",
        });
        let result = await answerLibraryQuestion(
          store.getActiveProvider(),
          {
            question: query,
            reasoningEffort: input.reasoningEffort,
            papers: paperIds.map((paperId) => ({
              id: paperId,
              label: labelByPaperId.get(paperId)!,
              title: paperById.get(paperId)!.title,
            })),
            sources,
            history,
            sourceMode,
          },
          {
            signal: controller.signal,
            onProgress: emitProgress,
          },
        );
        if (result.citations.length === 0 && sourceMode === "retrieved") {
          emitAgent({
            type: "verification.started",
            title: "证据不足，扩大检索范围",
            detail: "从 30 个候选片段扩大到 80 个，并重新筛选论文证据。",
            status: "running",
          });
          const expandedHits = (
            await Promise.all(
              researchQueries.map(async (researchQuery, queryIndex) => {
                if (controller.signal.aborted) {
                  throw new DOMException(
                    "The operation was aborted.",
                    "AbortError",
                  );
                }
                emitAgent({
                  type: "tool.started",
                  title: `扩大文献库检索 ${queryIndex + 1}/${researchQueries.length}`,
                  detail: researchQuery,
                  tool: "library-search-expanded",
                  status: "running",
                });
                const queryResult = await withTimeout(
                  searchLibraryIndex(researchQuery, 80),
                  LIBRARY_SEARCH_TIMEOUT_MS,
                  `扩展文献库检索超时：${researchQuery}`,
                );
                emitAgent({
                  type: "tool.completed",
                  title: `扩大检索完成 ${queryIndex + 1}/${researchQueries.length}`,
                  detail: `${queryResult.length} 个候选片段`,
                  tool: "library-search-expanded",
                  status: "completed",
                });
                return queryResult;
              }),
            )
          )
            .flat()
            .sort((left, right) => right.score - left.score)
            .filter((hit, index, all) => {
              const key = `${hit.paper_id}:${hit.chunk_id}`;
              return (
                all.findIndex(
                  (candidate) =>
                    `${candidate.paper_id}:${candidate.chunk_id}` === key,
                ) === index
              );
            })
            .slice(0, 120);
          const expandedPaperIds = [
            ...new Set(expandedHits.map((hit) => hit.paper_id)),
          ].filter((paperId) => paperById.has(paperId));
          const expandedLabelByPaperId = new Map(
            expandedPaperIds.map((paperId, index) => [
              paperId,
              `P${index + 1}`,
            ]),
          );
          const expandedSources = expandedHits.flatMap((hit) => {
            const paperLabel = expandedLabelByPaperId.get(hit.paper_id);
            return paperLabel
              ? [
                  {
                    paperId: hit.paper_id,
                    paperLabel,
                    chunk_id: hit.chunk_id,
                    page: hit.page,
                    text: hit.text,
                  },
                ]
              : [];
          });
          result = await answerLibraryQuestion(
            store.getActiveProvider(),
            {
              question: query,
              reasoningEffort: input.reasoningEffort,
              papers: expandedPaperIds.map((paperId) => ({
                id: paperId,
                label: expandedLabelByPaperId.get(paperId)!,
                title: paperById.get(paperId)!.title,
              })),
              sources: expandedSources,
              history,
              sourceMode: "retrieved",
            },
            {
              signal: controller.signal,
              onProgress: emitProgress,
            },
          );
        }
        result.citationVerification =
          result.citations.length > 0
            ? {
                status: "verified",
                detail: `已定位 ${result.citations.length} 条跨文献引用。`,
              }
            : {
                status: "unverified",
                detail:
                  "扩大检索并重新生成后仍未获得可定位引用，请把当前回答视为未验证结果。",
              };
        emitAgent({
          type: "verification.completed",
          title:
            result.citationVerification.status === "verified"
              ? "引用定位已完成"
              : "引用验证未通过",
          detail: result.citationVerification.detail,
          status:
            result.citationVerification.status === "verified"
              ? "completed"
              : "failed",
        });
        emitAgent({
          type: "run.completed",
          title: "全库研究完成",
          status: "completed",
        });
        return result;
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          emitAgent({
            type: "run.cancelled",
            title: "全库研究已取消",
            status: "completed",
          });
          throw new Error("全库研究已取消。", { cause: error });
        }
        emitAgent({
          type: "run.failed",
          title: "全库研究失败",
          detail: error instanceof Error ? error.message : String(error),
          status: "failed",
        });
        throw error;
      } finally {
        clearInterval(progressHeartbeat);
        clearTimeout(totalTimeout);
        libraryAskAbortControllers.delete(requestId);
      }
    },
  );
  ipcMain.handle("search:cancel-ask-library", (_event, requestId: string) => {
    const controller = libraryAskAbortControllers.get(requestId);
    if (!controller) return false;
    controller.abort();
    libraryAskAbortControllers.delete(requestId);
    return true;
  });

  // 保留既有 IPC 名称，避免破坏 preload 与已发布版本的前端契约。
  ipcMain.handle("worker:status", () => documentEngine.status());
}

interface LibraryIndexHit {
  paper_id: string;
  chunk_id: string;
  page: number;
  text: string;
  score: number;
}

interface MarkdownReindexResult {
  page_count: number;
  chunk_count: number;
  updated: boolean;
}

async function searchLibraryIndex(
  query: string,
  limit: number,
): Promise<LibraryIndexHit[]> {
  // 这里只判断 ready，不排除 archived，所以“全库检索”会同时覆盖
  // 普通文献和已归档文献。每篇论文仍然使用自己的 SQLite 文件。
  const paperIds = store
    .listPapers()
    .filter((paper) => paper.status === "ready")
    .map((paper) => paper.id);
  if (!paperIds.length) return [];
  return documentEngine.request<LibraryIndexHit[]>(
    "search_library",
    {
      paper_ids: paperIds,
      query,
      index_dir: join(app.getPath("userData"), "indexes"),
      limit: Math.max(1, Math.min(limit, 120)),
      per_paper_limit: 4,
    },
    240_000,
  );
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function searchPaperEvidence(
  paperId: string,
  query: string,
  limit = 6,
): Promise<PaperEvidenceCandidate[]> {
  try {
    const hits = await documentEngine.request<
      Array<{ page: number; text: string; score: number }>
    >(
      "search",
      {
        paper_id: paperId,
        query: query.trim(),
        index_dir: join(app.getPath("userData"), "indexes"),
        limit: Math.max(1, Math.min(limit, 30)),
      },
      120_000,
    );
    return hits
      .filter((hit) => Number.isInteger(hit.page) && hit.text?.trim())
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, Math.min(limit, 24)))
      .map((hit) => ({
        page: hit.page,
        text: hit.text.slice(0, 6_000),
        score: hit.score,
        query,
      }));
  } catch {
    // The PDF index may still be processing. Full-document context remains
    // available, so a missing local search index must not fail the question.
    return [];
  }
}

function buildLibraryReviewCitationContext(
  snapshot: CitationGraphSnapshot,
  papers: Paper[],
): string {
  const labelByPaperId = new Map(
    papers.map((paper, index) => [paper.id, `P${index + 1}`]),
  );
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  return snapshot.edges
    .flatMap((edge) => {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      if (!source || !target) return [];
      const sourceLabel = source.paperId
        ? labelByPaperId.get(source.paperId)
        : undefined;
      const targetLabel = target.paperId
        ? labelByPaperId.get(target.paperId)
        : undefined;
      if (sourceLabel && targetLabel) {
        return [`- 【${sourceLabel}】引用【${targetLabel}】`];
      }
      if (sourceLabel && target.kind === "external") {
        return [`- 【${sourceLabel}】引用外部文献《${target.title}》`];
      }
      if (targetLabel && source.kind === "external") {
        return [`- 外部文献《${source.title}》引用【${targetLabel}】`];
      }
      return [];
    })
    .slice(0, 160)
    .join("\n");
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

function chatAttachmentIds(messages: ChatMessage[]): string[] {
  return [
    ...new Set(
      messages.flatMap((message) =>
        (message.attachments ?? []).map((attachment) => attachment.id),
      ),
    ),
  ];
}

async function removeChatAttachments(attachmentIds: string[]): Promise<void> {
  await Promise.all(
    [...new Set(attachmentIds)].map((attachmentId) =>
      removeChatAttachment(app.getPath("userData"), attachmentId),
    ),
  );
}

async function resolveRequestedChatAttachments(
  attachments: ChatAttachment[] | undefined,
  paperId?: string,
): Promise<ResolvedChatAttachment[]> {
  const uniqueAttachments = [
    ...new Map(
      (attachments ?? []).map((attachment) => [attachment.id, attachment]),
    ).values(),
  ];
  if (uniqueAttachments.length > MAX_CHAT_ATTACHMENT_COUNT) {
    throw new Error(`单轮对话最多上传 ${MAX_CHAT_ATTACHMENT_COUNT} 个文件。`);
  }
  const totalBytes = uniqueAttachments.reduce(
    (sum, attachment) => sum + attachment.size,
    0,
  );
  if (totalBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
    throw new Error("单轮对话的附件总大小不能超过 80 MB。");
  }
  for (const attachment of uniqueAttachments) {
    if (attachment.paperId && attachment.paperId !== paperId) {
      throw new Error(`附件 ${attachment.fileName} 不属于当前论文会话。`);
    }
  }
  return Promise.all(
    uniqueAttachments.map((attachment) =>
      resolveChatAttachment(app.getPath("userData"), attachment),
    ),
  );
}

async function includeCurrentPaperPdf(
  paperId: string,
  attachments: ResolvedChatAttachment[],
  signal?: AbortSignal,
): Promise<ResolvedChatAttachment[]> {
  signal?.throwIfAborted();
  if (
    attachments.some(
      ({ attachment }) =>
        attachment.kind === "pdf" &&
        attachment.source === "library" &&
        attachment.paperId === paperId,
    )
  ) {
    return attachments;
  }

  const paper = store.getPaper(paperId);
  if (!paper) throw new Error("文献不存在。");
  const filePath = store.resolvePaperPath(paperId);
  if (!filePath) throw new Error("当前论文 PDF 文件不存在。");
  const info = await stat(filePath);
  signal?.throwIfAborted();
  if (!info.isFile() || info.size <= 0) {
    throw new Error("当前论文 PDF 文件无效。");
  }
  if (info.size > MAX_CHAT_ATTACHMENT_FILE_BYTES) {
    throw new Error("当前论文 PDF 超过 50 MB，无法直接提交给模型。");
  }
  const totalBytes =
    info.size +
    attachments.reduce((sum, resolved) => sum + resolved.attachment.size, 0);
  if (totalBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
    throw new Error("当前论文 PDF 与本轮附件总大小不能超过 80 MB。");
  }
  const textFallbackPath = await getRepairedMarkdownFallback(paperId, signal);
  signal?.throwIfAborted();

  return [
    {
      attachment: {
        id: crypto.randomUUID(),
        fileName: paper.fileName || "source.pdf",
        mimeType: "application/pdf",
        size: info.size,
        kind: "pdf",
        source: "library",
        paperId,
        pageCount: paper.pageCount,
      },
      filePath,
      textFallbackPath,
    },
    ...attachments,
  ];
}

async function getRepairedMarkdownFallback(
  paperId: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  const paper = store.getPaper(paperId);
  if (!paper) return undefined;
  const pdfPath = store.resolvePaperPath(paperId);
  if (!pdfPath) return undefined;
  const directory = resolvePaperArtifactDirectory(paperId);
  const cached = await readKnowledgeMarkdownRepairCache(
    directory,
    paperId,
    pdfPath,
    legacyKnowledgeMarkdownCacheRoot(),
    signal,
  ).catch(() => null);
  signal?.throwIfAborted();
  if (!cached) return undefined;
  await writePaperTextArtifacts(directory, paper, { repair: cached, signal });
  signal?.throwIfAborted();
  return join(directory, "full.md");
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
  const directory = resolvePaperArtifactDirectory(id);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    removePaperTextArtifacts(directory),
    removeKnowledgeMarkdownRepairCache(
      directory,
      id,
      legacyKnowledgeMarkdownCacheRoot(),
    ),
  ]);
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
    const explicitChemrxiv = isChemrxivDoi(identifier.doi);
    let doiLookup: PaperLookupResult | undefined;
    let doiError: unknown;
    try {
      doiLookup = await lookupDoiWithPdfLinks(identifier.doi);
    } catch (error) {
      doiError = error;
    }

    if (!doiLookup && explicitChemrxiv) {
      return saveImportedPaper(
        {
          title: identifier.doi,
          authors: [],
          doi: identifier.doi,
          sourceUrl: `https://chemrxiv.org/doi/full/${identifier.doi}`,
        },
        extractChemrxivPdfCandidates(identifier.doi),
        true,
      );
    }

    // Crossref 失败时，仅在用户允许预印本回退后尝试通过 DOI 定位 arXiv。
    const arxivLookup =
      !doiLookup && store.getPreprintFallbackEnabled()
        ? await lookupArxivByDoi(identifier.doi)
        : undefined;
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

    return saveImportedPaper(
      doiLookup.metadata,
      doiLookup.pdfCandidates,
      explicitChemrxiv,
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
    metadata,
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
  const directory = resolvePaperArtifactDirectory(existing.id);
  const fileName = safeZoteroPdfFileName(downloaded.fileName);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    removePaperTextArtifacts(directory),
    removeKnowledgeMarkdownRepairCache(
      directory,
      existing.id,
      legacyKnowledgeMarkdownCacheRoot(),
    ),
  ]);
  await writeFile(join(directory, "source.pdf"), downloaded.data);
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
    const result = await documentEngine.request<{
      page_count: number;
      title_guess?: string;
      authors_guess?: string[];
      journal_guess?: string;
      year_guess?: number;
      doi_guess?: string;
      chunk_count: number;
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
        statusText: "文献已就绪",
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
  metadata: PaperMetadata,
): Promise<PdfResolution> {
  console.log("[pdf] 开放获取阶段：Crossref、Europe PMC、OpenAlex、CORE");
  const downloaded = await resolvePdfCandidatesInOrder(
    [
      () => Promise.resolve(crossrefCandidates),
      () => lookupEuropePmcPdfCandidates(doi),
      () => lookupOpenAlexPdfCandidates(doi),
      () => lookupCorePdfCandidates(doi),
    ],
    downloadPdfCandidate,
  );
  if (downloaded) return { downloaded };

  if (store.getPreprintFallbackEnabled() && !isChemrxivDoi(doi)) {
    console.log("[pdf] 预印本阶段：ChemRxiv、arXiv");
    const preprint = await resolvePdfCandidatesInOrder(
      [
        () => lookupChemrxivPreprintPdfCandidates(metadata),
        () => lookupArxivPreprintPdfCandidates(doi, metadata),
      ],
      downloadPdfCandidate,
    );
    if (preprint) return { downloaded: preprint };
  }

  // 新论文默认不自动进入 Sci-Hub 链路，避免把常规来源失败误判成兜底许可。
  if (metadata.year && metadata.year > DOI_AUTO_FETCH_CUTOFF_YEAR) {
    return {};
  }

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

  // 自动解析失败后统一回到原来的浏览器人工验证流程。
  if (!scihub.challengeUrl && scihub.manualUrl) {
    const manualCandidates = await openScihubVerificationWindow(
      scihub.manualUrl,
    );
    for (const candidate of manualCandidates) {
      const downloaded = await downloadPdfCandidate(candidate);
      if (downloaded) return { downloaded };
    }
  }

  return {
    manualUrl: scihub.challengeUrl,
    scihubChallengeDetected: Boolean(scihub.challengeUrl),
  };
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

async function lookupChemrxivPreprintPdfCandidates(
  metadata: PaperMetadata,
): Promise<PdfCandidate[]> {
  if (!metadata.title || isWeakPaperTitle(metadata.title)) return [];
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query.title", metadata.title.slice(0, 500));
  url.searchParams.set("filter", "prefix:10.26434");
  url.searchParams.set("rows", "10");
  const payload = await fetchJson<{
    message?: { items?: CrossrefPreprintWork[] };
  }>(url.toString(), {
    Accept: "application/json",
    "User-Agent": "PaperXcel/0.1",
  });
  return extractMatchingChemrxivPdfCandidates(
    metadata,
    payload?.message?.items ?? [],
  );
}

async function lookupArxivPreprintPdfCandidates(
  doi: string,
  metadata: PaperMetadata,
): Promise<PdfCandidate[]> {
  const byDoi = await lookupArxivByDoi(doi);
  if (byDoi) return byDoi.pdfCandidates;
  if (!metadata.title || isWeakPaperTitle(metadata.title)) return [];

  const url = new URL("https://export.arxiv.org/api/query");
  const title = metadata.title.replace(/["\\]/g, " ").replace(/\s+/g, " ");
  url.searchParams.set("search_query", `ti:"${title.slice(0, 300)}"`);
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", "5");
  try {
    const response = await net.fetch(url.toString(), {
      headers: {
        Accept: "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
      },
    });
    if (!response.ok) return [];
    return (
      findMatchingArxivResult(
        metadata,
        parseArxivAtomEntries(await response.text()),
      )?.pdfCandidates ?? []
    );
  } catch {
    return [];
  }
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
  let manualFallbackUrl: string | undefined;
  for (const mirror of mirrors) {
    for (const pageUrl of buildScihubPageUrls(mirror, doi)) {
      manualFallbackUrl ??= pageUrl;
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
      if (candidates.length > 0) {
        return {
          candidates,
          // PDF 自动下载失败时，仍从当前 Sci-Hub 页面进入人工验证窗口。
          manualUrl: page.url,
        };
      }
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

  // 原始请求失败后直接进入浏览器人工验证，让用户完成 VPN / CAPTCHA / Cookie 流程。
  if (manualFallbackUrl) {
    console.warn(
      `[scihub] 原始页面请求未得到可解析结果，等待用户人工验证：${manualFallbackUrl}`,
    );
    return {
      candidates: [],
      manualUrl: manualFallbackUrl,
    };
  }

  return { candidates: [] };
}

async function fetchScihubPage(url: string): Promise<
  | {
      status: number;
      html: string;
      url: string;
    }
  | undefined
> {
  // Sci-Hub 保持原有链路：Electron session / Node fetch 直连，
  // 失败后交给 openScihubVerificationWindow 做人工验证。
  const visited = new Set<string>();
  let currentUrl = url;
  try {
    for (let redirectCount = 0; redirectCount < 5; redirectCount += 1) {
      if (visited.has(currentUrl)) return undefined;
      visited.add(currentUrl);
      let response: Response | undefined;
      let sessionError: unknown;
      try {
        response = await fetchScihubPageDirectWithTimeout(currentUrl);
      } catch (error) {
        sessionError = error;
      }
      if (!response) {
        try {
          response = await fetchScihubPageNodeWithTimeout(currentUrl);
        } catch (nodeError) {
          throw new Error(
            `Electron session: ${formatNetworkError(
              sessionError,
            )}; Node fetch: ${formatNetworkError(nodeError)}`,
            { cause: nodeError },
          );
        }
      }
      if (!response) return undefined;
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
  } catch (error) {
    console.warn(
      `[scihub] 原始页面请求失败：${formatNetworkError(error)}（${url}）`,
    );
    // A malformed Location header must not become the verification window URL.
  }
  return undefined;
}

async function fetchScihubPageDirectWithTimeout(
  url: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SCIHUB_DIRECT_PAGE_TIMEOUT_MS,
  );
  try {
    return await session.fromPartition(SCIHUB_SESSION_PARTITION).fetch(url, {
      redirect: "manual",
      headers: {
        "User-Agent": DEFAULT_BROWSER_USER_AGENT,
        Accept: "text/html,*/*;q=0.8",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchScihubPageNodeWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SCIHUB_DIRECT_PAGE_TIMEOUT_MS,
  );
  try {
    return await globalThis.fetch(url, {
      redirect: "manual",
      headers: {
        "User-Agent": DEFAULT_BROWSER_USER_AGENT,
        Accept: "text/html,*/*;q=0.8",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
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
  if (
    scihubVerificationPromise &&
    scihubVerificationWindow &&
    !scihubVerificationWindow.isDestroyed()
  ) {
    scihubVerificationWindow.show();
    scihubVerificationWindow.focus();
    return scihubVerificationPromise;
  }
  const scihubSession = session.fromPartition(SCIHUB_SESSION_PARTITION);

  const pending = new Promise<PdfCandidate[]>((resolve) => {
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
      scihubVerificationPromise = null;
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
          scihubLastVerifiedAt = new Date().toISOString();
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
      if (failurePageShown || settled || verificationWindow.isDestroyed()) {
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
      const description =
        error instanceof Error ? error.message : String(error);
      console.error(`[scihub] verification navigation failed: ${description}`);
      showVerificationLoadError(-1, description, startUrl);
    });
  });
  scihubVerificationPromise = pending;
  return pending;
}

function isScihubManualUrl(paper: Paper, value: string): boolean {
  return (
    /sci-?hub/i.test(paper.statusText ?? "") ||
    isScihubPageUrl(value, DEFAULT_SCIHUB_MIRRORS)
  );
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
    console.log(`[pdf] 尝试 ${candidate.source}（直接请求）：${candidate.url}`);
    const headers: Record<string, string> = {
      // Some Sci-Hub storage servers reject non-browser user agents.
      "User-Agent": DEFAULT_BROWSER_USER_AGENT,
      Accept: "application/pdf,*/*;q=0.8",
    };
    if (candidate.referer) headers.Referer = candidate.referer;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SCIHUB_PDF_TIMEOUT_MS);
    let response: Response;
    try {
      response = candidate.sessionPartition
        ? await session
            .fromPartition(candidate.sessionPartition)
            .fetch(candidate.url, {
              headers,
              signal: controller.signal,
            })
        : await globalThis.fetch(candidate.url, {
            headers,
            signal: controller.signal,
          });
    } finally {
      clearTimeout(timeout);
    }
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_AUTO_PDF_BYTES) return undefined;

    const data = Buffer.from(await response.arrayBuffer());
    if (
      data.byteLength > MAX_AUTO_PDF_BYTES ||
      !response.ok ||
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
  } catch (error) {
    console.warn(
      `[scihub] 候选下载请求失败：${formatNetworkError(error)}（${candidate.url}）`,
    );
    return undefined;
  }
}

function formatNetworkError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/\s+/g, " ").trim().slice(0, 360);
  }
  return String(error).replace(/\s+/g, " ").trim().slice(0, 360);
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

function resolvePaperArtifactDirectory(paperId: string): string {
  return paperArtifactDirectory(app.getPath("userData"), paperId);
}

function legacyKnowledgeMarkdownCacheRoot(): string {
  return join(app.getPath("userData"), "knowledge-markdown-cache");
}

async function ensurePaperMarkdownArtifact(
  paperId: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const paper = store.getPaper(paperId);
  if (!paper) throw new Error("论文不存在。");
  const pdfPath = store.resolvePaperPath(paperId);
  if (!pdfPath) throw new Error("论文 PDF 文件不存在。");

  const directory = resolvePaperArtifactDirectory(paperId);
  const cached = await readKnowledgeMarkdownRepairCache(
    directory,
    paperId,
    pdfPath,
    legacyKnowledgeMarkdownCacheRoot(),
    signal,
  );
  signal?.throwIfAborted();
  if (cached) {
    await writePaperTextArtifacts(directory, paper, { repair: cached, signal });
    signal?.throwIfAborted();
    await reindexPaperMarkdown(paperId);
    signal?.throwIfAborted();
    return join(directory, "full.md");
  }

  const markdownPath = join(directory, "full.md");
  try {
    const info = await stat(markdownPath);
    signal?.throwIfAborted();
    if (info.isFile() && info.size > 0) return markdownPath;
  } catch {
    // Generate the local Markdown below when the artifact does not exist yet.
  }
  signal?.throwIfAborted();

  const pages = await documentEngine.request<DocumentPageText[]>(
    "document_text",
    {
      paper_id: paperId,
      index_dir: join(app.getPath("userData"), "indexes"),
    },
    60_000,
  );
  signal?.throwIfAborted();
  if (!pages.length) throw new Error("尚未提取到可用的论文正文。");
  await writePaperTextArtifacts(directory, paper, { rawPages: pages, signal });
  signal?.throwIfAborted();
  return markdownPath;
}

async function synchronizeStoredPaperArtifacts(): Promise<void> {
  const papers = store.listPapers();
  const results = await Promise.allSettled(
    papers.map((paper) => synchronizePaperArtifacts(paper)),
  );
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") continue;
    const paper = papers[index];
    console.error(
      `[paper-artifacts] ${paper?.id ?? "unknown"} 启动同步失败：${
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason)
      }`,
    );
  }
}

async function synchronizeStoredPaperMarkdownIndexes(): Promise<void> {
  for (const paper of store.listPapers()) {
    if (paper.status !== "ready") continue;
    const pdfPath = store.resolvePaperPath(paper.id);
    if (!pdfPath) continue;
    const directory = resolvePaperArtifactDirectory(paper.id);
    try {
      const cached = await readKnowledgeMarkdownRepairCache(
        directory,
        paper.id,
        pdfPath,
        legacyKnowledgeMarkdownCacheRoot(),
      );
      if (!cached) continue;
      await writePaperTextArtifacts(directory, paper, { repair: cached });
      // reindex_markdown 会比较 full.md 的 SHA-256；内容未变化时直接跳过，
      // 旧 SQLite 或正文有变化时才覆盖 chunks 与 FTS。
      const result = await reindexPaperMarkdown(paper.id);
      if (result.updated) {
        console.info(
          `[paper-index] ${paper.id} rebuilt from repaired Markdown (${result.chunk_count} chunks).`,
        );
      }
    } catch (error) {
      console.error(
        `[paper-index] ${paper.id} Markdown index synchronization failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

async function synchronizePaperArtifacts(paper: Paper): Promise<void> {
  const directory = resolvePaperArtifactDirectory(paper.id);
  const sourcePath = store.resolvePaperPath(paper.id);
  if (sourcePath) {
    await ensureCanonicalPaperPdf(directory, sourcePath);
  }
  await Promise.all([
    writePaperMetadataArtifact(directory, paper),
    writePaperNoteArtifact(directory, paper, store.getPaperNote(paper.id)),
    removeLegacyPaperSummaryArtifact(directory),
  ]);
}

function queuePaperArtifactSync(paper: Paper): void {
  const previous = paperArtifactSyncs.get(paper.id) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => synchronizePaperArtifacts(paper));
  paperArtifactSyncs.set(paper.id, current);
  void current
    .catch((error) => {
      console.error(
        `[paper-artifacts] ${paper.id} 同步失败：${error instanceof Error ? error.message : String(error)}`,
      );
    })
    .finally(() => {
      if (paperArtifactSyncs.get(paper.id) === current) {
        paperArtifactSyncs.delete(paper.id);
      }
    });
}

async function runPaperMarkdownRepair(
  paperId: string,
  requestId: string,
  signal: AbortSignal,
  markdownPathOverride?: string,
  onAgentEvent?: (
    event: Omit<AgentEvent, "requestId" | "sequence" | "timestamp">,
  ) => void,
  onMarkdownPreview?: (content: string, done: boolean) => void,
): Promise<KnowledgeBaseMarkdownPreview> {
  signal.throwIfAborted();
  const sendProgress = (
    phase: KnowledgeBaseRepairProgress["phase"],
    detail: string,
  ): void => {
    if (signal.aborted || mainWindow?.webContents.isDestroyed()) return;
    mainWindow?.webContents.send("knowledge-base:progress", {
      requestId,
      phase,
      completed: 0,
      total: 1,
      paperId,
      detail,
    } satisfies KnowledgeBaseRepairProgress);
  };

  const paper = store.getPaper(paperId);
  if (!paper) throw new Error("论文不存在。");
  if (paper.status !== "ready" && !markdownPathOverride) {
    throw new Error("请等待论文解析完成后再进行文件修复。");
  }
  const canonicalPdfPath = store.resolvePaperPath(paperId);
  if (!canonicalPdfPath) throw new Error("论文 PDF 文件不存在。");

  const directory = resolvePaperArtifactDirectory(paperId);
  const streamingMarkdownPath = join(directory, "full.streaming.md");
  let lastStreamingWrite = Promise.resolve();
  const emitMarkdownPreview = (content: string, done: boolean): void => {
    if (signal.aborted) return;
    lastStreamingWrite = lastStreamingWrite.then(async () => {
      if (!signal.aborted)
        await writeFile(streamingMarkdownPath, content, "utf8");
    });
    onMarkdownPreview?.(content, done);
  };
  const markdownPath =
    markdownPathOverride ||
    (await ensurePaperMarkdownArtifact(paperId, signal));
  signal.throwIfAborted();
  onAgentEvent?.({
    type: "tool.started",
    title: "读取本地论文正文",
    tool: "document_text",
    detail: "正在读取 PDF.js 页面文本与 Markdown 工件",
    status: "running",
  });
  sendProgress("extracting", "正在准备论文全文文件与本地页面信息");
  const pages = await waitForAbort(
    documentEngine.request<DocumentPageText[]>(
      "document_text",
      {
        paper_id: paperId,
        index_dir: join(app.getPath("userData"), "indexes"),
        pdf_path: canonicalPdfPath,
      },
      60_000,
    ),
    signal,
  );
  if (!pages.length) throw new Error("尚未提取到可修复的论文正文。");
  onAgentEvent?.({
    type: "tool.completed",
    title: "本地论文正文读取完成",
    tool: "document_text",
    detail: `已读取 ${pages.length} 页`,
    status: "completed",
  });

  onAgentEvent?.({
    type: "step.started",
    stepId: "quality-repair",
    title: "从原始 PDF 重新生成 Markdown",
    detail: "必须提交原始 PDF；不使用已有 Markdown",
    status: "running",
  });
  onAgentEvent?.({
    type: "tool.started",
    title: "上传原始 PDF",
    tool: "responses_file_input",
    detail: "正在将原始 PDF 上传给支持文件输入的 Responses API",
    status: "running",
  });
  sendProgress("repairing-text", "正在提交原始 PDF，等待 Responses API 接收");
  const repairResult = await repairKnowledgePaperExport(
    store.getActiveProvider(),
    {
      paper,
      pdfPath: canonicalPdfPath,
      markdownPath,
      pages,
      citationNodes: [],
      citationEdges: [],
    },
    (phase, detail) => sendProgress(phase, detail),
    {
      signal,
      checkpoint: createPaperAgentBatchCheckpoint(directory),
      onMarkdownPreview: (content) => emitMarkdownPreview(content, false),
    },
  );
  signal.throwIfAborted();
  onAgentEvent?.({
    type: "tool.completed",
    title: "原始 PDF 已提交",
    tool: "responses_file_input",
    detail: "已收到模型响应，正在等待首个 Markdown 正文片段",
    status: "completed",
  });
  if (!repairResult.textProtocol) {
    throw new Error(repairResult.textWarnings[0] || "AI 未能完成文件修复。");
  }
  await lastStreamingWrite;
  signal.throwIfAborted();
  emitMarkdownPreview(repairResult.markdown, true);
  await lastStreamingWrite;
  signal.throwIfAborted();
  await rm(streamingMarkdownPath, { force: true });
  signal.throwIfAborted();
  onAgentEvent?.({
    type: "step.completed",
    stepId: "quality-repair",
    title: "Markdown 批次处理完成",
    detail:
      repairResult.batchCount !== undefined
        ? `共 ${repairResult.batchCount} 批，修复 ${repairResult.repairedBatchCount ?? 0} 批，保留 ${repairResult.preservedBatchCount ?? 0} 批`
        : `已处理 ${repairResult.pageCount} 页`,
    status: "completed",
    metadata: {
      batchCount: repairResult.batchCount,
      repairedBatchCount: repairResult.repairedBatchCount,
      preservedBatchCount: repairResult.preservedBatchCount,
      detectedIssues: repairResult.detectedIssues,
    },
  });

  onAgentEvent?.({
    type: "tool.started",
    title: "写入修复缓存",
    tool: "write_markdown_cache",
    status: "running",
  });
  const cached = await writeKnowledgeMarkdownRepairCache(
    directory,
    paperId,
    canonicalPdfPath,
    {
      markdown: repairResult.markdown,
      pageCount: repairResult.pageCount,
      model: repairResult.model,
      protocol: repairResult.textProtocol,
      warnings: repairResult.textWarnings,
      repairReport:
        repairResult.batchCount !== undefined
          ? {
              batchCount: repairResult.batchCount,
              repairedBatchCount: repairResult.repairedBatchCount ?? 0,
              preservedBatchCount: repairResult.preservedBatchCount ?? 0,
              detectedIssues: repairResult.detectedIssues ?? [],
            }
          : undefined,
    },
    signal,
  );
  signal.throwIfAborted();
  await writePaperTextArtifacts(directory, paper, {
    rawPages: pages,
    repair: cached,
    signal,
  });
  signal.throwIfAborted();
  onAgentEvent?.({
    type: "tool.completed",
    title: "修复缓存写入完成",
    tool: "write_markdown_cache",
    status: "completed",
  });
  onAgentEvent?.({
    type: "verification.started",
    stepId: "reindex",
    title: "验证全文索引",
    detail: "正在用修复后的 Markdown 重建本地检索索引",
    status: "running",
  });
  sendProgress("writing", "正在重建全文检索索引");
  await waitForAbort(reindexPaperMarkdown(paperId), signal);
  onAgentEvent?.({
    type: "verification.completed",
    stepId: "reindex",
    title: "全文索引验证完成",
    detail: "修复后的正文已可用于本地检索和文献问答",
    status: "completed",
  });
  sendProgress("complete", "文件修复与缓存写入完成");
  return {
    paperId,
    markdown: cached.markdown,
    pageCount: cached.pageCount,
    generatedAt: new Date().toISOString(),
    aiRepaired: true,
    model: cached.model,
    protocol: cached.protocol,
    repairedAt: cached.repairedAt,
    warnings: cached.warnings,
    repairReport: cached.repairReport,
    comparison: compareMarkdownVersions(
      buildPaperFullTextMarkdown(paper, pages),
      cached.markdown,
    ),
  };
}

function reindexPaperMarkdown(paperId: string): Promise<MarkdownReindexResult> {
  // 同一篇论文可能被预览、导出和启动同步同时触发。Map 将并发请求
  // 合并为同一个 Promise，避免对同一个 SQLite 重复写入。
  const existing = paperMarkdownIndexSyncs.get(paperId);
  if (existing) return existing;
  const task = documentEngine.request<MarkdownReindexResult>(
    "reindex_markdown",
    {
      paper_id: paperId,
      markdown_path: join(resolvePaperArtifactDirectory(paperId), "full.md"),
      index_dir: join(app.getPath("userData"), "indexes"),
    },
    900_000,
  );
  paperMarkdownIndexSyncs.set(paperId, task);
  const clearTask = (): void => {
    if (paperMarkdownIndexSyncs.get(paperId) === task) {
      paperMarkdownIndexSyncs.delete(paperId);
    }
  };
  void task.then(clearTask, clearTask);
  return task;
}

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException("Request aborted", "AbortError"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const handleAbort = (): void => {
      reject(
        signal.reason ?? new DOMException("Request aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", handleAbort);
    });
  });
}

function emitPaper(paper: Paper): void {
  queuePaperArtifactSync(paper);
  mainWindow?.webContents.send("paper:updated", paper);
}
