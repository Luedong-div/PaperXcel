import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AskPaperInput,
  AskPaperResponse,
  AgentEvent,
  ChatAttachment,
  ChatMessage,
  ChatProgress,
  CitationContentMatchPriority,
  CitationDiscoveryInput,
  CitationDiscoveryResult,
  CitationGraphAnalysisOptions,
  CitationGraphRefreshResult,
  CitationGraphClearResult,
  CitationGraphExpansionResult,
  CitationGraphExportRequest,
  CitationGraphSnapshot,
  CitationNetworkAnalysis,
  GeneratePaperNoteResult,
  GeneratePaperNoteCancelled,
  GenerateLibraryReviewInput,
  GenerateLibraryReviewCancelled,
  ImportPdfInput,
  KnowledgeBaseExportCancelled,
  KnowledgeBaseExportOptions,
  KnowledgeBaseExportResult,
  KnowledgeBaseMarkdownPreview,
  KnowledgeBaseMarkdownRepairResult,
  KnowledgeBaseRepairProgress,
  KnowledgeBaseMarkdownStream,
  LibraryAskInput,
  LibraryAskResult,
  LibraryReview,
  LibrarySearchHit,
  LibrarySearchInput,
  Paper,
  PaperNote,
  PaperXcelApi,
  OpenAlexConfigInput,
  OpenAlexTestResult,
  ProviderProfileInput,
  TranslationConfig,
  TranslationConfigInput,
  TranslationInput,
  ZoteroConfigInput,
  ZoteroPullResult,
  ZoteroTestResult,
} from "../shared/contracts";

const api: PaperXcelApi = {
  papers: {
    list: () => ipcRenderer.invoke("papers:list"),
    importPdf: (input?: ImportPdfInput) =>
      ipcRenderer.invoke("papers:import", input),
    importDroppedPdf: (file: File, input?: ImportPdfInput) =>
      ipcRenderer.invoke(
        "papers:import-path",
        webUtils.getPathForFile(file),
        input,
      ),
    addFromIdentifier: (input: string) =>
      ipcRenderer.invoke("papers:add-identifier", input),
    remove: (paperId: string) => ipcRenderer.invoke("papers:remove", paperId),
    reorder: (paperIds: string[]): Promise<Paper[]> =>
      ipcRenderer.invoke("papers:reorder", paperIds),
    toggleStar: (paperId: string) =>
      ipcRenderer.invoke("papers:toggle-star", paperId),
    setArchived: (paperId: string, archived: boolean) =>
      ipcRenderer.invoke("papers:set-archive", paperId, archived),
    moveToFolder: (paperId: string, folderId?: string) =>
      ipcRenderer.invoke("papers:move-folder", paperId, folderId),
    reprocess: (paperId: string) =>
      ipcRenderer.invoke("papers:reprocess", paperId),
    fileUrl: (paperId: string) =>
      ipcRenderer.invoke("papers:file-url", paperId),
    openSource: (paperId: string) =>
      ipcRenderer.invoke("papers:open-source", paperId),
    openManualPdfPage: (paperId: string) =>
      ipcRenderer.invoke("papers:open-manual-pdf-page", paperId),
    showInFolder: (paperId: string) =>
      ipcRenderer.invoke("papers:show-in-folder", paperId),
  },
  folders: {
    list: () => ipcRenderer.invoke("folders:list"),
    create: (input) => ipcRenderer.invoke("folders:create", input),
    rename: (folderId: string, name: string) =>
      ipcRenderer.invoke("folders:rename", folderId, name),
    remove: (folderId: string) =>
      ipcRenderer.invoke("folders:remove", folderId),
  },
  providers: {
    list: () => ipcRenderer.invoke("providers:list"),
    save: (profile: ProviderProfileInput) =>
      ipcRenderer.invoke("providers:save", profile),
    remove: (providerId: string) =>
      ipcRenderer.invoke("providers:remove", providerId),
    setActive: (providerId: string) =>
      ipcRenderer.invoke("providers:set-active", providerId),
    test: (profile: ProviderProfileInput) =>
      ipcRenderer.invoke("providers:test", profile),
    models: (profile: ProviderProfileInput) =>
      ipcRenderer.invoke("providers:models", profile),
  },
  chat: {
    list: (paperId: string): Promise<ChatMessage[]> =>
      ipcRenderer.invoke("chat:list", paperId),
    attachFile: async (
      file: File,
      paperId?: string,
    ): Promise<ChatAttachment> => {
      let sourcePath = "";
      try {
        sourcePath = webUtils.getPathForFile(file);
      } catch {
        // Clipboard-created File objects do not always expose a native path.
      }
      if (sourcePath) {
        return ipcRenderer.invoke(
          "chat:attach-file",
          sourcePath,
          paperId,
          file.type,
        );
      }
      const data = new Uint8Array(await file.arrayBuffer());
      return ipcRenderer.invoke(
        "chat:attach-data",
        {
          fileName: file.name || pastedFileName(file.type),
          mimeType: file.type,
          data,
        },
        paperId,
      );
    },
    attachPaperMarkdown: (paperId: string): Promise<ChatAttachment> =>
      ipcRenderer.invoke("chat:attach-paper-markdown", paperId),
    removeAttachment: (attachmentId: string): Promise<boolean> =>
      ipcRenderer.invoke("chat:remove-attachment", attachmentId),
    append: (paperId: string, message: ChatMessage): Promise<ChatMessage[]> =>
      ipcRenderer.invoke("chat:append", paperId, message),
    clear: (paperId: string): Promise<void> =>
      ipcRenderer.invoke("chat:clear", paperId),
    replace: (
      paperId: string,
      messages: ChatMessage[],
    ): Promise<ChatMessage[]> =>
      ipcRenderer.invoke("chat:replace", paperId, messages),
    ask: (input: AskPaperInput): Promise<AskPaperResponse> =>
      ipcRenderer.invoke("chat:ask", input),
    cancel: (requestId: string): Promise<boolean> =>
      ipcRenderer.invoke("chat:cancel", requestId),
    onProgress: (listener: (progress: ChatProgress) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        progress: ChatProgress,
      ): void => listener(progress);
      ipcRenderer.on("chat:progress", handler);
      return () => ipcRenderer.removeListener("chat:progress", handler);
    },
    onAgentEvent: (listener: (event: AgentEvent) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        agentEvent: AgentEvent,
      ): void => listener(agentEvent);
      ipcRenderer.on("chat:agent-event", handler);
      return () => ipcRenderer.removeListener("chat:agent-event", handler);
    },
  },
  selectionImages: {
    save: (dataUrl: string): Promise<{ id: string; url: string }> =>
      ipcRenderer.invoke("selection-images:save", dataUrl),
    url: (id: string): string =>
      `paperxcel://selection/${encodeURIComponent(id)}`,
  },
  translation: {
    getConfig: (): Promise<TranslationConfig> =>
      ipcRenderer.invoke("translation:get-config"),
    saveConfig: (input: TranslationConfigInput): Promise<TranslationConfig> =>
      ipcRenderer.invoke("translation:save-config", input),
    test: (input: TranslationConfigInput) =>
      ipcRenderer.invoke("translation:test", input),
    translate: (input: TranslationInput) =>
      ipcRenderer.invoke("translation:translate", input),
  },
  notes: {
    list: (): Promise<PaperNote[]> => ipcRenderer.invoke("notes:list"),
    get: (paperId: string): Promise<PaperNote | null> =>
      ipcRenderer.invoke("notes:get", paperId),
    save: (paperId: string, content: string): Promise<PaperNote> =>
      ipcRenderer.invoke("notes:save", paperId, content),
    generate: (
      paperId: string,
      requestId: string,
    ): Promise<GeneratePaperNoteResult | GeneratePaperNoteCancelled> =>
      ipcRenderer.invoke("notes:generate", paperId, requestId),
    cancel: (requestId: string): Promise<boolean> =>
      ipcRenderer.invoke("notes:cancel", requestId),
    onAgentEvent: (listener: (event: AgentEvent) => void) => {
      const wrapped = (
        _event: Electron.IpcRendererEvent,
        agentEvent: AgentEvent,
      ): void => listener(agentEvent);
      ipcRenderer.on("notes:agent-event", wrapped);
      return () => ipcRenderer.removeListener("notes:agent-event", wrapped);
    },
    exportMarkdown: (paperId: string): Promise<boolean> =>
      ipcRenderer.invoke("notes:export-markdown", paperId),
  },
  reviews: {
    list: (): Promise<LibraryReview[]> => ipcRenderer.invoke("reviews:list"),
    generate: (
      input: GenerateLibraryReviewInput,
    ): Promise<LibraryReview | GenerateLibraryReviewCancelled> =>
      ipcRenderer.invoke("reviews:generate", input),
    cancel: (requestId: string): Promise<boolean> =>
      ipcRenderer.invoke("reviews:cancel", requestId),
    onAgentEvent: (listener: (event: AgentEvent) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        agentEvent: AgentEvent,
      ): void => listener(agentEvent);
      ipcRenderer.on("reviews:agent-event", handler);
      return () => ipcRenderer.removeListener("reviews:agent-event", handler);
    },
    remove: (reviewId: string): Promise<void> =>
      ipcRenderer.invoke("reviews:remove", reviewId),
    exportMarkdown: (reviewId: string): Promise<boolean> =>
      ipcRenderer.invoke("reviews:export-markdown", reviewId),
  },
  knowledgeBase: {
    export: (
      options?: KnowledgeBaseExportOptions,
    ): Promise<
      KnowledgeBaseExportResult | KnowledgeBaseExportCancelled | null
    > => ipcRenderer.invoke("knowledge-base:export", options),
    cancel: (requestId: string): Promise<boolean> =>
      ipcRenderer.invoke("knowledge-base:cancel", requestId),
    previewMarkdown: (
      paperId: string,
      version?: "ai" | "original",
    ): Promise<KnowledgeBaseMarkdownPreview> =>
      ipcRenderer.invoke("knowledge-base:preview-markdown", paperId, version),
    repairMarkdown: (
      paperId: string,
      requestId?: string,
    ): Promise<KnowledgeBaseMarkdownRepairResult> =>
      ipcRenderer.invoke("knowledge-base:repair-markdown", paperId, requestId),
    onProgress: (listener: (progress: KnowledgeBaseRepairProgress) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        progress: KnowledgeBaseRepairProgress,
      ): void => listener(progress);
      ipcRenderer.on("knowledge-base:progress", handler);
      return () =>
        ipcRenderer.removeListener("knowledge-base:progress", handler);
    },
    onAgentEvent: (listener: (event: AgentEvent) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        agentEvent: AgentEvent,
      ): void => listener(agentEvent);
      ipcRenderer.on("knowledge-base:agent-event", handler);
      return () =>
        ipcRenderer.removeListener("knowledge-base:agent-event", handler);
    },
    onMarkdownPreview: (
      listener: (event: KnowledgeBaseMarkdownStream) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        streamEvent: KnowledgeBaseMarkdownStream,
      ): void => listener(streamEvent);
      ipcRenderer.on("knowledge-base:markdown-preview", handler);
      return () =>
        ipcRenderer.removeListener("knowledge-base:markdown-preview", handler);
    },
  },
  search: {
    library: (input: LibrarySearchInput): Promise<LibrarySearchHit[]> =>
      ipcRenderer.invoke("search:library", input),
    askLibrary: (input: LibraryAskInput): Promise<LibraryAskResult> =>
      ipcRenderer.invoke("search:ask-library", input),
    cancelAskLibrary: (requestId: string): Promise<boolean> =>
      ipcRenderer.invoke("search:cancel-ask-library", requestId),
    onProgress: (listener: (progress: ChatProgress) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        progress: ChatProgress,
      ): void => listener(progress);
      ipcRenderer.on("search:progress", handler);
      return () => ipcRenderer.removeListener("search:progress", handler);
    },
    onAgentEvent: (listener: (event: AgentEvent) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        agentEvent: AgentEvent,
      ): void => listener(agentEvent);
      ipcRenderer.on("search:agent-event", handler);
      return () => ipcRenderer.removeListener("search:agent-event", handler);
    },
  },
  settings: {
    getScihubEnabled: (): Promise<boolean> =>
      ipcRenderer.invoke("settings:get-scihub-enabled"),
    setScihubEnabled: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke("settings:set-scihub-enabled", enabled),
    getScihubSessionStatus: () =>
      ipcRenderer.invoke("settings:get-scihub-session-status"),
    clearScihubSession: () =>
      ipcRenderer.invoke("settings:clear-scihub-session"),
    getPreprintFallbackEnabled: (): Promise<boolean> =>
      ipcRenderer.invoke("settings:get-preprint-fallback-enabled"),
    setPreprintFallbackEnabled: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke("settings:set-preprint-fallback-enabled", enabled),
    getCitationContentMatchPriority:
      (): Promise<CitationContentMatchPriority> =>
        ipcRenderer.invoke("settings:get-citation-content-match-priority"),
    setCitationContentMatchPriority: (
      priority: CitationContentMatchPriority,
    ): Promise<CitationContentMatchPriority> =>
      ipcRenderer.invoke(
        "settings:set-citation-content-match-priority",
        priority,
      ),
  },
  openAlex: {
    getConfig: () => ipcRenderer.invoke("openalex:get-config"),
    saveConfig: (config: OpenAlexConfigInput) =>
      ipcRenderer.invoke("openalex:save-config", config),
    test: (config: OpenAlexConfigInput): Promise<OpenAlexTestResult> =>
      ipcRenderer.invoke("openalex:test", config),
  },
  citationGraph: {
    get: (paperIds?: string[]): Promise<CitationGraphSnapshot> =>
      ipcRenderer.invoke("citation-graph:get", paperIds),
    refresh: (
      force = false,
      paperIds?: string[],
    ): Promise<CitationGraphRefreshResult> =>
      ipcRenderer.invoke("citation-graph:refresh", force, paperIds),
    expand: (
      paperId: string,
      force = false,
    ): Promise<CitationGraphExpansionResult> =>
      ipcRenderer.invoke("citation-graph:expand", paperId, force),
    discover: (
      input: CitationDiscoveryInput,
    ): Promise<CitationDiscoveryResult> =>
      ipcRenderer.invoke("citation-graph:discover", input),
    analyze: (
      paperIds?: string[],
      options?: CitationGraphAnalysisOptions,
    ): Promise<CitationNetworkAnalysis> =>
      ipcRenderer.invoke("citation-graph:analyze", paperIds, options),
    openGoogleScholar: (query: string): Promise<boolean> =>
      ipcRenderer.invoke("citation-graph:open-google-scholar", query),
    searchGoogleScholar: (
      input: CitationDiscoveryInput,
    ): Promise<CitationDiscoveryResult> =>
      ipcRenderer.invoke("citation-graph:search-google-scholar", input),
    importGoogleScholarText: (
      input: CitationDiscoveryInput & { text: string },
    ): Promise<CitationDiscoveryResult> =>
      ipcRenderer.invoke("citation-graph:import-google-scholar-text", input),
    clear: (): Promise<CitationGraphClearResult> =>
      ipcRenderer.invoke("citation-graph:clear"),
    export: (request: CitationGraphExportRequest): Promise<boolean> =>
      ipcRenderer.invoke("citation-graph:export", request),
  },
  zotero: {
    getConfig: () => ipcRenderer.invoke("zotero:get-config"),
    saveConfig: (config: ZoteroConfigInput) =>
      ipcRenderer.invoke("zotero:save-config", config),
    chooseDataDir: (): Promise<string | null> =>
      ipcRenderer.invoke("zotero:choose-data-dir"),
    test: (config: ZoteroConfigInput): Promise<ZoteroTestResult> =>
      ipcRenderer.invoke("zotero:test", config),
    pull: (config: ZoteroConfigInput): Promise<ZoteroPullResult> =>
      ipcRenderer.invoke("zotero:pull", config),
  },
  worker: {
    status: () => ipcRenderer.invoke("worker:status"),
  },
  clipboard: {
    writeText: (text: string): Promise<void> =>
      ipcRenderer.invoke("clipboard:write-text", text).then(() => undefined),
    readText: (): Promise<string> => ipcRenderer.invoke("clipboard:read-text"),
  },
  events: {
    onPaperUpdated: (listener: (paper: Paper) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, paper: Paper): void =>
        listener(paper);
      ipcRenderer.on("paper:updated", handler);
      return () => ipcRenderer.removeListener("paper:updated", handler);
    },
  },
};

contextBridge.exposeInMainWorld("paperxcel", api);

function pastedFileName(mimeType: string): string {
  const extension =
    {
      "image/gif": "gif",
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "application/pdf": "pdf",
      "text/plain": "txt",
    }[mimeType] ?? "bin";
  return `pasted-${Date.now()}.${extension}`;
}
