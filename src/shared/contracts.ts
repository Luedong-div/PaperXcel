export type PaperStatus =
  | "needs_file"
  | "queued"
  | "processing"
  | "ready"
  | "error";

export type ProviderProtocol = "auto" | "responses" | "chat-completions";
export type TranslationLanguage = "en" | "zh";
export type ModelReasoningEffort =
  | "default"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface Paper {
  id: string;
  title: string;
  authors: string[];
  journal?: string;
  year?: number;
  doi?: string;
  arxivId?: string;
  arxivVersion?: number;
  abstract?: string;
  sourceUrl?: string;
  manualPdfUrl?: string;
  zoteroItemKey?: string;
  zoteroLibraryId?: string;
  fileName?: string;
  fileSize?: number;
  pageCount?: number;
  status: PaperStatus;
  progress: number;
  statusText?: string;
  error?: string;
  starred: boolean;
  archived?: boolean;
  folderId?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface LibraryFolder {
  id: string;
  name: string;
  parentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLibraryFolderInput {
  name: string;
  parentId?: string;
}

export interface LibraryFolderRemovalResult {
  folders: LibraryFolder[];
  papers: Paper[];
}

export interface ProviderProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  protocol: ProviderProtocol;
  hasApiKey: boolean;
  isActive: boolean;
}

export interface ProviderProfileInput {
  id?: string;
  name: string;
  baseUrl: string;
  model: string;
  protocol: ProviderProtocol;
  apiKey?: string;
}

export interface ProviderModel {
  id: string;
  ownedBy?: string;
}

export interface TranslationConfig {
  hasAppId: boolean;
  hasSecretKey: boolean;
}

export interface TranslationConfigInput {
  appId?: string;
  secretKey?: string;
}

export interface TranslationInput {
  text: string;
}

export interface TranslationResult {
  source: TranslationLanguage;
  target: TranslationLanguage;
  sourceText: string;
  translatedText: string;
}

export interface TranslationTestResult {
  ok: boolean;
  detail: string;
}

export interface Citation {
  page: number;
  chunkId?: string;
  excerpt?: string;
}

export interface ReferencedSnippet {
  text: string;
  page: number;
  imageAssetId?: string;
  /** Legacy in-store format. New messages must use imageAssetId. */
  imageDataUrl?: string;
  imageOnly?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  prompt?: string;
  selectedText?: string;
  selectedPage?: number;
  selectedSnippets?: ReferencedSnippet[];
  citations?: Citation[];
  createdAt: string;
}

export interface PaperNote {
  paperId: string;
  content: string;
  updatedAt: string;
}

export interface AskPaperInput {
  requestId?: string;
  paperId: string;
  question: string;
  currentPage?: number;
  selectedText?: string;
  selectedPage?: number;
  selectedSnippets?: ReferencedSnippet[];
  reasoningEffort?: ModelReasoningEffort;
  messages: ChatMessage[];
}

export interface AskPaperResult {
  message: ChatMessage;
  protocol: Exclude<ProviderProtocol, "auto">;
  model: string;
}

export interface AskPaperCancelledResult {
  cancelled: true;
}

export type AskPaperResponse = AskPaperResult | AskPaperCancelledResult;

export interface GeneratePaperNoteResult {
  note: PaperNote;
  protocol: Exclude<ProviderProtocol, "auto">;
  model: string;
}

export interface ComparisonCitation {
  paperId: string;
  paperLabel: string;
  page: number;
  chunkId?: string;
  excerpt?: string;
}

export interface ComparisonReport {
  id: string;
  paperIds: string[];
  question: string;
  content: string;
  citations: ComparisonCitation[];
  protocol: Exclude<ProviderProtocol, "auto">;
  model: string;
  createdAt: string;
}

export interface ComparePapersInput {
  paperIds: string[];
  question: string;
}

export interface LibrarySearchInput {
  query: string;
  limit?: number;
}

export interface LibrarySearchHit {
  paperId: string;
  chunkId: string;
  page: number;
  text: string;
  score: number;
}

export type PaperIdentifier =
  | { kind: "doi"; doi: string }
  | { kind: "arxiv"; arxivId: string; version?: number };

export interface PaperMetadata {
  title: string;
  authors: string[];
  journal?: string;
  year?: number;
  doi?: string;
  arxivId?: string;
  arxivVersion?: number;
  abstract?: string;
  sourceUrl?: string;
}

export interface OpenAlexConfig {
  hasApiKey: boolean;
}

export interface OpenAlexConfigInput {
  apiKey?: string;
}

export interface OpenAlexTestResult {
  ok: boolean;
  detail: string;
}

export type CitationGraphNodeKind = "library" | "external";

export interface CitationGraphNode {
  id: string;
  kind: CitationGraphNodeKind;
  paperId?: string;
  openAlexId?: string;
  doi?: string;
  title: string;
  authors: string[];
  journal?: string;
  year?: number;
  abstract?: string;
  citedByCount: number;
  referencedByLibrary: boolean;
  citesLibrary: boolean;
  sourceUrl?: string;
}

export interface CitationGraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface CitationGraphSnapshot {
  nodes: CitationGraphNode[];
  edges: CitationGraphEdge[];
  updatedAt?: string;
  errors: string[];
}

export interface CitationGraphRefreshResult {
  snapshot: CitationGraphSnapshot;
  updatedPapers: number;
  skippedPapers: number;
  failedPapers: number;
}

export interface WorkerStatus {
  available: boolean;
  node?: string;
  pdfjs: boolean;
  semanticSearch: boolean;
  detail?: string;
}

export interface ImportPdfInput {
  mergeIntoId?: string;
  folderId?: string;
}

export type ZoteroMode = "local" | "web";
export type ZoteroLibraryType = "user" | "group";

export interface ZoteroConfig {
  mode: ZoteroMode;
  libraryType: ZoteroLibraryType;
  libraryId: string;
  collection: string;
  dataDir: string;
  hasApiKey: boolean;
}

export interface ZoteroConfigInput {
  mode: ZoteroMode;
  libraryType: ZoteroLibraryType;
  libraryId: string;
  collection: string;
  dataDir: string;
  apiKey?: string;
}

export interface ZoteroTestResult {
  ok: boolean;
  detail: string;
  itemCount?: number;
}

export interface ZoteroPullResult {
  imported: Paper[];
  skipped: number;
  withoutPdf: number;
  failed: number;
  detail: string;
}

export interface PaperXcelApi {
  papers: {
    list: () => Promise<Paper[]>;
    importPdf: (input?: ImportPdfInput) => Promise<Paper | null>;
    importDroppedPdf: (file: File, input?: ImportPdfInput) => Promise<Paper>;
    addFromIdentifier: (input: string) => Promise<Paper>;
    remove: (paperId: string) => Promise<void>;
    reorder: (paperIds: string[]) => Promise<Paper[]>;
    toggleStar: (paperId: string) => Promise<Paper>;
    setArchived: (paperId: string, archived: boolean) => Promise<Paper>;
    moveToFolder: (paperId: string, folderId?: string) => Promise<Paper>;
    reprocess: (paperId: string) => Promise<Paper>;
    fileUrl: (paperId: string) => Promise<string | null>;
    openSource: (paperId: string) => Promise<void>;
    openManualPdfPage: (paperId: string) => Promise<void>;
    showInFolder: (paperId: string) => Promise<void>;
  };
  folders: {
    list: () => Promise<LibraryFolder[]>;
    create: (input: CreateLibraryFolderInput) => Promise<LibraryFolder>;
    rename: (folderId: string, name: string) => Promise<LibraryFolder>;
    remove: (folderId: string) => Promise<LibraryFolderRemovalResult>;
  };
  providers: {
    list: () => Promise<ProviderProfile[]>;
    save: (profile: ProviderProfileInput) => Promise<ProviderProfile>;
    remove: (providerId: string) => Promise<void>;
    setActive: (providerId: string) => Promise<void>;
    test: (
      profile: ProviderProfileInput,
    ) => Promise<{ ok: boolean; detail: string }>;
    models: (profile: ProviderProfileInput) => Promise<ProviderModel[]>;
  };
  chat: {
    list: (paperId: string) => Promise<ChatMessage[]>;
    append: (paperId: string, message: ChatMessage) => Promise<ChatMessage[]>;
    clear: (paperId: string) => Promise<void>;
    replace: (
      paperId: string,
      messages: ChatMessage[],
    ) => Promise<ChatMessage[]>;
    ask: (input: AskPaperInput) => Promise<AskPaperResponse>;
    cancel: (requestId: string) => Promise<boolean>;
  };
  selectionImages: {
    save: (dataUrl: string) => Promise<{ id: string; url: string }>;
    url: (id: string) => string;
  };
  translation: {
    getConfig: () => Promise<TranslationConfig>;
    saveConfig: (input: TranslationConfigInput) => Promise<TranslationConfig>;
    test: (input: TranslationConfigInput) => Promise<TranslationTestResult>;
    translate: (input: TranslationInput) => Promise<TranslationResult>;
  };
  notes: {
    get: (paperId: string) => Promise<PaperNote | null>;
    save: (paperId: string, content: string) => Promise<PaperNote>;
    generate: (paperId: string) => Promise<GeneratePaperNoteResult>;
    exportMarkdown: (paperId: string) => Promise<boolean>;
  };
  comparisons: {
    list: () => Promise<ComparisonReport[]>;
    generate: (input: ComparePapersInput) => Promise<ComparisonReport>;
    remove: (reportId: string) => Promise<void>;
    exportMarkdown: (reportId: string) => Promise<boolean>;
  };
  search: {
    library: (input: LibrarySearchInput) => Promise<LibrarySearchHit[]>;
  };
  settings: {
    getScihubEnabled: () => Promise<boolean>;
    setScihubEnabled: (enabled: boolean) => Promise<boolean>;
  };
  openAlex: {
    getConfig: () => Promise<OpenAlexConfig>;
    saveConfig: (config: OpenAlexConfigInput) => Promise<OpenAlexConfig>;
    test: (config: OpenAlexConfigInput) => Promise<OpenAlexTestResult>;
  };
  citationGraph: {
    get: (paperIds?: string[]) => Promise<CitationGraphSnapshot>;
    refresh: (
      force?: boolean,
      paperIds?: string[],
    ) => Promise<CitationGraphRefreshResult>;
  };
  zotero: {
    getConfig: () => Promise<ZoteroConfig>;
    saveConfig: (config: ZoteroConfigInput) => Promise<ZoteroConfig>;
    chooseDataDir: () => Promise<string | null>;
    test: (config: ZoteroConfigInput) => Promise<ZoteroTestResult>;
    pull: (config: ZoteroConfigInput) => Promise<ZoteroPullResult>;
  };
  worker: {
    status: () => Promise<WorkerStatus>;
  };
  clipboard: {
    writeText: (text: string) => Promise<void>;
  };
  events: {
    onPaperUpdated: (listener: (paper: Paper) => void) => () => void;
  };
}
