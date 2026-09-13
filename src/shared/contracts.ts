import type {
  PaperNoteStream,
  PaperTextDraftState,
  PaperTextUpdate,
} from "./paperText";
import type {
  CitationAnalysisInput,
  CitationAnalysisResult,
} from "./citationAnalysisAgent";
export type { PaperNoteStream } from "./paperText";
import type {
  DiscoveryAgentInput,
  ResearchConversation,
  ResearchConversationSummary,
  ResearchKind,
  ResearchRunResult,
} from "./researchConversation";

export type PaperStatus =
  | "needs_file"
  | "queued"
  | "processing"
  | "ready"
  | "error";

export type ProviderProtocol = "auto" | "responses" | "chat-completions";
export type TranslationLanguage = "en" | "zh";
export type ModelReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

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

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export type ChatAttachmentKind =
  | "pdf"
  | "image"
  | "text"
  | "document"
  | "other";

export type ChatAttachmentSource = "uploaded" | "library";
export type ChatTask = "qa" | "compact" | "repair-markdown";

export interface ChatAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  kind: ChatAttachmentKind;
  source: ChatAttachmentSource;
  paperId?: string;
  pageCount?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Missing on legacy messages, which are treated as completed. */
  status?: "complete" | "cancelled" | "error";
  error?: string;
  /** Whether this response included provider-reported reasoning text or tokens. */
  reasoningObserved?: boolean;
  reasoningContent?: string;
  processingDurationMs?: number;
  prompt?: string;
  task?: ChatTask;
  attachments?: ChatAttachment[];
  selectedText?: string;
  selectedPage?: number;
  selectedSnippets?: ReferencedSnippet[];
  citations?: Citation[];
  citationVerification?: CitationVerification;
  agentTrace?: AgentTraceEvent[];
  tokenUsage?: TokenUsage;
  contextCheckpoint?: string;
  contextUsage?: import("./assistantContext").AssistantContextUsage;
  createdAt: string;
}

export interface PaperNote {
  paperId: string;
  content: string;
  updatedAt: string;
  generationStatus?: "complete" | "interrupted" | "error";
}

export interface AskPaperInput {
  requestId?: string;
  paperId: string;
  question: string;
  currentPage?: number;
  selectedText?: string;
  selectedPage?: number;
  selectedSnippets?: ReferencedSnippet[];
  task?: ChatTask;
  attachments?: ChatAttachment[];
  reasoningEffort?: ModelReasoningEffort;
  messages: ChatMessage[];
}

export interface AskPaperResult {
  message: ChatMessage;
  protocol: Exclude<ProviderProtocol, "auto">;
  model: string;
  markdownPreview?: KnowledgeBaseMarkdownPreview;
}

export interface AskPaperCancelledResult {
  cancelled: true;
  /** Last accepted text, including any IPC batch still pending at cancellation. */
  answerContent?: string;
}

export type AskPaperResponse = AskPaperResult | AskPaperCancelledResult;

export type ChatProgressPhase =
  | "preparing"
  | "searching"
  | "waiting"
  | "thinking"
  | "answering";

export interface ChatProgress {
  requestId: string;
  paperId?: string;
  /** Monotonic within a request; snapshots (including "") replace content. */
  sequence?: number;
  phase: ChatProgressPhase;
  detail: string;
  /** Evidence from provider events, never inferred from elapsed time or effort settings. */
  reasoningObserved?: boolean;
  reasoningContent?: string;
  reasoningDelta?: string;
  answerContent?: string;
  answerDelta?: string;
  contextUsage?: import("./assistantContext").AssistantContextUsage;
}

export type AgentEventType =
  | "run.started"
  | "assistant.message"
  | "plan.created"
  | "step.started"
  | "step.completed"
  | "tool.started"
  | "tool.completed"
  | "progress.updated"
  | "content.delta"
  | "content.snapshot"
  | "verification.started"
  | "verification.completed"
  | "run.completed"
  | "run.cancelled"
  | "run.failed";

export interface AgentEvent {
  requestId: string;
  sequence: number;
  timestamp: string;
  type: AgentEventType;
  title: string;
  detail?: string;
  stepId?: string;
  tool?: string;
  status?: "running" | "completed" | "failed";
  delta?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentTraceEvent {
  type: AgentEventType;
  title: string;
  detail?: string;
  stepId?: string;
  tool?: string;
  status?: "running" | "completed" | "failed";
  metadata?: Record<string, unknown>;
}

export interface GeneratePaperNoteResult {
  note: PaperNote;
  protocol: Exclude<ProviderProtocol, "auto">;
  model: string;
  source: "pdf" | "full.md";
  warning?: string;
}

export interface GeneratePaperNoteCancelled {
  cancelled: true;
  note?: PaperNote;
}

export interface LibraryReview {
  id: string;
  focus: string;
  content: string;
  paperIds: string[];
  protocol: Exclude<ProviderProtocol, "auto">;
  model: string;
  createdAt: string;
}

export interface GenerateLibraryReviewInput {
  focus?: string;
  requestId?: string;
}

export interface GenerateLibraryReviewCancelled {
  cancelled: true;
}

export interface KnowledgeBaseExportResult {
  path: string;
  paperCount: number;
  noteCount: number;
  reviewCount: number;
  aiRepair: boolean;
  repairedPaperCount: number;
  repairedCitationNodeCount: number;
  repairIssues: KnowledgeBaseRepairIssue[];
  validation: KnowledgeBaseExportValidation;
}

export interface KnowledgeBaseExportCancelled {
  cancelled: true;
}

export interface KnowledgeBaseExportValidation {
  checkedFiles: number;
  warnings: string[];
}

export interface KnowledgeBaseMarkdownPreview {
  paperId: string;
  markdown: string;
  pageCount: number;
  generatedAt: string;
  aiRepaired: boolean;
  hasAiRepairedVersion?: boolean;
  draft?: PaperTextDraftState;
  model?: string;
  protocol?: Exclude<ProviderProtocol, "auto">;
  repairedAt?: string;
  warnings?: string[];
  repairReport?: {
    batchCount: number;
    repairedBatchCount: number;
    preservedBatchCount: number;
    detectedIssues: string[];
  };
}

export interface KnowledgeBaseMarkdownRepairCancelled {
  cancelled: true;
  preview?: KnowledgeBaseMarkdownPreview;
}

export type KnowledgeBaseMarkdownRepairResult =
  | KnowledgeBaseMarkdownPreview
  | KnowledgeBaseMarkdownRepairCancelled;

export interface KnowledgeBaseExportOptions {
  aiRepair?: boolean;
  paperIds?: string[];
  requestId?: string;
}

export interface KnowledgeBaseRepairIssue {
  paperId: string;
  paperTitle: string;
  message: string;
}

export type KnowledgeBaseRepairPhase =
  | "preparing"
  | "extracting"
  | "repairing-text"
  | "repairing-citations"
  | "writing"
  | "finalizing"
  | "cancelled"
  | "complete";

export interface KnowledgeBaseRepairProgress {
  requestId?: string;
  phase: KnowledgeBaseRepairPhase;
  completed: number;
  total: number;
  paperId?: string;
  paperTitle?: string;
  detail: string;
}

export interface KnowledgeBaseMarkdownStream extends Partial<PaperTextUpdate> {
  requestId: string;
  paperId: string;
  content: string;
  characters: number;
  done: boolean;
  generatedAt: string;
  previewOnly?: boolean;
  sequence?: number;
  status?: "complete" | "interrupted" | "error";
}

export interface DocumentPageText {
  page: number;
  text: string;
}

export interface LibraryCitation {
  paperId: string;
  paperLabel: string;
  page: number;
  chunkId?: string;
  excerpt?: string;
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

export interface LibraryAskHistoryMessage {
  role: "user" | "assistant";
  content: string;
  contextCheckpoint?: string;
  citations?: LibraryCitation[];
}

export interface LibraryAskInput {
  requestId?: string;
  query: string;
  reasoningEffort?: ModelReasoningEffort;
  selectedHits?: LibrarySearchHit[];
  history?: LibraryAskHistoryMessage[];
}

export interface LibraryAskResult {
  content: string;
  citations: LibraryCitation[];
  citationVerification?: CitationVerification;
  protocol: Exclude<ProviderProtocol, "auto">;
  model: string;
  contextCheckpoint?: string;
  contextUsage?: import("./assistantContext").AssistantContextUsage;
  tokenUsage?: TokenUsage;
  cancelled?: boolean;
}

export interface CitationVerification {
  status: "verified" | "unverified" | "not-applicable";
  detail: string;
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
export type CitationGraphDirection = "root" | "references" | "citing" | "both";
export type CitationGraphRelation = "reference" | "citing";
export type CitationMetadataSource =
  | "library"
  | "pdf"
  | "crossref"
  | "openalex"
  | "europe-pmc"
  | "arxiv"
  | "google-scholar"
  | "ai-assisted";
export type CitationMatchStatus =
  | "verified"
  | "probable"
  | "ambiguous"
  | "unresolved";
export type CitationTextQuality = "clean" | "degraded";

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
  keywords?: string[];
  volume?: string;
  issue?: string;
  pages?: string;
  issn?: string[];
  citedByCount?: number;
  referencedByLibrary: boolean;
  citesLibrary: boolean;
  depth?: 0 | 1 | 2;
  direction?: CitationGraphDirection;
  parentIds?: string[];
  sourceUrl?: string;
  metadataSources?: CitationMetadataSource[];
  matchStatus?: CitationMatchStatus;
  matchConfidence?: number;
  rawCitation?: string;
  textQuality?: CitationTextQuality;
}

export interface CitationGraphEdge {
  id: string;
  source: string;
  target: string;
  relation?: CitationGraphRelation;
  depth?: 1 | 2;
}

export interface CitationReferencesInput {
  nodeId?: string;
  paperId?: string;
  openAlexId?: string;
  doi?: string;
  offset?: number;
  limit?: number;
}

export interface CitationReferencesResult {
  items: CitationGraphNode[];
  total: number;
  nextOffset?: number;
  warnings: string[];
}

export interface CitationGraphSnapshot {
  nodes: CitationGraphNode[];
  edges: CitationGraphEdge[];
  updatedAt?: string;
  errors: string[];
  graphMode?: "standard" | "focused-two-hop";
  focusedPaperId?: string;
  expansion?: CitationGraphExpansionStats;
}

export interface CitationGraphExpansionStats {
  referenceFirstOrderCount: number;
  referenceSecondOrderCount: number;
  citingFirstOrderCount: number;
  citingSecondOrderCount: number;
  truncatedReferenceCount: number;
  truncatedCitingCount: number;
}

export interface CitationGraphExpansionResult {
  snapshot: CitationGraphSnapshot;
  paperId: string;
  cached: boolean;
}

export interface CitationGraphRefreshResult {
  snapshot: CitationGraphSnapshot;
  updatedPapers: number;
  skippedPapers: number;
  failedPapers: number;
}

export type CitationDiscoveryReason =
  | "topic-match"
  | "cites-library"
  | "shared-references";

export type CitationContentMatchPriority = "low" | "standard" | "high";
export type CitationDiscoveryMode = "contextual" | "pure-search";
export type CitationSearchSource = "openalex" | "crossref" | "europe-pmc";
export type CitationSearchSort = "relevance" | "newest" | "citations";

export interface CitationDiscoveryFilters {
  yearFrom?: number;
  yearTo?: number;
  sort?: CitationSearchSort;
  sources?: CitationSearchSource[];
}

export interface CitationDiscoveryInput {
  paperIds?: string[];
  query?: string;
  limit?: number;
  mode?: CitationDiscoveryMode;
  requestId?: string;
  cursor?: string;
  filters?: CitationDiscoveryFilters;
}

export interface CitationDiscoveryCandidate {
  aiRecommendation?: {
    label: string;
    reason: string;
    evidence: Array<{
      paperId: string;
      paperTitle: string;
      pages: number[];
      connection: string;
    }>;
    caveat: string;
  };
  work: CitationGraphNode;
  score: number;
  relevanceScore: number;
  citationImpactScore: number;
  recencyScore: number;
  sharedReferenceCount: number;
  matchedPaperIds: string[];
  reasons: CitationDiscoveryReason[];
}

export interface CitationDiscoveryResult {
  candidates: CitationDiscoveryCandidate[];
  query: string;
  terms: string[];
  searchedAt: string;
  warnings: string[];
  mode?: CitationDiscoveryMode;
  originalQuery?: string;
  queries?: string[];
  cursor?: string;
  hasMore?: boolean;
  cancelled?: boolean;
  fetchedCount?: number;
  excludedCount?: number;
  sources?: Array<{
    id: CitationSearchSource;
    label: string;
    status: "pending" | "searching" | "complete" | "error";
    count: number;
    error?: string;
  }>;
}

export interface CitationDiscoveryProgress {
  requestId: string;
  sequence: number;
  result: CitationDiscoveryResult;
}

export interface ScihubSessionStatus {
  persistent: boolean;
  cookieCount: number;
  lastVerifiedAt?: string;
}

export interface CitationGraphClearResult {
  clearedWorks: number;
  clearedPapers: number;
}

export type CitationGraphExportFormat = "json";

export interface CitationGraphExportRequest {
  format: CitationGraphExportFormat;
  content: string;
}

export interface WorkerStatus {
  available: boolean;
  node?: string;
  pdfjs: boolean;
  searchMode: "fuzzy-text";
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
    attachFile: (file: File, paperId?: string) => Promise<ChatAttachment>;
    attachPaperMarkdown: (paperId: string) => Promise<ChatAttachment>;
    removeAttachment: (attachmentId: string) => Promise<boolean>;
    append: (paperId: string, message: ChatMessage) => Promise<ChatMessage[]>;
    clear: (paperId: string) => Promise<void>;
    replace: (
      paperId: string,
      messages: ChatMessage[],
    ) => Promise<ChatMessage[]>;
    ask: (input: AskPaperInput) => Promise<AskPaperResponse>;
    cancel: (requestId: string) => Promise<boolean>;
    onProgress: (listener: (progress: ChatProgress) => void) => () => void;
    onAgentEvent: (listener: (event: AgentEvent) => void) => () => void;
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
    list: () => Promise<PaperNote[]>;
    get: (paperId: string) => Promise<PaperNote | null>;
    getDraft: (paperId: string) => Promise<PaperNote | null>;
    save: (paperId: string, content: string) => Promise<PaperNote>;
    generate: (
      paperId: string,
      requestId: string,
    ) => Promise<GeneratePaperNoteResult | GeneratePaperNoteCancelled>;
    cancel: (requestId: string) => Promise<boolean>;
    onAgentEvent: (listener: (event: AgentEvent) => void) => () => void;
    onProgress: (listener: (event: PaperNoteStream) => void) => () => void;
    exportMarkdown: (paperId: string) => Promise<boolean>;
  };
  reviews: {
    list: () => Promise<LibraryReview[]>;
    generate: (
      input: GenerateLibraryReviewInput,
    ) => Promise<LibraryReview | GenerateLibraryReviewCancelled>;
    cancel: (requestId: string) => Promise<boolean>;
    onAgentEvent: (listener: (event: AgentEvent) => void) => () => void;
    remove: (reviewId: string) => Promise<void>;
    exportMarkdown: (reviewId: string) => Promise<boolean>;
  };
  knowledgeBase: {
    export: (
      options?: KnowledgeBaseExportOptions,
    ) => Promise<
      KnowledgeBaseExportResult | KnowledgeBaseExportCancelled | null
    >;
    cancel: (requestId: string) => Promise<boolean>;
    previewMarkdown: (
      paperId: string,
      version?: "ai" | "original",
    ) => Promise<KnowledgeBaseMarkdownPreview>;
    repairMarkdown: (
      paperId: string,
      requestId?: string,
      mode?: "restart" | "retry",
    ) => Promise<KnowledgeBaseMarkdownRepairResult>;
    onProgress: (
      listener: (progress: KnowledgeBaseRepairProgress) => void,
    ) => () => void;
    onAgentEvent: (listener: (event: AgentEvent) => void) => () => void;
    onMarkdownPreview: (
      listener: (event: KnowledgeBaseMarkdownStream) => void,
    ) => () => void;
  };
  search: {
    library: (input: LibrarySearchInput) => Promise<LibrarySearchHit[]>;
    askLibrary: (input: LibraryAskInput) => Promise<LibraryAskResult>;
    cancelAskLibrary: (requestId: string) => Promise<boolean>;
    onProgress: (listener: (progress: ChatProgress) => void) => () => void;
    onAgentEvent: (listener: (event: AgentEvent) => void) => () => void;
  };
  settings: {
    getScihubEnabled: () => Promise<boolean>;
    setScihubEnabled: (enabled: boolean) => Promise<boolean>;
    getScihubSessionStatus: () => Promise<ScihubSessionStatus>;
    clearScihubSession: () => Promise<ScihubSessionStatus>;
    getPreprintFallbackEnabled: () => Promise<boolean>;
    setPreprintFallbackEnabled: (enabled: boolean) => Promise<boolean>;
    getCitationContentMatchPriority: () => Promise<CitationContentMatchPriority>;
    setCitationContentMatchPriority: (
      priority: CitationContentMatchPriority,
    ) => Promise<CitationContentMatchPriority>;
  };
  openAlex: {
    getConfig: () => Promise<OpenAlexConfig>;
    saveConfig: (config: OpenAlexConfigInput) => Promise<OpenAlexConfig>;
    test: (config: OpenAlexConfigInput) => Promise<OpenAlexTestResult>;
  };
  citationGraph: {
    listResearchConversations: (
      kind: ResearchKind,
    ) => Promise<ResearchConversationSummary[]>;
    getResearchConversation: (id: string) => Promise<ResearchConversation>;
    renameResearchConversation: (
      id: string,
      title: string,
    ) => Promise<ResearchConversationSummary>;
    deleteResearchConversation: (id: string) => Promise<void>;
    deleteResearchTurn: (
      conversationId: string,
      turnId: string,
    ) => Promise<ResearchConversation>;
    discoverWithAi: (input: DiscoveryAgentInput) => Promise<ResearchRunResult>;
    cancelDiscoveryAgent: (requestId: string) => Promise<boolean>;
    onDiscoveryAgentProgress: (
      listener: (progress: ChatProgress) => void,
    ) => () => void;
    onDiscoveryAgentEvent: (
      listener: (event: AgentEvent) => void,
    ) => () => void;
    get: (paperIds?: string[]) => Promise<CitationGraphSnapshot>;
    references: (
      input: CitationReferencesInput,
    ) => Promise<CitationReferencesResult>;
    refresh: (
      force?: boolean,
      paperIds?: string[],
    ) => Promise<CitationGraphRefreshResult>;
    expand: (
      paperId: string,
      force?: boolean,
    ) => Promise<CitationGraphExpansionResult>;
    discover: (
      input: CitationDiscoveryInput,
    ) => Promise<CitationDiscoveryResult>;
    cancelDiscovery: (requestId: string) => Promise<boolean>;
    onDiscoveryProgress: (
      listener: (progress: CitationDiscoveryProgress) => void,
    ) => () => void;
    analyze: (input: CitationAnalysisInput) => Promise<CitationAnalysisResult>;
    cancelAnalysis: (requestId: string) => Promise<boolean>;
    onAnalysisProgress: (
      listener: (progress: ChatProgress) => void,
    ) => () => void;
    onAnalysisEvent: (listener: (event: AgentEvent) => void) => () => void;
    clear: () => Promise<CitationGraphClearResult>;
    export: (request: CitationGraphExportRequest) => Promise<boolean>;
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
    readText: () => Promise<string>;
  };
  events: {
    onPaperUpdated: (listener: (paper: Paper) => void) => () => void;
  };
}
