import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  Archive,
  ArchiveRestore,
  ArrowUp,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Copy,
  Database,
  Download,
  Eraser,
  ExternalLink,
  FileSearch,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Library,
  LoaderCircle,
  MessageSquareText,
  Network,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  Quote,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Square,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import "katex/dist/katex.min.css";
import type {
  ChatAttachment,
  ChatMessage,
  ChatTask,
  KnowledgeBaseMarkdownRepairResult,
  LibrarySearchHit,
  LibraryFolder,
  ModelReasoningEffort,
  Paper,
  ProviderModel,
  ProviderProfile,
  ReferencedSnippet,
  TranslationResult,
} from "../../shared/contracts";
import { reorderIds, type PaperDropPlacement } from "../../shared/paperOrder";
import { CitationGraphWorkspace } from "./CitationGraphWorkspace";
import { DoiDialog } from "./DoiDialog";
import { GlobalSelectionMenu } from "./GlobalSelectionMenu";
import { LibrarySearchWorkspace } from "./LibrarySearchWorkspace";
import { KnowledgeWorkspace } from "./KnowledgeWorkspace";
import type { PdfTextSelection } from "./PdfViewer";
import { PaperReader } from "./PaperReader";
import { PaperNotes } from "./PaperNotes";
import { shouldIgnorePdfDragEnter, shouldIgnorePdfDragLeave } from "./pdfDrag";
import { normalizeMarkdownMath } from "./markdown";
import { formatProcessingDuration } from "./chatProgress";
import { AppSettingsDialog } from "./AppSettingsDialog";
import { SettingsDialog } from "./SettingsDialog";
import {
  TranslationPanel,
  type TranslationPanelState,
} from "./TranslationPanel";
import { detectTranslationDirection } from "../../shared/translation";

type LibraryFilter = "all" | "starred" | "archived";
type AssistantView = "chat" | "notes";
type WorkspaceView = "reader" | "search" | "knowledge" | "citation";
type AppSettingsSection =
  | "doi"
  | "parsing"
  | "zotero"
  | "openalex"
  | "translation";
type ComposerMenuSection = "model" | "reasoning";
type ResizablePanel = "library" | "assistant" | "knowledge" | "citation";
type ChatReference = ReferencedSnippet;
type ComposerReference = ChatReference & { id: string; imageDataUrl?: string };
type PaperActionMenu = { paperId: string; x: number; y: number };
type PaperDropTarget = { paperId: string; placement: PaperDropPlacement };
type FolderDialog = {
  mode: "create" | "rename";
  folder?: LibraryFolder;
  movePaperId?: string;
};
type AskOptions = {
  history?: ChatMessage[];
  task?: ChatTask;
  attachments?: ChatAttachment[];
};

const prompts: Array<{ label: string; prompt: string; task?: ChatTask }> = [
  { label: "核心结论", prompt: "概括本文的研究问题、核心方法和主要结论。" },
  {
    label: "研究设计",
    prompt:
      "梳理本文的研究对象、理论框架或研究设计、数据或材料来源、关键假设与评价指标。",
  },
  {
    label: "复现信息",
    prompt:
      "提取样本或数据、实验或计算条件、软件或仪器、关键参数、统计方法及其他可复现信息。",
  },
  { label: "局限性", prompt: "论文明确陈述或从证据可判断的局限性分别是什么？" },
];

const reasoningOptions: Array<{
  value: ModelReasoningEffort;
  label: string;
}> = [
  { value: "none", label: "不推理" },
  { value: "low", label: "轻度" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
];

const MIN_PAPER_RAIL_WIDTH = 240;
const MAX_PAPER_RAIL_WIDTH = 480;
const MIN_ASSISTANT_PANE_WIDTH = 300;
const MAX_ASSISTANT_PANE_WIDTH = 520;
const MIN_KNOWLEDGE_INDEX_WIDTH = 240;
const MAX_KNOWLEDGE_INDEX_WIDTH = 480;
const MIN_CITATION_SIDEBAR_WIDTH = 180;
const MAX_CITATION_SIDEBAR_WIDTH = 420;
const MIN_READER_PANE_WIDTH = 480;
const PAPER_RAIL_VISIBLE_STORAGE_KEY = "paperxcel:library-rail-visible";
const PAPER_RAIL_WIDTH_STORAGE_KEY = "paperxcel:library-rail-width";
const CITATION_SIDEBAR_VISIBLE_STORAGE_KEY =
  "paperxcel:citation-sidebar-visible";
const CITATION_SIDEBAR_WIDTH_STORAGE_KEY = "paperxcel:citation-sidebar-width";
const ASSISTANT_PANE_VISIBLE_STORAGE_KEY = "paperxcel:assistant-pane-visible";
const ASSISTANT_PANE_WIDTH_STORAGE_KEY = "paperxcel:assistant-pane-width";
const KNOWLEDGE_INDEX_WIDTH_STORAGE_KEY = "paperxcel:knowledge-index-width";

function getAttachmentDisplayName(attachment: ChatAttachment): string {
  if (attachment.source === "library" && attachment.fileName === "full.md") {
    return "论文全文文件";
  }
  return attachment.fileName;
}

export default function App(): React.JSX.Element {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedFolderId, setSelectedFolderId] = useState<string>();
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("reader");
  const [citationWorkspaceMounted, setCitationWorkspaceMounted] =
    useState(false);
  const [query, setQuery] = useState("");
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const [appSettingsSection, setAppSettingsSection] =
    useState<AppSettingsSection>("doi");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [doiOpen, setDoiOpen] = useState(false);
  const [provider, setProvider] = useState<ProviderProfile>();
  const [providerModels, setProviderModels] = useState<ProviderModel[]>([]);
  const [reasoningEffort, setReasoningEffort] =
    useState<ModelReasoningEffort>("medium");
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [composerMenuSection, setComposerMenuSection] =
    useState<ComposerMenuSection>();
  const [assistantView, setAssistantView] = useState<AssistantView>("chat");
  const [generatingNotePaperIds, setGeneratingNotePaperIds] = useState<
    Set<string>
  >(() => new Set());
  const [paperRailVisible, setPaperRailVisible] = useState(() =>
    readStoredBoolean(PAPER_RAIL_VISIBLE_STORAGE_KEY, true),
  );
  const [citationSidebarVisible, setCitationSidebarVisible] = useState(() =>
    readStoredBoolean(CITATION_SIDEBAR_VISIBLE_STORAGE_KEY, true),
  );
  const [citationSidebarWidth, setCitationSidebarWidth] = useState(() =>
    readStoredNumber(
      CITATION_SIDEBAR_WIDTH_STORAGE_KEY,
      214,
      MIN_CITATION_SIDEBAR_WIDTH,
      MAX_CITATION_SIDEBAR_WIDTH,
    ),
  );
  const [paperRailWidth, setPaperRailWidth] = useState(() =>
    readStoredNumber(
      PAPER_RAIL_WIDTH_STORAGE_KEY,
      window.innerWidth <= 1180 ? 286 : 324,
      MIN_PAPER_RAIL_WIDTH,
      MAX_PAPER_RAIL_WIDTH,
    ),
  );
  const [assistantPaneVisible, setAssistantPaneVisible] = useState(() =>
    readStoredBoolean(ASSISTANT_PANE_VISIBLE_STORAGE_KEY, true),
  );
  const [assistantPaneWidth, setAssistantPaneWidth] = useState(() =>
    readStoredNumber(
      ASSISTANT_PANE_WIDTH_STORAGE_KEY,
      390,
      MIN_ASSISTANT_PANE_WIDTH,
      MAX_ASSISTANT_PANE_WIDTH,
    ),
  );
  const [knowledgeIndexWidth, setKnowledgeIndexWidth] = useState(() =>
    readStoredNumber(
      KNOWLEDGE_INDEX_WIDTH_STORAGE_KEY,
      320,
      MIN_KNOWLEDGE_INDEX_WIDTH,
      MAX_KNOWLEDGE_INDEX_WIDTH,
    ),
  );
  const [resizingPanel, setResizingPanel] = useState<ResizablePanel>();
  const [translationPanel, setTranslationPanel] =
    useState<TranslationPanelState>();
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [question, setQuestion] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<string>();
  const [editingMessageText, setEditingMessageText] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState<string>();
  const [asking, setAsking] = useState(false);
  const [stoppingAsk, setStoppingAsk] = useState(false);
  const [askProgress, setAskProgress] = useState("");
  const [askReasoning, setAskReasoning] = useState("");
  const [askAnswer, setAskAnswer] = useState("");
  const [askElapsedMs, setAskElapsedMs] = useState(0);
  const [composerAttachments, setComposerAttachments] = useState<
    ChatAttachment[]
  >([]);
  const [composerTask, setComposerTask] = useState<ChatTask>("qa");
  const [uploadingAttachmentCount, setUploadingAttachmentCount] = useState(0);
  const [draggingChatFile, setDraggingChatFile] = useState(false);
  const [markdownRefreshTokens, setMarkdownRefreshTokens] = useState<
    Record<string, string>
  >({});
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedCitation, setExpandedCitation] = useState<string>();
  const [fileUrl, setFileUrl] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [librarySearchQuery, setLibrarySearchQuery] = useState("");
  const [librarySearchResults, setLibrarySearchResults] = useState<
    LibrarySearchHit[]
  >([]);
  const [librarySearching, setLibrarySearching] = useState(false);
  const [librarySearched, setLibrarySearched] = useState(false);
  const [paperReferences, setPaperReferences] = useState<ComposerReference[]>(
    [],
  );
  const [paperActionMenu, setPaperActionMenu] = useState<PaperActionMenu>();
  const [folderMoveMenuOpen, setFolderMoveMenuOpen] = useState(false);
  const [folderDialog, setFolderDialog] = useState<FolderDialog>();
  const [folderNameDraft, setFolderNameDraft] = useState("");
  const [savingFolder, setSavingFolder] = useState(false);
  const [draggedPaperId, setDraggedPaperId] = useState<string>();
  const [paperDropTarget, setPaperDropTarget] = useState<PaperDropTarget>();
  const [folderDropTargetId, setFolderDropTargetId] = useState<string>();
  const [draggingPdf, setDraggingPdf] = useState(false);
  const [importingDrop, setImportingDrop] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const appShellRef = useRef<HTMLDivElement>(null);
  const appSidebarRef = useRef<HTMLElement>(null);
  const pendingInitialChatScrollRef = useRef<string | undefined>(undefined);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const paperMenuRef = useRef<HTMLDivElement>(null);
  const composerMenuRef = useRef<HTMLDivElement>(null);
  const dragDepthRef = useRef(0);
  const chatDragDepthRef = useRef(0);
  const copyResetTimerRef = useRef<number | undefined>(undefined);
  const activeAskRequestRef = useRef<string | undefined>(undefined);
  const activeAskStartedAtRef = useRef<number | undefined>(undefined);
  const cancelledAskRequestIdsRef = useRef<Set<string>>(new Set());
  const providerRef = useRef(provider);
  const reasoningEffortRef = useRef(reasoningEffort);
  const pendingPageRef = useRef<{ paperId: string; page: number } | undefined>(
    undefined,
  );
  const panelLayoutRef = useRef({
    paperRailVisible,
    paperRailWidth,
    assistantPaneVisible,
    assistantPaneWidth,
    knowledgeIndexWidth,
    citationSidebarWidth,
  });
  providerRef.current = provider;
  reasoningEffortRef.current = reasoningEffort;

  panelLayoutRef.current = {
    paperRailVisible,
    paperRailWidth,
    assistantPaneVisible,
    assistantPaneWidth,
    knowledgeIndexWidth,
    citationSidebarWidth,
  };

  const resetPdfDragState = useCallback((): void => {
    dragDepthRef.current = 0;
    setDraggingPdf(false);
  }, []);
  const resetChatDragState = useCallback((): void => {
    chatDragDepthRef.current = 0;
    setDraggingChatFile(false);
  }, []);
  const resetTransientDragState = useCallback((): void => {
    resetPdfDragState();
    resetChatDragState();
  }, [resetChatDragState, resetPdfDragState]);

  const handleNoteGeneratingChange = useCallback(
    (paperId: string, generating: boolean): void => {
      setGeneratingNotePaperIds((current) => {
        if (current.has(paperId) === generating) return current;
        const next = new Set(current);
        if (generating) {
          next.add(paperId);
        } else {
          next.delete(paperId);
        }
        return next;
      });
    },
    [],
  );

  const closeComposerMenu = useCallback((): void => {
    setComposerMenuOpen(false);
    setComposerMenuSection(undefined);
  }, []);

  const closePaperActionMenu = useCallback((): void => {
    setPaperActionMenu(undefined);
    setFolderMoveMenuOpen(false);
  }, []);

  const selectedPaper = papers.find((paper) => paper.id === selectedId);
  const selectedFolder = folders.find(
    (folder) => folder.id === selectedFolderId,
  );
  const paperActionTarget = paperActionMenu
    ? papers.find((paper) => paper.id === paperActionMenu.paperId)
    : undefined;
  const paperMessages = selectedId ? (messages[selectedId] ?? []) : [];
  const chatHistoryLoaded = Boolean(
    selectedId && Object.prototype.hasOwnProperty.call(messages, selectedId),
  );
  const openPaperActionMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>, paper: Paper): void => {
      event.preventDefault();
      event.stopPropagation();
      const menuWidth = 232;
      const menuHeight = paper.doi ? 292 : 252;
      setSelectedId(paper.id);
      setWorkspaceView("reader");
      closeComposerMenu();
      setPaperActionMenu({
        paperId: paper.id,
        x: Math.max(
          8,
          Math.min(event.clientX, window.innerWidth - menuWidth - 8),
        ),
        y: Math.max(
          8,
          Math.min(event.clientY, window.innerHeight - menuHeight - 8),
        ),
      });
    },
    [closeComposerMenu],
  );
  const formatReferencesForMessage = useCallback(
    (references: ChatReference[]): string =>
      references
        .map((reference, index) =>
          reference.imageOnly
            ? `[${index + 1}] p.${reference.page}\n[公式或图片选区已作为图像附件发送]`
            : `[${index + 1}] p.${reference.page}\n${reference.text}`,
        )
        .join("\n\n"),
    [],
  );
  const extractPromptFromMessage = useCallback(
    (message: ChatMessage): string => {
      if (message.prompt?.trim()) {
        return message.prompt.trim();
      }
      const markerIndexes = ["\n\n选中原文（p.", "\n\n引用原文："]
        .map((marker) => message.content.indexOf(marker))
        .filter((index) => index >= 0);
      const markerIndex = markerIndexes.length
        ? Math.min(...markerIndexes)
        : -1;
      return (
        markerIndex >= 0
          ? message.content.slice(0, markerIndex)
          : message.content
      ).trim();
    },
    [],
  );
  const extractReferencesFromMessage = useCallback(
    (message: ChatMessage): ChatReference[] => {
      if (message.selectedSnippets?.length) {
        return message.selectedSnippets
          .filter(
            (snippet) =>
              snippet.text.trim() ||
              snippet.imageAssetId ||
              snippet.imageDataUrl,
          )
          .map((snippet) => ({
            text: snippet.text.trim(),
            page: snippet.page || currentPage,
            imageAssetId: snippet.imageAssetId,
            imageDataUrl: snippet.imageDataUrl,
            imageOnly: snippet.imageOnly,
          }));
      }
      if (message.selectedText?.trim()) {
        return [
          {
            text: message.selectedText.trim(),
            page: message.selectedPage ?? currentPage,
          },
        ];
      }
      const singleMatch = message.content.match(
        /\n\n选中原文（p\.(\d+)）：\n([\s\S]+)$/,
      );
      if (singleMatch) {
        return [
          {
            page: Number(singleMatch[1]),
            text: singleMatch[2].trim(),
          },
        ];
      }
      const blockMatch = message.content.match(/\n\n引用原文：\n([\s\S]+)$/);
      if (!blockMatch) return [];
      return [
        ...blockMatch[1].matchAll(
          /\[\d+\] p\.(\d+)\n([\s\S]*?)(?=\n\n\[\d+\] p\.|$)/g,
        ),
      ]
        .map((match) => ({
          page: Number(match[1]),
          text: match[2].trim(),
        }))
        .filter((reference) => reference.text);
    },
    [currentPage],
  );
  const persistConversation = useCallback(
    async (paperId: string, history: ChatMessage[]): Promise<void> => {
      await window.paperxcel.chat.replace(paperId, history);
    },
    [],
  );
  const referenceImageUrl = useCallback(
    (
      reference: Pick<ReferencedSnippet, "imageAssetId" | "imageDataUrl">,
    ): string | undefined =>
      reference.imageDataUrl ||
      (reference.imageAssetId
        ? window.paperxcel.selectionImages.url(reference.imageAssetId)
        : undefined),
    [],
  );
  const copyMessage = useCallback(
    async (message: ChatMessage): Promise<void> => {
      try {
        await window.paperxcel.clipboard.writeText(message.content);
        setCopiedMessageId(message.id);
        if (copyResetTimerRef.current) {
          window.clearTimeout(copyResetTimerRef.current);
        }
        copyResetTimerRef.current = window.setTimeout(() => {
          setCopiedMessageId((current) =>
            current === message.id ? undefined : current,
          );
        }, 1400);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      }
    },
    [],
  );
  const copyDoi = useCallback(async (doi: string): Promise<void> => {
    try {
      await window.paperxcel.clipboard.writeText(doi);
      setNotice("已复制 DOI");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, []);
  const startEditingMessage = useCallback(
    (message: ChatMessage): void => {
      if (asking || message.role !== "user") return;
      setEditingMessageId(message.id);
      setEditingMessageText(extractPromptFromMessage(message));
      setQuestion("");
      setPaperReferences(
        extractReferencesFromMessage(message).map((reference) => ({
          ...reference,
          id: crypto.randomUUID(),
        })),
      );
      window.getSelection()?.removeAllRanges();
    },
    [asking, extractPromptFromMessage, extractReferencesFromMessage],
  );
  const addPaperReference = useCallback((selection: PdfTextSelection): void => {
    const text = selection.text.replace(/\s+/g, " ").trim();
    if (!text && !selection.imageDataUrl) return;
    setPaperReferences((current) => {
      if (
        current.some(
          (reference) =>
            reference.page === selection.page &&
            (selection.imageDataUrl
              ? reference.imageDataUrl === selection.imageDataUrl
              : !reference.imageDataUrl && reference.text === text),
        )
      ) {
        return current;
      }
      return [
        ...current,
        {
          id: crypto.randomUUID(),
          page: selection.page,
          text,
          imageDataUrl: selection.imageDataUrl,
          imageOnly: selection.imageOnly,
        },
      ];
    });
    setAssistantView("chat");
    window.setTimeout(() => questionRef.current?.focus(), 0);
  }, []);
  const translateSelectedText = useCallback(
    async (value: string): Promise<void> => {
      const text = value.replace(/\s+/g, " ").trim();
      if (!text) return;
      if (text.length > 2_000) {
        setNotice("一次划词翻译不能超过 2,000 个字符。");
        return;
      }
      const direction = detectTranslationDirection(text);
      setTranslationPanel({
        sourceText: text,
        source: direction.source,
        target: direction.target,
        loading: true,
      });
      try {
        const result: TranslationResult =
          await window.paperxcel.translation.translate({ text });
        setTranslationPanel((current) =>
          current?.sourceText === text
            ? { ...current, result, loading: false }
            : current,
        );
      } catch (error) {
        setTranslationPanel((current) =>
          current?.sourceText === text
            ? {
                ...current,
                loading: false,
                error: error instanceof Error ? error.message : String(error),
              }
            : current,
        );
      }
    },
    [],
  );
  const removePaperReference = useCallback((id: string): void => {
    setPaperReferences((current) =>
      current.filter((reference) => reference.id !== id),
    );
  }, []);
  const cancelEditingMessage = useCallback((): void => {
    setEditingMessageId(undefined);
    setEditingMessageText("");
  }, []);
  const beginAskPresentation = useCallback((detail: string): void => {
    activeAskStartedAtRef.current = Date.now();
    setAskProgress(detail);
    setAskReasoning("");
    setAskAnswer("");
    setAskElapsedMs(0);
  }, []);
  const updateAskProgress = useCallback((detail: string): void => {
    setAskProgress(detail);
  }, []);
  const resetAskPresentation = useCallback((): void => {
    activeAskStartedAtRef.current = undefined;
    setAskProgress("");
    setAskReasoning("");
    setAskAnswer("");
    setAskElapsedMs(0);
  }, []);
  const stopAsking = useCallback(async (): Promise<void> => {
    const requestId = activeAskRequestRef.current;
    if (!requestId || stoppingAsk) return;
    setStoppingAsk(true);
    cancelledAskRequestIdsRef.current.add(requestId);
    activeAskRequestRef.current = undefined;
    setAsking(false);
    resetAskPresentation();
    try {
      await window.paperxcel.chat.cancel(requestId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setStoppingAsk(false);
    }
  }, [resetAskPresentation, stoppingAsk]);
  const cancelMarkdownThroughAssistant = useCallback(
    async (requestId: string): Promise<boolean> => {
      cancelledAskRequestIdsRef.current.add(requestId);
      if (activeAskRequestRef.current === requestId) {
        activeAskRequestRef.current = undefined;
        setAsking(false);
        resetAskPresentation();
      }
      try {
        return await window.paperxcel.chat.cancel(requestId);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [resetAskPresentation],
  );
  const repairMarkdownThroughAssistant = useCallback(
    async (
      paperId: string,
      requestId: string,
    ): Promise<KnowledgeBaseMarkdownRepairResult> => {
      const activeProvider = providerRef.current;
      if (!activeProvider?.hasApiKey) {
        throw new Error("请先配置可用的 AI 模型与 API Key。");
      }
      if (activeAskRequestRef.current) {
        throw new Error("文献助手正在处理其他请求，请稍后再试。");
      }

      const prompt =
        "请读取当前论文原始 PDF，将整篇论文转换并修复为完整 Markdown，保留页面、标题、段落、公式、表格与引用。PaperXcel 会校验后写回当前论文缓存。";
      let attachment: ChatAttachment | undefined;
      let userMessage: ChatMessage | undefined;
      let attachmentPersisted = false;

      activeAskRequestRef.current = requestId;
      cancelledAskRequestIdsRef.current.delete(requestId);
      setAssistantView("chat");
      setAssistantPaneVisible(true);
      setStoppingAsk(false);
      setAsking(true);
      beginAskPresentation("正在准备 PDF 全文修复");

      try {
        const baseMessages = await window.paperxcel.chat.list(paperId);
        if (cancelledAskRequestIdsRef.current.has(requestId)) {
          return { cancelled: true };
        }

        attachment = await window.paperxcel.chat.attachPaperMarkdown(paperId);
        if (cancelledAskRequestIdsRef.current.has(requestId)) {
          return { cancelled: true };
        }

        userMessage = {
          id: crypto.randomUUID(),
          role: "user",
          content: prompt,
          prompt,
          task: "repair-markdown",
          attachments: [attachment],
          createdAt: new Date().toISOString(),
        };
        const nextMessages = [...baseMessages, userMessage];
        await window.paperxcel.chat.append(paperId, userMessage);
        attachmentPersisted = true;
        setMessages((current) => ({
          ...current,
          [paperId]: nextMessages,
        }));
        updateAskProgress("正在一次性提交原始 PDF 进行全文修复");

        const result = await window.paperxcel.chat.ask({
          requestId,
          paperId,
          question: prompt,
          task: "repair-markdown",
          attachments: [attachment],
          reasoningEffort: reasoningEffortRef.current,
          messages: baseMessages,
        });
        if ("cancelled" in result) {
          return { cancelled: true };
        }
        if (cancelledAskRequestIdsRef.current.has(requestId)) {
          return { cancelled: true };
        }

        const completeMessages = [...nextMessages, result.message];
        await window.paperxcel.chat.append(paperId, result.message);
        setMessages((current) => ({
          ...current,
          [paperId]: completeMessages,
        }));
        if (!result.markdownPreview) {
          throw new Error("文献助手未返回可用的文件修复结果。");
        }
        setMarkdownRefreshTokens((current) => ({
          ...current,
          [paperId]:
            result.markdownPreview?.repairedAt ?? new Date().toISOString(),
        }));
        return result.markdownPreview;
      } catch (error) {
        if (cancelledAskRequestIdsRef.current.has(requestId)) {
          return { cancelled: true };
        }
        if (userMessage) {
          const errorMessage: ChatMessage = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: `请求失败：${
              error instanceof Error ? error.message : String(error)
            }`,
            createdAt: new Date().toISOString(),
          };
          try {
            await window.paperxcel.chat.append(paperId, errorMessage);
          } catch {
            // Preserve the original repair error for the reader.
          }
          setMessages((current) => ({
            ...current,
            [paperId]: [...(current[paperId] ?? []), errorMessage],
          }));
        }
        throw error;
      } finally {
        if (attachment && !attachmentPersisted) {
          void window.paperxcel.chat.removeAttachment(attachment.id);
        }
        cancelledAskRequestIdsRef.current.delete(requestId);
        if (activeAskRequestRef.current === requestId) {
          activeAskRequestRef.current = undefined;
          setAsking(false);
          resetAskPresentation();
        }
      }
    },
    [beginAskPresentation, resetAskPresentation, updateAskProgress],
  );
  useEffect(() => {
    cancelEditingMessage();
  }, [cancelEditingMessage, selectedId]);

  useEffect(() => {
    writeStoredBoolean(PAPER_RAIL_VISIBLE_STORAGE_KEY, paperRailVisible);
  }, [paperRailVisible]);

  useEffect(() => {
    writeStoredBoolean(
      CITATION_SIDEBAR_VISIBLE_STORAGE_KEY,
      citationSidebarVisible,
    );
  }, [citationSidebarVisible]);

  useEffect(() => {
    writeStoredNumber(PAPER_RAIL_WIDTH_STORAGE_KEY, paperRailWidth);
  }, [paperRailWidth]);

  useEffect(() => {
    writeStoredNumber(CITATION_SIDEBAR_WIDTH_STORAGE_KEY, citationSidebarWidth);
  }, [citationSidebarWidth]);

  useEffect(() => {
    writeStoredBoolean(
      ASSISTANT_PANE_VISIBLE_STORAGE_KEY,
      assistantPaneVisible,
    );
  }, [assistantPaneVisible]);

  useEffect(() => {
    writeStoredNumber(ASSISTANT_PANE_WIDTH_STORAGE_KEY, assistantPaneWidth);
  }, [assistantPaneWidth]);

  useEffect(() => {
    writeStoredNumber(KNOWLEDGE_INDEX_WIDTH_STORAGE_KEY, knowledgeIndexWidth);
  }, [knowledgeIndexWidth]);

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  const refreshProviders = useCallback(async (): Promise<void> => {
    const profiles = await window.paperxcel.providers.list();
    setProvider(profiles.find((profile) => profile.isActive));
  }, []);

  const refreshPapers = useCallback(async (): Promise<void> => {
    const next = await window.paperxcel.papers.list();
    setPapers(next);
    setSelectedId((current) => current ?? next[0]?.id);
  }, []);

  const refreshFolders = useCallback(async (): Promise<void> => {
    setFolders(await window.paperxcel.folders.list());
  }, []);

  useEffect(() => {
    void Promise.all([refreshPapers(), refreshProviders(), refreshFolders()]);
    return window.paperxcel.events.onPaperUpdated((paper) => {
      setPapers((current) => {
        const exists = current.some((item) => item.id === paper.id);
        const next = exists
          ? current.map((item) => (item.id === paper.id ? paper : item))
          : [paper, ...current];
        return next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      });
    });
  }, [refreshFolders, refreshPapers, refreshProviders]);

  useEffect(() => {
    setSelectedFolderId((current) =>
      current && !folders.some((folder) => folder.id === current)
        ? undefined
        : current,
    );
  }, [folders]);

  useEffect(() => {
    if (!provider?.hasApiKey) {
      setProviderModels([]);
      return;
    }
    let disposed = false;
    void window.paperxcel.providers
      .models({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        model: provider.model,
        protocol: provider.protocol,
      })
      .then((models) => {
        if (!disposed) setProviderModels(models);
      })
      .catch(() => {
        if (!disposed) setProviderModels([]);
      });
    return () => {
      disposed = true;
    };
  }, [provider]);

  useEffect(() => {
    if (!paperActionMenu) return;
    const closeMenu = (event: PointerEvent): void => {
      if (!paperMenuRef.current?.contains(event.target as Node)) {
        closePaperActionMenu();
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closePaperActionMenu();
    };
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [closePaperActionMenu, paperActionMenu]);

  useEffect(() => {
    if (!composerMenuOpen) return;
    const closeMenu = (event: PointerEvent): void => {
      if (!composerMenuRef.current?.contains(event.target as Node)) {
        closeComposerMenu();
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeComposerMenu();
    };
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [closeComposerMenu, composerMenuOpen]);

  useEffect(() => {
    const handleWindowDragLeave = (event: DragEvent): void => {
      const container = document.documentElement;
      if (
        shouldIgnorePdfDragLeave(
          container,
          event.relatedTarget,
          event,
          container.getBoundingClientRect(),
        )
      ) {
        return;
      }
      resetTransientDragState();
    };
    const resetWindowDragState = (): void => resetTransientDragState();
    const handleVisibilityChange = (): void => {
      if (document.hidden) resetTransientDragState();
    };
    window.addEventListener("dragleave", handleWindowDragLeave);
    window.addEventListener("drop", resetWindowDragState);
    window.addEventListener("dragend", resetWindowDragState);
    window.addEventListener("blur", resetWindowDragState);
    window.addEventListener("focus", resetWindowDragState);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("dragleave", handleWindowDragLeave);
      window.removeEventListener("drop", resetWindowDragState);
      window.removeEventListener("dragend", resetWindowDragState);
      window.removeEventListener("blur", resetWindowDragState);
      window.removeEventListener("focus", resetWindowDragState);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [resetTransientDragState]);

  useEffect(() => {
    if (workspaceView === "reader" && paperRailVisible) return;
    resetPdfDragState();
  }, [paperRailVisible, resetPdfDragState, workspaceView]);

  useEffect(() => {
    if (!resizingPanel) return;
    const updateSize = (event: PointerEvent): void => {
      const shellRect = appShellRef.current?.getBoundingClientRect();
      if (!shellRect) return;
      const sidebarWidth =
        appSidebarRef.current?.getBoundingClientRect().width ?? 64;
      const layout = panelLayoutRef.current;
      if (resizingPanel === "library") {
        const assistantWidth = layout.assistantPaneVisible
          ? layout.assistantPaneWidth + 8
          : 0;
        const maxWidth = Math.min(
          MAX_PAPER_RAIL_WIDTH,
          shellRect.width -
            sidebarWidth -
            assistantWidth -
            MIN_READER_PANE_WIDTH -
            8,
        );
        setPaperRailWidth(
          clampPanelWidth(
            event.clientX - shellRect.left - sidebarWidth,
            MIN_PAPER_RAIL_WIDTH,
            maxWidth,
          ),
        );
        return;
      }

      if (resizingPanel === "knowledge") {
        const maxWidth = Math.min(
          MAX_KNOWLEDGE_INDEX_WIDTH,
          shellRect.width - sidebarWidth - MIN_READER_PANE_WIDTH - 8,
        );
        setKnowledgeIndexWidth(
          clampPanelWidth(
            event.clientX - shellRect.left - sidebarWidth,
            MIN_KNOWLEDGE_INDEX_WIDTH,
            maxWidth,
          ),
        );
        return;
      }

      if (resizingPanel === "citation") {
        const maxWidth = Math.min(
          MAX_CITATION_SIDEBAR_WIDTH,
          shellRect.width - sidebarWidth - MIN_READER_PANE_WIDTH - 8,
        );
        setCitationSidebarWidth(
          clampPanelWidth(
            event.clientX - shellRect.left - sidebarWidth,
            MIN_CITATION_SIDEBAR_WIDTH,
            maxWidth,
          ),
        );
        return;
      }

      const libraryWidth = layout.paperRailVisible
        ? layout.paperRailWidth + 8
        : 0;
      const maxWidth = Math.min(
        MAX_ASSISTANT_PANE_WIDTH,
        shellRect.width -
          sidebarWidth -
          libraryWidth -
          MIN_READER_PANE_WIDTH -
          8,
      );
      setAssistantPaneWidth(
        clampPanelWidth(
          shellRect.right - event.clientX,
          MIN_ASSISTANT_PANE_WIDTH,
          maxWidth,
        ),
      );
    };
    const finishResize = (): void => setResizingPanel(undefined);

    document.addEventListener("pointermove", updateSize);
    document.addEventListener("pointerup", finishResize);
    document.addEventListener("pointercancel", finishResize);
    return () => {
      document.removeEventListener("pointermove", updateSize);
      document.removeEventListener("pointerup", finishResize);
      document.removeEventListener("pointercancel", finishResize);
    };
  }, [resizingPanel]);

  useEffect(() => {
    const pending = pendingPageRef.current;
    let pendingPage = 1;
    // 跨论文跳转时，selectedPaper 的切换是异步 React 状态更新。
    // pendingPageRef 暂存目标页，等新论文真正成为 selectedPaper 后再设置页码。
    if (pending && pending.paperId === selectedPaper?.id) {
      pendingPage = pending.page;
      pendingPageRef.current = undefined;
    }
    setCurrentPage(pendingPage);
    setExpandedCitation(undefined);
    setPaperReferences([]);
    setComposerMenuOpen(false);
    setComposerMenuSection(undefined);
    setFileUrl(undefined);
    if (!selectedPaper?.fileName) return;
    let disposed = false;
    void window.paperxcel.papers.fileUrl(selectedPaper.id).then((url) => {
      if (!disposed && url) setFileUrl(url);
    });
    return () => {
      disposed = true;
    };
  }, [selectedPaper?.fileName, selectedPaper?.id]);

  useEffect(() => {
    setComposerAttachments((current) => {
      if (current.length) {
        void Promise.all(
          current.map((attachment) =>
            window.paperxcel.chat.removeAttachment(attachment.id),
          ),
        );
      }
      return [];
    });
    setComposerTask("qa");
    setUploadingAttachmentCount(0);
    resetChatDragState();
  }, [resetChatDragState, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    let disposed = false;
    void window.paperxcel.chat
      .list(selectedId)
      .then((history) => {
        if (disposed) return;
        setMessages((current) => ({ ...current, [selectedId]: history }));
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setNotice(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      disposed = true;
    };
  }, [selectedId]);

  useEffect(() => {
    return window.paperxcel.chat.onProgress((progress) => {
      if (progress.requestId !== activeAskRequestRef.current) return;
      updateAskProgress(progress.detail);
      if (progress.reasoningContent !== undefined) {
        setAskReasoning(progress.reasoningContent);
      } else if (progress.reasoningDelta) {
        setAskReasoning((current) => current + progress.reasoningDelta);
      }
      if (progress.answerContent !== undefined) {
        setAskAnswer(progress.answerContent);
      } else if (progress.answerDelta) {
        setAskAnswer((current) => current + progress.answerDelta);
      }
    });
  }, [updateAskProgress]);

  useEffect(
    () =>
      window.paperxcel.knowledgeBase.onProgress((progress) => {
        if (
          progress.requestId &&
          progress.requestId === activeAskRequestRef.current
        ) {
          updateAskProgress(progress.detail);
        }
      }),
    [updateAskProgress],
  );

  useEffect(() => {
    if (!asking) return;
    const updateElapsed = (): void => {
      const startedAt = activeAskStartedAtRef.current;
      if (startedAt !== undefined) setAskElapsedMs(Date.now() - startedAt);
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 500);
    return () => window.clearInterval(timer);
  }, [asking]);

  useLayoutEffect(() => {
    pendingInitialChatScrollRef.current = selectedId;
  }, [selectedId]);

  useLayoutEffect(() => {
    if (!selectedId || assistantView !== "chat") return;
    const container = chatScrollRef.current;
    if (!container) return;
    const isInitialScroll = pendingInitialChatScrollRef.current === selectedId;
    if (isInitialScroll && !chatHistoryLoaded) return;
    container.scrollTo({
      top: container.scrollHeight,
      behavior: isInitialScroll ? "auto" : "smooth",
    });
    if (isInitialScroll) pendingInitialChatScrollRef.current = undefined;
  }, [
    assistantView,
    asking,
    askAnswer,
    askProgress,
    askReasoning,
    chatHistoryLoaded,
    paperMessages.length,
    selectedId,
  ]);

  const libraryScopePapers = useMemo(() => {
    return papers.filter((paper) => {
      if (filter === "all") return !paper.archived;
      if (filter === "starred") return paper.starred && !paper.archived;
      return Boolean(paper.archived);
    });
  }, [filter, papers]);

  const visiblePapers = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return libraryScopePapers.filter((paper) => {
      if (selectedFolderId && paper.folderId !== selectedFolderId) return false;
      if (!normalized) return true;
      return [
        paper.title,
        paper.authors.join(" "),
        paper.doi,
        paper.arxivId,
        paper.journal,
      ]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(normalized));
    });
  }, [libraryScopePapers, query, selectedFolderId]);

  const activePapers = useMemo(
    () => papers.filter((paper) => !paper.archived),
    [papers],
  );

  const folderNavigation = useMemo(() => {
    const entries: Array<{ folder: LibraryFolder; depth: number }> = [];
    const visited = new Set<string>();
    const addChildren = (parentId: string | undefined, depth: number): void => {
      folders
        .filter((folder) => folder.parentId === parentId)
        .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
        .forEach((folder) => {
          if (visited.has(folder.id)) return;
          visited.add(folder.id);
          entries.push({ folder, depth });
          addChildren(folder.id, depth + 1);
        });
    };

    addChildren(undefined, 0);
    folders
      .filter((folder) => !visited.has(folder.id))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
      .forEach((folder) => {
        visited.add(folder.id);
        entries.push({ folder, depth: 0 });
        addChildren(folder.id, 1);
      });
    return entries;
  }, [folders]);

  const selectableModels = useMemo(() => {
    const ids = [
      provider?.model,
      ...providerModels.map((model) => model.id),
    ].filter((id): id is string => Boolean(id));
    return [...new Set(ids)];
  }, [provider?.model, providerModels]);

  const reasoningLabel =
    reasoningOptions.find((option) => option.value === reasoningEffort)
      ?.label ?? "中";

  const importPdf = async (mergeIntoId?: string): Promise<void> => {
    try {
      const paper = await window.paperxcel.papers.importPdf({
        mergeIntoId,
        folderId: mergeIntoId ? undefined : selectedFolderId,
      });
      if (!paper) return;
      setPapers((current) => [
        paper,
        ...current.filter((item) => item.id !== paper.id),
      ]);
      setSelectedId(paper.id);
      setWorkspaceView("reader");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const importDroppedPdfs = async (files: File[]): Promise<void> => {
    const pdfFiles = files.filter(
      (file) =>
        file.type === "application/pdf" ||
        file.name.toLowerCase().endsWith(".pdf"),
    );
    if (!pdfFiles.length || importingDrop) {
      if (!pdfFiles.length) setNotice("只能拖入 PDF 文件。");
      return;
    }
    setImportingDrop(true);
    try {
      const mergeIntoId =
        pdfFiles.length === 1 && selectedPaper?.status === "needs_file"
          ? selectedPaper.id
          : undefined;
      for (const [index, file] of pdfFiles.entries()) {
        const paper = await window.paperxcel.papers.importDroppedPdf(file, {
          mergeIntoId: index === 0 ? mergeIntoId : undefined,
          folderId: index === 0 && mergeIntoId ? undefined : selectedFolderId,
        });
        setPapers((current) => [
          paper,
          ...current.filter((item) => item.id !== paper.id),
        ]);
        setSelectedId(paper.id);
      }
      setWorkspaceView("reader");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setImportingDrop(false);
    }
  };

  const uploadChatFiles = async (files: File[]): Promise<void> => {
    if (!selectedPaper || selectedPaper.status !== "ready") return;
    const available = Math.max(0, 6 - composerAttachments.length);
    const selectedFiles = files
      .filter((file) => file.size > 0)
      .slice(0, available);
    if (!selectedFiles.length) {
      setNotice(
        available
          ? "请选择有效文件。"
          : "单轮对话最多保留 6 个附件，请先移除已有附件。",
      );
      return;
    }
    setUploadingAttachmentCount((count) => count + selectedFiles.length);
    try {
      for (const file of selectedFiles) {
        try {
          const attachment = await window.paperxcel.chat.attachFile(
            file,
            selectedPaper.id,
          );
          setComposerAttachments((current) => [...current, attachment]);
        } catch (error) {
          setNotice(
            `${file.name} 上传失败：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } finally {
          setUploadingAttachmentCount((count) => Math.max(0, count - 1));
        }
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      setUploadingAttachmentCount(0);
    }
  };

  const handleChatPaste = (
    event: ReactClipboardEvent<HTMLTextAreaElement>,
  ): void => {
    const files = Array.from(event.clipboardData.files);
    if (!files.length) {
      for (const item of Array.from(event.clipboardData.items)) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (!files.length) return;
    event.preventDefault();
    void uploadChatFiles(files);
  };

  const removeComposerAttachment = async (
    attachment: ChatAttachment,
  ): Promise<void> => {
    setComposerAttachments((current) =>
      current.filter((item) => item.id !== attachment.id),
    );
    try {
      await window.paperxcel.chat.removeAttachment(attachment.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const prepareMarkdownPrompt = async (): Promise<void> => {
    if (
      !selectedPaper ||
      selectedPaper.status !== "ready" ||
      uploadingAttachmentCount
    ) {
      return;
    }
    const oldAttachments = composerAttachments;
    setComposerAttachments([]);
    if (oldAttachments.length) {
      await Promise.all(
        oldAttachments.map((attachment) =>
          window.paperxcel.chat.removeAttachment(attachment.id),
        ),
      );
    }
    setUploadingAttachmentCount(1);
    try {
      const attachment = await window.paperxcel.chat.attachPaperMarkdown(
        selectedPaper.id,
      );
      setComposerAttachments([attachment]);
      setComposerTask("repair-markdown");
      setQuestion(
        "请读取附件中的论文全文文件，修复并返回完整结果，写入当前论文缓存。",
      );
      window.requestAnimationFrame(() => questionRef.current?.focus());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      setComposerTask("qa");
    } finally {
      setUploadingAttachmentCount(0);
    }
  };

  const isInsideChatFileDropzone = (
    event: React.DragEvent<HTMLElement>,
  ): boolean =>
    event.target instanceof Element &&
    Boolean(event.target.closest("[data-chat-file-dropzone]"));

  const handleChatDragEnter = (
    event: React.DragEvent<HTMLDivElement>,
  ): void => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (
      shouldIgnorePdfDragEnter(
        chatDragDepthRef.current > 0,
        event,
        event.currentTarget.getBoundingClientRect(),
      )
    ) {
      return;
    }
    chatDragDepthRef.current = 1;
    setDraggingChatFile(true);
  };

  const handleChatDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setDraggingChatFile(true);
  };

  const handleChatDragLeave = (
    event: React.DragEvent<HTMLDivElement>,
  ): void => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (
      shouldIgnorePdfDragLeave(
        event.currentTarget,
        event.relatedTarget,
        event,
        event.currentTarget.getBoundingClientRect(),
      )
    ) {
      return;
    }
    resetChatDragState();
  };

  const handleChatDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    resetChatDragState();
    void uploadChatFiles(Array.from(event.dataTransfer.files));
  };

  const isFileDrag = (event: React.DragEvent<HTMLElement>): boolean =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");

  const handleDragEnter = (event: React.DragEvent<HTMLElement>): void => {
    if (!isFileDrag(event)) return;
    if (isInsideChatFileDropzone(event)) return;
    event.preventDefault();
    if (
      shouldIgnorePdfDragEnter(
        dragDepthRef.current > 0,
        event,
        event.currentTarget.getBoundingClientRect(),
      )
    ) {
      return;
    }
    dragDepthRef.current = 1;
    setDraggingPdf(true);
  };

  const handleDragOver = (event: React.DragEvent<HTMLElement>): void => {
    if (!isFileDrag(event)) return;
    if (isInsideChatFileDropzone(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (dragDepthRef.current === 0) {
      dragDepthRef.current = 1;
      setDraggingPdf(true);
    }
  };

  const handleDragLeave = (event: React.DragEvent<HTMLElement>): void => {
    if (!isFileDrag(event)) return;
    if (isInsideChatFileDropzone(event)) return;
    event.preventDefault();
    if (
      shouldIgnorePdfDragLeave(
        event.currentTarget,
        event.relatedTarget,
        event,
        event.currentTarget.getBoundingClientRect(),
      )
    ) {
      return;
    }
    resetPdfDragState();
  };

  const handleDrop = (event: React.DragEvent<HTMLElement>): void => {
    if (!isFileDrag(event)) return;
    if (isInsideChatFileDropzone(event)) return;
    event.preventDefault();
    resetPdfDragState();
    void importDroppedPdfs(Array.from(event.dataTransfer.files));
  };

  const getPaperDropPlacement = (
    event: React.DragEvent<HTMLElement>,
  ): PaperDropPlacement => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY > rect.top + rect.height / 2 ? "after" : "before";
  };

  const resetPaperDragState = (): void => {
    setDraggedPaperId(undefined);
    setPaperDropTarget(undefined);
    setFolderDropTargetId(undefined);
  };

  const persistPaperOrder = async (
    draggedId: string,
    targetId: string,
    placement: PaperDropPlacement,
  ): Promise<void> => {
    const previous = papers;
    const nextIds = reorderIds(
      papers.map((paper) => paper.id),
      draggedId,
      targetId,
      placement,
    );
    if (nextIds.every((id, index) => id === previous[index]?.id)) return;

    const paperById = new Map(papers.map((paper) => [paper.id, paper]));
    const next = nextIds
      .map((id) => paperById.get(id))
      .filter((paper): paper is Paper => Boolean(paper));

    setPapers(next);
    try {
      setPapers(await window.paperxcel.papers.reorder(nextIds));
    } catch (error) {
      setPapers(previous);
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const startPaperDrag = (
    event: React.DragEvent<HTMLButtonElement>,
    paper: Paper,
  ): void => {
    closePaperActionMenu();
    closeComposerMenu();
    setDraggedPaperId(paper.id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-paperxcel-paper", paper.id);
    event.dataTransfer.setData("text/plain", paper.title);
  };

  const updatePaperDropTarget = (
    event: React.DragEvent<HTMLButtonElement>,
    paper: Paper,
  ): void => {
    const draggedId =
      draggedPaperId ||
      event.dataTransfer.getData("application/x-paperxcel-paper");
    if (!draggedId || draggedId === paper.id) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setPaperDropTarget({
      paperId: paper.id,
      placement: getPaperDropPlacement(event),
    });
  };

  const dropPaper = (
    event: React.DragEvent<HTMLButtonElement>,
    paper: Paper,
  ): void => {
    const draggedId =
      draggedPaperId ||
      event.dataTransfer.getData("application/x-paperxcel-paper");
    event.preventDefault();
    event.stopPropagation();
    const placement =
      paperDropTarget?.paperId === paper.id
        ? paperDropTarget.placement
        : getPaperDropPlacement(event);
    resetPaperDragState();
    if (!draggedId || draggedId === paper.id) return;
    void persistPaperOrder(draggedId, paper.id, placement);
  };

  const updateFolderDropTarget = (
    event: React.DragEvent<HTMLButtonElement>,

    folderId: string,
  ): void => {
    const draggedId =
      draggedPaperId ||
      event.dataTransfer.getData("application/x-paperxcel-paper");

    const paper = papers.find((item) => item.id === draggedId);

    if (!draggedId || paper?.folderId === folderId) return;

    event.preventDefault();

    event.stopPropagation();

    event.dataTransfer.dropEffect = "move";

    setFolderDropTargetId(folderId);
  };

  const clearFolderDropTarget = (
    event: React.DragEvent<HTMLButtonElement>,

    folderId: string,
  ): void => {
    const relatedTarget = event.relatedTarget;

    if (
      relatedTarget instanceof Node &&
      event.currentTarget.contains(relatedTarget)
    ) {
      return;
    }

    setFolderDropTargetId((current) =>
      current === folderId ? undefined : current,
    );
  };

  const dropPaperInFolder = (
    event: React.DragEvent<HTMLButtonElement>,

    folderId: string,
  ): void => {
    const draggedId =
      draggedPaperId ||
      event.dataTransfer.getData("application/x-paperxcel-paper");

    if (!draggedId) return;

    event.preventDefault();

    event.stopPropagation();

    resetPaperDragState();

    const paper = papers.find((item) => item.id === draggedId);

    if (!paper || paper.folderId === folderId) return;

    void movePaperToFolder(paper, folderId);
  };

  const toggleStar = async (paper = selectedPaper): Promise<void> => {
    if (!paper) return;
    closePaperActionMenu();
    try {
      const updated = await window.paperxcel.papers.toggleStar(paper.id);
      setPapers((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const setPaperArchived = async (
    paper = selectedPaper,
    archived = true,
  ): Promise<void> => {
    if (!paper) return;
    closePaperActionMenu();
    try {
      const updated = await window.paperxcel.papers.setArchived(
        paper.id,
        archived,
      );
      setPapers((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      if (
        selectedId === updated.id &&
        ((archived && filter !== "archived") ||
          (!archived && filter === "archived"))
      ) {
        setSelectedId(undefined);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const movePaperToFolder = async (
    paper: Paper,
    folderId?: string,
  ): Promise<void> => {
    closePaperActionMenu();
    try {
      const updated = await window.paperxcel.papers.moveToFolder(
        paper.id,
        folderId,
      );
      setPapers((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const openCreateFolder = (movePaperId?: string): void => {
    closePaperActionMenu();
    setFolderNameDraft("");
    setFolderDialog({ mode: "create", movePaperId });
  };

  const openRenameFolder = (folder: LibraryFolder): void => {
    setFolderNameDraft(folder.name);
    setFolderDialog({ mode: "rename", folder });
  };

  const saveFolder = async (): Promise<void> => {
    if (!folderDialog || savingFolder) return;
    const name = folderNameDraft.trim();
    if (!name) {
      setNotice("请输入文件夹名称。");
      return;
    }

    setSavingFolder(true);
    try {
      const folder =
        folderDialog.mode === "create"
          ? await window.paperxcel.folders.create({ name })
          : await window.paperxcel.folders.rename(
              folderDialog.folder!.id,
              name,
            );
      setFolders((current) => {
        const next = current.filter((item) => item.id !== folder.id);
        return [...next, folder];
      });
      if (folderDialog.movePaperId) {
        const updated = await window.paperxcel.papers.moveToFolder(
          folderDialog.movePaperId,
          folder.id,
        );
        setPapers((current) =>
          current.map((item) => (item.id === updated.id ? updated : item)),
        );
      }
      setFolderDialog(undefined);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingFolder(false);
    }
  };

  const removeFolder = async (folder: LibraryFolder): Promise<void> => {
    if (!window.confirm(`删除“${folder.name}”？其中的文献将移至上级文件夹。`)) {
      return;
    }
    try {
      const result = await window.paperxcel.folders.remove(folder.id);
      const updatedPapers = new Map(
        result.papers.map((paper) => [paper.id, paper]),
      );
      setFolders(result.folders);
      setPapers((current) =>
        current.map((paper) => updatedPapers.get(paper.id) ?? paper),
      );
      setSelectedFolderId((current) =>
        current === folder.id ? folder.parentId : current,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const removePaper = async (paper = selectedPaper): Promise<void> => {
    if (!paper) return;
    closePaperActionMenu();
    try {
      await window.paperxcel.papers.remove(paper.id);
      const next = papers.filter((item) => item.id !== paper.id);
      setPapers(next);
      setMessages((current) => {
        const remaining = { ...current };
        delete remaining[paper.id];
        return remaining;
      });
      setSelectedId((current) =>
        current === paper.id ? next[0]?.id : current,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const ask = async (
    prompt = question,
    references: ChatReference[] = paperReferences,
    options?: AskOptions,
  ): Promise<void> => {
    if (
      !selectedPaper ||
      !prompt.trim() ||
      asking ||
      uploadingAttachmentCount > 0
    ) {
      return;
    }
    const cleanQuestion = prompt.trim();
    const task = options?.task ?? (options?.history ? "qa" : composerTask);
    const attachments =
      options?.attachments ?? (options?.history ? [] : composerAttachments);
    const cleanReferences = references
      .map((reference) => ({
        page: reference.page,
        text: reference.text.replace(/\s+/g, " ").trim(),
        imageAssetId: reference.imageAssetId,
        imageDataUrl: reference.imageDataUrl,
        imageOnly: reference.imageOnly,
      }))
      .filter(
        (reference) =>
          reference.text || reference.imageAssetId || reference.imageDataUrl,
      );
    const persistedReferences: ReferencedSnippet[] = await Promise.all(
      cleanReferences.map(
        async ({ page, text, imageAssetId, imageDataUrl, imageOnly }) => {
          const storedImageId =
            imageAssetId ||
            (imageDataUrl
              ? (await window.paperxcel.selectionImages.save(imageDataUrl)).id
              : undefined);
          return {
            page,
            text,
            imageAssetId: storedImageId,
            imageOnly,
          };
        },
      ),
    );
    const shouldReplaceHistory = options?.history !== undefined;
    const baseMessages = options?.history ?? paperMessages;
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: cleanReferences.length
        ? `${cleanQuestion}\n\n引用原文：\n${formatReferencesForMessage(cleanReferences)}`
        : cleanQuestion,
      prompt: cleanQuestion,
      task,
      attachments: attachments.length ? attachments : undefined,
      selectedText: persistedReferences[0]?.text,
      selectedPage: persistedReferences[0]?.page,
      selectedSnippets: persistedReferences.length
        ? persistedReferences
        : undefined,
      createdAt: new Date().toISOString(),
    };
    const paperId = selectedPaper.id;
    const requestId = crypto.randomUUID();
    const nextMessages = [...baseMessages, userMessage];
    setQuestion("");
    setPaperReferences([]);
    setComposerAttachments([]);
    setComposerTask("qa");
    window.getSelection()?.removeAllRanges();
    setMessages((current) => ({
      ...current,
      [paperId]: nextMessages,
    }));
    activeAskRequestRef.current = requestId;
    setStoppingAsk(false);
    setAsking(true);
    beginAskPresentation(
      task === "repair-markdown"
        ? "正在准备文件修复"
        : attachments.length
          ? "正在上传附件给模型"
          : "正在准备当前论文 PDF",
    );
    try {
      if (shouldReplaceHistory) {
        await persistConversation(paperId, nextMessages);
      } else {
        await window.paperxcel.chat.append(paperId, userMessage);
      }
      const result = await window.paperxcel.chat.ask({
        requestId,
        paperId,
        question: cleanQuestion,
        currentPage,
        selectedText: cleanReferences[0]?.text,
        selectedPage: cleanReferences[0]?.page,
        selectedSnippets: persistedReferences,
        task,
        attachments,
        reasoningEffort,
        messages: baseMessages,
      });
      if ("cancelled" in result) return;
      if (cancelledAskRequestIdsRef.current.has(requestId)) {
        return;
      }
      const completeMessages = [...nextMessages, result.message];
      if (shouldReplaceHistory) {
        await persistConversation(paperId, completeMessages);
      } else {
        await window.paperxcel.chat.append(paperId, result.message);
      }
      setMessages((current) => ({
        ...current,
        [paperId]: completeMessages,
      }));
      if (result.markdownPreview) {
        setMarkdownRefreshTokens((current) => ({
          ...current,
          [paperId]:
            result.markdownPreview?.repairedAt ||
            result.markdownPreview?.generatedAt ||
            crypto.randomUUID(),
        }));
      }
    } catch (error) {
      if (
        cancelledAskRequestIdsRef.current.has(requestId) ||
        isAbortError(error)
      ) {
        return;
      }
      const errorMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: `请求失败：${error instanceof Error ? error.message : String(error)}`,
        createdAt: new Date().toISOString(),
      };
      setMessages((current) => ({
        ...current,
        [paperId]: [...nextMessages, errorMessage],
      }));
    } finally {
      if (activeAskRequestRef.current === requestId) {
        activeAskRequestRef.current = undefined;
        setStoppingAsk(false);
        setAsking(false);
        resetAskPresentation();
      }
      cancelledAskRequestIdsRef.current.delete(requestId);
    }
  };

  const submitMessageEdit = async (
    message: ChatMessage,
    messageIndex: number,
  ): Promise<void> => {
    if (
      !selectedId ||
      !selectedPaper ||
      asking ||
      editingMessageId !== message.id ||
      message.role !== "user"
    ) {
      return;
    }
    const cleanDraft = editingMessageText.trim();
    if (!cleanDraft) return;

    const references = paperReferences;
    cancelEditingMessage();
    await ask(cleanDraft, references, {
      history: paperMessages.slice(0, messageIndex),
    });
  };

  const reprocessPaper = async (paper = selectedPaper): Promise<void> => {
    if (!paper) return;
    closePaperActionMenu();
    try {
      const updated = await window.paperxcel.papers.reprocess(paper.id);
      setPapers((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const changeProviderModel = async (model: string): Promise<void> => {
    if (!provider || !model || model === provider.model) return;
    try {
      await window.paperxcel.providers.save({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        model,
        protocol: provider.protocol,
      });
      await window.paperxcel.providers.setActive(provider.id);
      await refreshProviders();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const clearConversation = async (): Promise<void> => {
    if (!selectedId || !paperMessages.length || asking) return;
    if (!window.confirm("清空这篇论文的本地问答记录？")) return;
    await window.paperxcel.chat.clear(selectedId);
    setMessages((current) => ({ ...current, [selectedId]: [] }));
    setExpandedCitation(undefined);
    setPaperReferences([]);
    cancelEditingMessage();
  };

  const openLibraryHit = (paperId: string, page: number): void => {
    setWorkspaceView("reader");
    setExpandedCitation(undefined);
    // 同一篇论文可以直接改 currentPage；跨论文则先记录目标页，
    // 再切换 selectedId，由上面的 effect 在新论文加载时恢复该页。
    if (selectedId === paperId) {
      setCurrentPage(page);
      return;
    }
    pendingPageRef.current = { paperId, page };
    setSelectedId(paperId);
  };

  const openGraphPaper = (paperId: string): void => {
    setWorkspaceView("reader");
    setSelectedId(paperId);
  };

  const searchLibrary = async (
    nextQuery = librarySearchQuery,
  ): Promise<void> => {
    const cleanQuery = nextQuery.trim();
    if (!cleanQuery || librarySearching) return;
    setLibrarySearchQuery(cleanQuery);
    setLibrarySearching(true);
    try {
      const hits = await window.paperxcel.search.library({
        query: cleanQuery,
        limit: 30,
      });
      setLibrarySearchResults(hits);
      setLibrarySearched(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setLibrarySearching(false);
    }
  };

  const startPanelResize = (
    panel: ResizablePanel,
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    event.preventDefault();
    setResizingPanel(panel);
  };

  const resizePanelWithKeyboard = (
    panel: ResizablePanel,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ): void => {
    const amount = event.shiftKey ? 40 : 20;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const shellWidth = appShellRef.current?.getBoundingClientRect().width;
    const sidebarWidth =
      appSidebarRef.current?.getBoundingClientRect().width ?? 64;
    if (panel === "library") {
      const maxWidth = shellWidth
        ? Math.min(
            MAX_PAPER_RAIL_WIDTH,
            shellWidth -
              sidebarWidth -
              (assistantPaneVisible ? assistantPaneWidth + 8 : 0) -
              MIN_READER_PANE_WIDTH -
              8,
          )
        : MAX_PAPER_RAIL_WIDTH;
      setPaperRailWidth((current) =>
        clampPanelWidth(
          current + (event.key === "ArrowRight" ? amount : -amount),
          MIN_PAPER_RAIL_WIDTH,
          maxWidth,
        ),
      );
      return;
    }
    if (panel === "knowledge") {
      const maxWidth = shellWidth
        ? Math.min(
            MAX_KNOWLEDGE_INDEX_WIDTH,
            shellWidth - sidebarWidth - MIN_READER_PANE_WIDTH - 8,
          )
        : MAX_KNOWLEDGE_INDEX_WIDTH;
      setKnowledgeIndexWidth((current) =>
        clampPanelWidth(
          current + (event.key === "ArrowRight" ? amount : -amount),
          MIN_KNOWLEDGE_INDEX_WIDTH,
          maxWidth,
        ),
      );
      return;
    }
    if (panel === "citation") {
      const maxWidth = shellWidth
        ? Math.min(
            MAX_CITATION_SIDEBAR_WIDTH,
            shellWidth - sidebarWidth - MIN_READER_PANE_WIDTH - 8,
          )
        : MAX_CITATION_SIDEBAR_WIDTH;
      setCitationSidebarWidth((current) =>
        clampPanelWidth(
          current + (event.key === "ArrowRight" ? amount : -amount),
          MIN_CITATION_SIDEBAR_WIDTH,
          maxWidth,
        ),
      );
      return;
    }
    const maxWidth = shellWidth
      ? Math.min(
          MAX_ASSISTANT_PANE_WIDTH,
          shellWidth -
            sidebarWidth -
            (paperRailVisible ? paperRailWidth + 8 : 0) -
            MIN_READER_PANE_WIDTH -
            8,
        )
      : MAX_ASSISTANT_PANE_WIDTH;
    setAssistantPaneWidth((current) =>
      clampPanelWidth(
        current + (event.key === "ArrowLeft" ? amount : -amount),
        MIN_ASSISTANT_PANE_WIDTH,
        maxWidth,
      ),
    );
  };

  const appShellStyle = {
    "--paper-rail-width": `${paperRailWidth}px`,
    "--assistant-pane-width": `${assistantPaneWidth}px`,
    "--knowledge-index-width": `${knowledgeIndexWidth}px`,
    "--citation-sidebar-width": `${citationSidebarWidth}px`,
  } as CSSProperties;
  const leftSidebarVisible =
    workspaceView === "citation" ? citationSidebarVisible : paperRailVisible;
  const leftSidebarLabel = leftSidebarVisible ? "隐藏侧边栏" : "显示侧边栏";

  return (
    <div
      ref={appShellRef}
      className={`app-shell workspace-${workspaceView} ${
        workspaceView !== "citation" && !paperRailVisible
          ? "paper-rail-collapsed"
          : ""
      } ${assistantPaneVisible ? "" : "assistant-pane-collapsed"} ${
        workspaceView === "citation" && !citationSidebarVisible
          ? "citation-sidebar-collapsed"
          : ""
      } ${resizingPanel ? "is-resizing" : ""}`}
      style={appShellStyle}
    >
      <div className="titlebar-drag">
        <div className="titlebar-brand" aria-label="PaperXcel">
          <img src="./paperxcel.png" alt="" />
          <span>PaperXcel</span>
        </div>
      </div>
      <button
        className="titlebar-panel-toggle"
        type="button"
        title={leftSidebarLabel}
        aria-label={leftSidebarLabel}
        onClick={() => {
          if (workspaceView === "citation") {
            setCitationSidebarVisible((current) => !current);
          } else {
            setPaperRailVisible((current) => !current);
          }
        }}
      >
        {leftSidebarVisible ? (
          <PanelLeftClose size={17} />
        ) : (
          <PanelLeftOpen size={17} />
        )}
      </button>
      <aside ref={appSidebarRef} className="app-sidebar">
        <nav className="sidebar-nav" aria-label="主导航">
          <button
            className={
              workspaceView === "reader" && filter === "all" ? "active" : ""
            }
            type="button"
            title="文献库"
            onClick={() => {
              setFilter("all");
              setSelectedFolderId(undefined);
              setWorkspaceView("reader");
            }}
          >
            <Library size={20} />
          </button>
          <button
            className={
              workspaceView === "reader" && filter === "starred" ? "active" : ""
            }
            type="button"
            title="星标文献"
            onClick={() => {
              setFilter("starred");
              setSelectedFolderId(undefined);
              setWorkspaceView("reader");
            }}
          >
            <Star size={20} />
          </button>
          <button
            className={
              workspaceView === "reader" && filter === "archived"
                ? "active"
                : ""
            }
            type="button"
            title="已归档文献"
            onClick={() => {
              setFilter("archived");
              setSelectedFolderId(undefined);
              setWorkspaceView("reader");
            }}
          >
            <Archive size={20} />
          </button>
          <button
            className={workspaceView === "search" ? "active" : ""}
            type="button"
            title="全库检索"
            onClick={() => setWorkspaceView("search")}
          >
            <FileSearch size={20} />
          </button>
          <button
            className={workspaceView === "knowledge" ? "active" : ""}
            type="button"
            title="知识库"
            onClick={() => setWorkspaceView("knowledge")}
          >
            <Database size={20} />
          </button>
          <button
            className={workspaceView === "citation" ? "active" : ""}
            type="button"
            title="引文图谱"
            onClick={() => {
              setCitationWorkspaceMounted(true);
              setWorkspaceView("citation");
            }}
          >
            <Network size={20} />
          </button>
        </nav>
        <button
          className="sidebar-settings"
          type="button"
          title="应用设置"
          onClick={() => {
            setAppSettingsSection("doi");
            setAppSettingsOpen(true);
          }}
        >
          <Settings size={20} />
        </button>
      </aside>

      {workspaceView !== "citation" &&
        workspaceView !== "search" &&
        workspaceView !== "knowledge" &&
        paperRailVisible && (
          <>
            <aside
              className={`paper-rail${draggingPdf ? " dragging-pdf" : ""}`}
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {(draggingPdf || importingDrop) && (
                <div className="pdf-drop-overlay" aria-live="polite">
                  <div>
                    {importingDrop ? (
                      <LoaderCircle className="spin" size={28} />
                    ) : (
                      <Upload size={28} />
                    )}
                    <strong>
                      {importingDrop ? "正在导入 PDF" : "松开即可导入 PDF"}
                    </strong>
                    <span>支持一次拖入多篇论文</span>
                  </div>
                </div>
              )}
              <header className="rail-header">
                <div>
                  <span className="eyebrow">
                    {selectedFolder
                      ? "FOLDER"
                      : filter === "starred"
                        ? "STARRED"
                        : filter === "archived"
                          ? "ARCHIVE"
                          : "LIBRARY"}
                  </span>
                  <h1>
                    {selectedFolder
                      ? selectedFolder.name
                      : filter === "starred"
                        ? "星标文献"
                        : filter === "archived"
                          ? "已归档文献"
                          : "文献库"}
                  </h1>
                </div>
                <button
                  className="icon-button strong"
                  type="button"
                  title="导入 PDF"
                  onClick={() => void importPdf()}
                >
                  <Plus size={18} />
                </button>
              </header>
              <div className="rail-actions">
                <label className="search-field">
                  <Search size={16} />
                  <input
                    placeholder="搜索标题、作者、DOI 等"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  {query && (
                    <button
                      type="button"
                      title="清除"
                      onClick={() => setQuery("")}
                    >
                      <X size={14} />
                    </button>
                  )}
                </label>
                <button
                  className="doi-button"
                  type="button"
                  title="通过 DOI 或 arXiv 添加论文"
                  onClick={() => setDoiOpen(true)}
                >
                  论文
                </button>
                <button
                  className="zotero-button"
                  type="button"
                  title="从 Zotero 拉取"
                  onClick={() => {
                    setAppSettingsSection("zotero");
                    setAppSettingsOpen(true);
                  }}
                >
                  <Download size={15} />
                </button>
              </div>
              <section className="folder-navigation" aria-label="文件夹">
                <div className="folder-navigation-header">
                  <span>文件夹</span>
                  <button
                    type="button"
                    title="新建文件夹"
                    onClick={() => openCreateFolder()}
                  >
                    <FolderPlus size={15} />
                  </button>
                </div>
                <div className="folder-navigation-list">
                  <button
                    className={`folder-navigation-item ${
                      !selectedFolderId ? "active" : ""
                    }`}
                    type="button"
                    onClick={() => {
                      setSelectedFolderId(undefined);
                      setWorkspaceView("reader");
                    }}
                  >
                    <FolderOpen size={15} />
                    <span>全部文献</span>
                    <small>{libraryScopePapers.length}</small>
                  </button>
                  {folderNavigation.map(({ folder, depth }) => (
                    <div className="folder-navigation-row" key={folder.id}>
                      <button
                        className={`folder-navigation-item ${
                          selectedFolderId === folder.id ? "active" : ""
                        } ${folderDropTargetId === folder.id ? "drop-target" : ""}`}
                        type="button"
                        style={{ paddingLeft: `${10 + depth * 14}px` }}
                        title={folder.name}
                        onClick={() => {
                          setSelectedFolderId(folder.id);
                          setWorkspaceView("reader");
                        }}
                        onDragOver={(event) =>
                          updateFolderDropTarget(event, folder.id)
                        }
                        onDragLeave={(event) =>
                          clearFolderDropTarget(event, folder.id)
                        }
                        onDrop={(event) => dropPaperInFolder(event, folder.id)}
                      >
                        <Folder size={15} />
                        <span>{folder.name}</span>
                        <small>
                          {
                            libraryScopePapers.filter(
                              (paper) => paper.folderId === folder.id,
                            ).length
                          }
                        </small>
                      </button>
                      {selectedFolderId === folder.id && (
                        <span className="folder-navigation-actions">
                          <button
                            type="button"
                            title="重命名文件夹"
                            onClick={() => openRenameFolder(folder)}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            title="删除文件夹"
                            onClick={() => void removeFolder(folder)}
                          >
                            <Trash2 size={13} />
                          </button>
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </section>
              <div className="paper-list">
                {visiblePapers.length === 0 && (
                  <div className="rail-empty">
                    <FileText size={24} />
                    <strong>
                      {papers.length
                        ? selectedFolder
                          ? "文件夹中暂无文献"
                          : "没有匹配结果"
                        : "尚无文献"}
                    </strong>
                    {!papers.length && (
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => void importPdf()}
                      >
                        <Upload size={16} />
                        导入 PDF
                      </button>
                    )}
                  </div>
                )}
                {visiblePapers.map((paper) => (
                  <button
                    className={`paper-row ${paper.id === selectedId ? "selected" : ""} ${
                      paperActionMenu?.paperId === paper.id ? "menu-open" : ""
                    } ${draggedPaperId === paper.id ? "dragging" : ""} ${
                      paperDropTarget?.paperId === paper.id
                        ? `drop-${paperDropTarget.placement}`
                        : ""
                    }`}
                    type="button"
                    draggable
                    key={paper.id}
                    onClick={() => {
                      closePaperActionMenu();
                      setSelectedId(paper.id);
                      setWorkspaceView("reader");
                    }}
                    onContextMenu={(event) => openPaperActionMenu(event, paper)}
                    onDragStart={(event) => startPaperDrag(event, paper)}
                    onDragOver={(event) => updatePaperDropTarget(event, paper)}
                    onDragLeave={(event) => {
                      const relatedTarget = event.relatedTarget;
                      if (
                        relatedTarget instanceof Node &&
                        event.currentTarget.contains(relatedTarget)
                      ) {
                        return;
                      }
                      setPaperDropTarget((current) =>
                        current?.paperId === paper.id ? undefined : current,
                      );
                    }}
                    onDrop={(event) => dropPaper(event, paper)}
                    onDragEnd={resetPaperDragState}
                  >
                    <span className="paper-row-top">
                      <span
                        className={`status-marker status-${paper.status}`}
                      />
                      <strong>{paper.title}</strong>
                      {paper.starred && <Star size={14} fill="currentColor" />}
                    </span>
                    <span className="paper-authors">
                      {paper.authors.length
                        ? paper.authors.slice(0, 3).join(", ")
                        : "作者待补全"}
                    </span>
                    <span className="paper-meta">
                      <span>{paper.year ?? "年份未知"}</span>
                      <span>
                        {paper.pageCount
                          ? `${paper.pageCount} 页`
                          : statusLabel(paper)}
                      </span>
                    </span>
                    {paper.status === "processing" && (
                      <span className="mini-progress">
                        <span style={{ width: `${paper.progress}%` }} />
                      </span>
                    )}
                  </button>
                ))}
              </div>
              {paperActionMenu && paperActionTarget && (
                <div
                  className="paper-action-menu"
                  ref={paperMenuRef}
                  role="menu"
                  style={{ left: paperActionMenu.x, top: paperActionMenu.y }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void toggleStar(paperActionTarget)}
                  >
                    <Star
                      size={15}
                      fill={paperActionTarget.starred ? "currentColor" : "none"}
                    />
                    {paperActionTarget.starred ? "取消星标" : "添加星标"}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() =>
                      void setPaperArchived(
                        paperActionTarget,
                        !paperActionTarget.archived,
                      )
                    }
                  >
                    {paperActionTarget.archived ? (
                      <ArchiveRestore size={15} />
                    ) : (
                      <Archive size={15} />
                    )}
                    {paperActionTarget.archived ? "取消归档" : "归档论文"}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    aria-expanded={folderMoveMenuOpen}
                    onClick={() => setFolderMoveMenuOpen((current) => !current)}
                  >
                    <Folder size={15} />
                    移动至文件夹
                  </button>
                  {folderMoveMenuOpen && (
                    <div className="paper-action-folder-picker" role="menu">
                      <button
                        className={
                          !paperActionTarget.folderId ? "selected" : ""
                        }
                        type="button"
                        role="menuitemradio"
                        aria-checked={!paperActionTarget.folderId}
                        onClick={() =>
                          void movePaperToFolder(paperActionTarget)
                        }
                      >
                        <FolderOpen size={14} />
                        未分类
                      </button>
                      {folderNavigation.map(({ folder, depth }) => (
                        <button
                          className={
                            paperActionTarget.folderId === folder.id
                              ? "selected"
                              : ""
                          }
                          type="button"
                          role="menuitemradio"
                          aria-checked={
                            paperActionTarget.folderId === folder.id
                          }
                          key={folder.id}
                          style={{ paddingLeft: `${9 + depth * 12}px` }}
                          onClick={() =>
                            void movePaperToFolder(paperActionTarget, folder.id)
                          }
                        >
                          <Folder size={14} />
                          {folder.name}
                        </button>
                      ))}
                      <button
                        className="paper-action-new-folder"
                        type="button"
                        role="menuitem"
                        onClick={() => openCreateFolder(paperActionTarget.id)}
                      >
                        <FolderPlus size={14} />
                        新建文件夹
                      </button>
                    </div>
                  )}
                  {paperActionTarget.sourceUrl && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        closePaperActionMenu();
                        void window.paperxcel.papers.openSource(
                          paperActionTarget.id,
                        );
                      }}
                    >
                      <ExternalLink size={15} />
                      打开来源
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void reprocessPaper(paperActionTarget)}
                  >
                    <RefreshCw size={15} />
                    重新解析信息与索引
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closePaperActionMenu();
                      void importPdf(paperActionTarget.id);
                    }}
                  >
                    <Upload size={15} />
                    替换 PDF
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closePaperActionMenu();
                      void window.paperxcel.papers.showInFolder(
                        paperActionTarget.id,
                      );
                    }}
                  >
                    <FolderOpen size={15} />
                    在资源管理器中显示
                  </button>
                  {paperActionTarget.doi && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        closePaperActionMenu();
                        void copyDoi(paperActionTarget.doi!);
                      }}
                    >
                      <Copy size={15} />
                      复制 DOI
                    </button>
                  )}
                  <span className="paper-action-divider" />
                  <button
                    className="paper-action-danger"
                    type="button"
                    role="menuitem"
                    onClick={() => void removePaper(paperActionTarget)}
                  >
                    <Trash2 size={15} />
                    删除论文
                  </button>
                </div>
              )}
            </aside>
            <div
              className="panel-resize-handle paper-rail-resize-handle"
              role="separator"
              aria-label="调整文献栏宽度"
              aria-orientation="vertical"
              aria-valuemin={MIN_PAPER_RAIL_WIDTH}
              aria-valuemax={MAX_PAPER_RAIL_WIDTH}
              aria-valuenow={paperRailWidth}
              tabIndex={0}
              onPointerDown={(event) => startPanelResize("library", event)}
              onKeyDown={(event) => resizePanelWithKeyboard("library", event)}
            />
          </>
        )}

      <main className="workspace">
        {citationWorkspaceMounted && (
          <div
            className={`citation-workspace-session ${
              workspaceView === "citation" ? "" : "is-hidden"
            }`}
            aria-hidden={workspaceView !== "citation"}
          >
            <CitationGraphWorkspace
              papers={activePapers}
              folders={folders}
              sidebarWidth={citationSidebarWidth}
              sidebarMinWidth={MIN_CITATION_SIDEBAR_WIDTH}
              sidebarMaxWidth={MAX_CITATION_SIDEBAR_WIDTH}
              onSidebarResizePointerDown={(event) =>
                startPanelResize("citation", event)
              }
              onSidebarResizeKeyDown={(event) =>
                resizePanelWithKeyboard("citation", event)
              }
              onOpenPaper={openGraphPaper}
              onOpenSettings={() => {
                setAppSettingsSection("openalex");
                setAppSettingsOpen(true);
              }}
              onError={setNotice}
            />
          </div>
        )}
        {workspaceView === "citation" ? null : workspaceView === "search" ? (
          <LibrarySearchWorkspace
            papers={papers}
            provider={provider}
            models={selectableModels}
            query={librarySearchQuery}
            results={librarySearchResults}
            searching={librarySearching}
            searched={librarySearched}
            reasoningEffort={reasoningEffort}
            onModelChange={changeProviderModel}
            onReasoningChange={setReasoningEffort}
            onQueryChange={setLibrarySearchQuery}
            onSearch={(nextQuery) => void searchLibrary(nextQuery)}
            onOpenHit={openLibraryHit}
            onError={setNotice}
          />
        ) : workspaceView === "knowledge" ? (
          <KnowledgeWorkspace
            papers={activePapers}
            indexWidth={knowledgeIndexWidth}
            indexMinWidth={MIN_KNOWLEDGE_INDEX_WIDTH}
            indexMaxWidth={MAX_KNOWLEDGE_INDEX_WIDTH}
            onIndexResizePointerDown={(event) =>
              startPanelResize("knowledge", event)
            }
            onIndexResizeKeyDown={(event) =>
              resizePanelWithKeyboard("knowledge", event)
            }
            onError={setNotice}
          />
        ) : !selectedPaper ? (
          <section className="workspace-empty">
            <div className="empty-symbol">
              <BookOpen size={28} />
            </div>
            <h2>PaperXcel</h2>
            <div className="empty-actions">
              <button
                className="primary-button"
                type="button"
                onClick={() => void importPdf()}
              >
                <FilePlus2 size={17} />
                导入 PDF
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => setDoiOpen(true)}
              >
                添加论文
              </button>
            </div>
          </section>
        ) : (
          <>
            <header className="paper-header">
              <div className="paper-heading">
                <div className="paper-title-line">
                  <h2>{selectedPaper.title}</h2>
                </div>
                <p>
                  {selectedPaper.authors.join(", ") || "作者待补全"}
                  {selectedPaper.journal && ` · ${selectedPaper.journal}`}
                  {selectedPaper.year && ` · ${selectedPaper.year}`}
                </p>
              </div>
              {!assistantPaneVisible && (
                <button
                  className="icon-button"
                  type="button"
                  title="显示文献助手"
                  aria-label="显示文献助手"
                  onClick={() => setAssistantPaneVisible(true)}
                >
                  <PanelRightOpen size={17} />
                </button>
              )}
            </header>

            <div
              className={`reading-layout ${
                assistantPaneVisible ? "" : "assistant-pane-collapsed"
              }`}
            >
              <section className="reader-pane">
                {selectedPaper.status === "needs_file" && (
                  <div className="pane-state">
                    <BookOpen size={30} />
                    <h3>
                      {selectedPaper.doi ||
                        (selectedPaper.arxivId
                          ? `arXiv:${selectedPaper.arxivId}${
                              selectedPaper.arxivVersion
                                ? `v${selectedPaper.arxivVersion}`
                                : ""
                            }`
                          : selectedPaper.title)}
                    </h3>
                    {selectedPaper.statusText && (
                      <p>{selectedPaper.statusText}</p>
                    )}
                    <div className="pane-state-actions">
                      {selectedPaper.manualPdfUrl && (
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() =>
                            void window.paperxcel.papers.openManualPdfPage(
                              selectedPaper.id,
                            )
                          }
                        >
                          <ExternalLink size={16} />
                          在浏览器中打开
                        </button>
                      )}
                      <button
                        className="primary-button"
                        type="button"
                        onClick={() => void importPdf(selectedPaper.id)}
                      >
                        <Upload size={16} />
                        添加 PDF
                      </button>
                    </div>
                  </div>
                )}
                {(selectedPaper.status === "queued" ||
                  selectedPaper.status === "processing") && (
                  <div className="pane-state processing-state">
                    <LoaderCircle className="spin" size={30} />
                    <h3>{selectedPaper.statusText || "正在解析文献"}</h3>
                    <div className="large-progress">
                      <span style={{ width: `${selectedPaper.progress}%` }} />
                    </div>
                    <small>{selectedPaper.progress}%</small>
                  </div>
                )}
                {selectedPaper.status === "error" && (
                  <div className="pane-state error-state">
                    <CircleAlert size={30} />
                    <h3>文献解析失败</h3>
                    <p>{selectedPaper.error}</p>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void importPdf(selectedPaper.id)}
                    >
                      重新选择 PDF
                    </button>
                  </div>
                )}
                {selectedPaper.status === "ready" && fileUrl && (
                  <PaperReader
                    key={selectedPaper.id}
                    paper={selectedPaper}
                    url={fileUrl}
                    page={currentPage}
                    onPageChange={setCurrentPage}
                    onReferenceSelection={addPaperReference}
                    provider={provider}
                    refreshToken={markdownRefreshTokens[selectedPaper.id]}
                    onNotice={(message) => setNotice(message)}
                    onRepairMarkdown={repairMarkdownThroughAssistant}
                    onCancelRepair={cancelMarkdownThroughAssistant}
                    onTranslateSelection={(selection) => {
                      if (!selection.imageOnly) {
                        void translateSelectedText(selection.text);
                      }
                    }}
                  />
                )}
              </section>

              {assistantPaneVisible && (
                <div
                  className="panel-resize-handle ai-pane-resize-handle"
                  role="separator"
                  aria-label="调整文献助手宽度"
                  aria-orientation="vertical"
                  aria-valuemin={MIN_ASSISTANT_PANE_WIDTH}
                  aria-valuemax={MAX_ASSISTANT_PANE_WIDTH}
                  aria-valuenow={assistantPaneWidth}
                  tabIndex={0}
                  onPointerDown={(event) =>
                    startPanelResize("assistant", event)
                  }
                  onKeyDown={(event) =>
                    resizePanelWithKeyboard("assistant", event)
                  }
                />
              )}
              {assistantPaneVisible && (
                <aside
                  className="ai-pane"
                  onPointerDownCapture={resetTransientDragState}
                >
                  <header className="ai-header">
                    <div className="ai-title">
                      <span className="ai-icon">
                        <Sparkles size={17} />
                      </span>
                      <div>
                        <strong>文献助手</strong>
                        <small>
                          {provider
                            ? `${provider.name} · ${provider.model}`
                            : "尚未配置模型"}
                        </small>
                      </div>
                    </div>
                    <div className="ai-header-actions">
                      <button
                        className="icon-button"
                        type="button"
                        title="隐藏文献助手"
                        aria-label="隐藏文献助手"
                        onClick={() => setAssistantPaneVisible(false)}
                      >
                        <PanelRightClose size={17} />
                      </button>
                      {assistantView === "chat" && paperMessages.length > 0 && (
                        <button
                          className="icon-button"
                          type="button"
                          title="清空对话"
                          disabled={asking}
                          onClick={() => void clearConversation()}
                        >
                          <Eraser size={16} />
                        </button>
                      )}
                      <button
                        className="icon-button"
                        type="button"
                        title="模型设置"
                        onClick={() => setSettingsOpen(true)}
                      >
                        <Settings size={16} />
                      </button>
                    </div>
                  </header>
                  <div
                    className="assistant-tabs"
                    role="tablist"
                    aria-label="文献助手视图"
                  >
                    <button
                      className={assistantView === "chat" ? "active" : ""}
                      type="button"
                      role="tab"
                      aria-selected={assistantView === "chat"}
                      onClick={() => setAssistantView("chat")}
                    >
                      <MessageSquareText size={14} />
                      问答
                    </button>
                    <button
                      className={assistantView === "notes" ? "active" : ""}
                      type="button"
                      role="tab"
                      aria-selected={assistantView === "notes"}
                      onClick={() => setAssistantView("notes")}
                    >
                      {generatingNotePaperIds.has(selectedPaper.id) ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <NotebookPen size={14} />
                      )}
                      笔记
                    </button>
                  </div>
                  <div
                    className={`assistant-view-panel${
                      draggingChatFile ? " is-file-dragging" : ""
                    }`}
                    hidden={assistantView !== "chat"}
                    data-chat-file-dropzone
                    onDragEnter={handleChatDragEnter}
                    onDragOver={handleChatDragOver}
                    onDragLeave={handleChatDragLeave}
                    onDrop={handleChatDrop}
                  >
                    {draggingChatFile && (
                      <div
                        className="chat-file-drop-overlay"
                        aria-hidden="true"
                      >
                        <Upload size={22} />
                        <span>松开以添加文件</span>
                      </div>
                    )}
                    <div className="chat-scroll" ref={chatScrollRef}>
                      {!paperMessages.length && (
                        <div className="chat-start">
                          <div className="chat-start-heading">
                            <Bot size={21} />
                            <span>第 {currentPage} 页</span>
                          </div>
                          <div className="prompt-grid">
                            {prompts.map((item) => (
                              <button
                                type="button"
                                key={item.label}
                                disabled={selectedPaper.status !== "ready"}
                                onClick={() =>
                                  item.task === "repair-markdown"
                                    ? void prepareMarkdownPrompt()
                                    : void ask(item.prompt)
                                }
                              >
                                {item.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {paperMessages.map((message, messageIndex) => {
                        const evidence = message.citations?.find(
                          (citation) =>
                            expandedCitation ===
                            `${message.id}-${citation.page}`,
                        );
                        const canEditMessage =
                          message.role === "user" &&
                          !message.attachments?.length;
                        const isEditing =
                          canEditMessage && editingMessageId === message.id;
                        return (
                          <article
                            className={`message message-${message.role}`}
                            key={message.id}
                          >
                            <div className="message-label">
                              {message.role === "user" ? (
                                <>
                                  <MessageSquareText size={14} /> 你
                                </>
                              ) : (
                                <>
                                  <Sparkles size={14} /> PaperXcel
                                </>
                              )}
                            </div>
                            {isEditing ? (
                              <div className="message-edit-panel">
                                <textarea
                                  className="message-edit-textarea"
                                  rows={3}
                                  value={editingMessageText}
                                  placeholder="修改这轮提问"
                                  disabled={asking}
                                  onChange={(event) =>
                                    setEditingMessageText(event.target.value)
                                  }
                                  onKeyDown={(event) => {
                                    if (
                                      event.key === "Enter" &&
                                      !event.shiftKey
                                    ) {
                                      event.preventDefault();
                                      void submitMessageEdit(
                                        message,
                                        messageIndex,
                                      );
                                    }
                                    if (event.key === "Escape") {
                                      event.preventDefault();
                                      cancelEditingMessage();
                                    }
                                  }}
                                />
                                {paperReferences.length > 0 && (
                                  <div
                                    className="message-edit-references"
                                    aria-label="正在编辑的引用"
                                  >
                                    {paperReferences.map((reference) => (
                                      <div
                                        className="message-edit-reference"
                                        key={reference.id}
                                      >
                                        {referenceImageUrl(reference) ? (
                                          <img
                                            src={referenceImageUrl(reference)}
                                            alt=""
                                          />
                                        ) : (
                                          <Quote size={14} />
                                        )}
                                        <span>
                                          <strong>p.{reference.page}</strong>
                                          {reference.imageOnly
                                            ? " 图片选区"
                                            : ` ${reference.text}`}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                <div className="message-edit-actions">
                                  <button
                                    className="message-edit-cancel"
                                    type="button"
                                    disabled={asking}
                                    onClick={cancelEditingMessage}
                                  >
                                    取消
                                  </button>
                                  <button
                                    className="message-edit-submit"
                                    type="button"
                                    disabled={
                                      asking || !editingMessageText.trim()
                                    }
                                    onClick={() =>
                                      void submitMessageEdit(
                                        message,
                                        messageIndex,
                                      )
                                    }
                                  >
                                    发送
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <>
                                {message.role === "assistant" &&
                                  (message.reasoningContent ||
                                    message.processingDurationMs !==
                                      undefined) && (
                                    <ThinkingBlock
                                      content={message.reasoningContent}
                                      durationMs={message.processingDurationMs}
                                    />
                                  )}
                                <div className="message-content">
                                  {message.role === "assistant" ? (
                                    <MarkdownMessage
                                      content={message.content}
                                    />
                                  ) : (
                                    <>
                                      <div className="message-user-prompt">
                                        {extractPromptFromMessage(message)}
                                      </div>
                                      {message.attachments?.map(
                                        (attachment) => (
                                          <div
                                            className="message-user-file"
                                            key={`${message.id}-${attachment.id}`}
                                          >
                                            <FileText size={15} />
                                            <span>
                                              {getAttachmentDisplayName(
                                                attachment,
                                              )}
                                            </span>
                                            <small>
                                              {formatAttachmentSize(
                                                attachment.size,
                                              )}
                                            </small>
                                          </div>
                                        ),
                                      )}
                                      {extractReferencesFromMessage(message)
                                        .length > 0 && (
                                        <div
                                          className="message-user-references"
                                          aria-label="已发送的引用"
                                        >
                                          {extractReferencesFromMessage(
                                            message,
                                          ).map((reference, referenceIndex) => (
                                            <button
                                              className="message-user-reference"
                                              type="button"
                                              key={`${message.id}-${referenceIndex}`}
                                              title={`查看第 ${reference.page} 页引用`}
                                              onClick={() =>
                                                setCurrentPage(reference.page)
                                              }
                                            >
                                              {referenceImageUrl(reference) ? (
                                                <img
                                                  src={referenceImageUrl(
                                                    reference,
                                                  )}
                                                  alt={`第 ${reference.page} 页图片选区`}
                                                />
                                              ) : (
                                                <Quote size={14} />
                                              )}
                                              <span>
                                                p.{reference.page} ·{" "}
                                                {reference.imageOnly
                                                  ? "图片选区"
                                                  : reference.text}
                                              </span>
                                            </button>
                                          ))}
                                        </div>
                                      )}
                                    </>
                                  )}
                                </div>
                                <div
                                  className="message-actions"
                                  aria-label="消息操作"
                                >
                                  <span className="message-time">
                                    {formatMessageTime(message.createdAt)}
                                  </span>
                                  <button
                                    className={`message-action-button ${
                                      copiedMessageId === message.id
                                        ? "copied"
                                        : ""
                                    }`}
                                    type="button"
                                    title={
                                      copiedMessageId === message.id
                                        ? "已复制"
                                        : "复制"
                                    }
                                    onClick={() => void copyMessage(message)}
                                  >
                                    {copiedMessageId === message.id ? (
                                      <Check size={14} />
                                    ) : (
                                      <Copy size={14} />
                                    )}
                                  </button>
                                  {canEditMessage && (
                                    <button
                                      className="message-action-button"
                                      type="button"
                                      title="编辑"
                                      disabled={asking}
                                      onClick={() =>
                                        startEditingMessage(message)
                                      }
                                    >
                                      <Pencil size={14} />
                                    </button>
                                  )}
                                </div>
                              </>
                            )}
                            {!isEditing &&
                              message.citations &&
                              message.citations.length > 0 && (
                                <div className="citation-list">
                                  {message.citations.map((citation) => {
                                    const citationId = `${message.id}-${citation.page}`;
                                    return (
                                      <button
                                        className={
                                          expandedCitation === citationId
                                            ? "active"
                                            : ""
                                        }
                                        type="button"
                                        key={citationId}
                                        title={`跳转至第 ${citation.page} 页并查看证据`}
                                        aria-expanded={
                                          expandedCitation === citationId
                                        }
                                        onClick={() => {
                                          setCurrentPage(citation.page);
                                          setExpandedCitation((current) =>
                                            citation.excerpt &&
                                            current !== citationId
                                              ? citationId
                                              : undefined,
                                          );
                                        }}
                                      >
                                        p.{citation.page}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            {!isEditing && evidence?.excerpt && (
                              <div className="citation-evidence">
                                <div>
                                  <Quote size={13} />
                                  <strong>原文证据 · p.{evidence.page}</strong>
                                </div>
                                <p>{evidence.excerpt}</p>
                              </div>
                            )}
                          </article>
                        );
                      })}
                      {asking && (
                        <article className="message message-assistant pending-message">
                          {askReasoning && (
                            <ThinkingBlock
                              content={askReasoning}
                              durationMs={askElapsedMs}
                              isStreaming
                            />
                          )}
                          {!askReasoning && !askAnswer && (
                            <div className="pending-status" role="status">
                              <LoaderCircle className="spin" size={15} />
                              <span>{askProgress || "等待模型响应"}</span>
                              {formatProcessingDuration(askElapsedMs) && (
                                <small>
                                  {formatProcessingDuration(askElapsedMs)}
                                </small>
                              )}
                            </div>
                          )}
                          {askAnswer && (
                            <div className="message-content pending-answer-content">
                              <MarkdownMessage content={askAnswer} />
                            </div>
                          )}
                        </article>
                      )}
                    </div>
                    <div className="composer">
                      <div className="composer-context">
                        <span>当前页 p.{currentPage}</span>
                        <span>
                          {selectedPaper.fileName
                            ? "自动附带当前 PDF"
                            : selectedPaper.statusText}
                        </span>
                      </div>
                      {paperReferences.length > 0 && (
                        <div
                          className="composer-references"
                          aria-label="引用原文"
                        >
                          {paperReferences.map((reference) => (
                            <div
                              className="composer-reference"
                              key={reference.id}
                            >
                              {referenceImageUrl(reference) ? (
                                <img
                                  src={referenceImageUrl(reference)}
                                  alt=""
                                />
                              ) : (
                                <Quote size={13} />
                              )}
                              <span>
                                p.{reference.page} ·{" "}
                                {reference.imageOnly
                                  ? "图片选区"
                                  : reference.text}
                              </span>
                              <button
                                type="button"
                                title="移除引用"
                                onClick={() =>
                                  removePaperReference(reference.id)
                                }
                              >
                                <X size={13} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      {(composerAttachments.length > 0 ||
                        uploadingAttachmentCount > 0) && (
                        <div
                          className="composer-attachments"
                          aria-label="本轮对话附件"
                        >
                          {composerAttachments.map((attachment) => (
                            <div
                              className="composer-attachment"
                              key={attachment.id}
                              title={`${getAttachmentDisplayName(attachment)} · ${formatAttachmentSize(
                                attachment.size,
                              )}`}
                            >
                              <FileText size={14} />
                              <span>
                                {getAttachmentDisplayName(attachment)}
                              </span>
                              <small>
                                {formatAttachmentSize(attachment.size)}
                              </small>
                              <button
                                type="button"
                                aria-label={`移除附件 ${getAttachmentDisplayName(attachment)}`}
                                title="移除附件"
                                onClick={() =>
                                  void removeComposerAttachment(attachment)
                                }
                              >
                                <X size={13} />
                              </button>
                            </div>
                          ))}
                          {uploadingAttachmentCount > 0 && (
                            <div className="composer-uploading" role="status">
                              <LoaderCircle className="spin" size={14} />
                              正在添加 {uploadingAttachmentCount} 个附件
                            </div>
                          )}
                        </div>
                      )}
                      <div className="composer-box">
                        <textarea
                          ref={questionRef}
                          rows={3}
                          placeholder="询问研究问题、方法、数据、结果或局限"
                          disabled={selectedPaper.status !== "ready"}
                          value={question}
                          onChange={(event) => setQuestion(event.target.value)}
                          onPaste={handleChatPaste}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey) {
                              event.preventDefault();
                              void ask();
                            }
                          }}
                        />
                        <div className="composer-actions">
                          <div
                            className="composer-model-picker"
                            ref={composerMenuRef}
                          >
                            <button
                              className="composer-model-trigger"
                              type="button"
                              title="选择模型和推理强度"
                              disabled={!provider}
                              aria-haspopup="menu"
                              aria-expanded={composerMenuOpen}
                              onClick={() => {
                                closePaperActionMenu();
                                if (composerMenuOpen) {
                                  closeComposerMenu();
                                } else {
                                  setComposerMenuOpen(true);
                                }
                              }}
                            >
                              <span className="composer-model-trigger-model">
                                {provider?.model ?? "未配置模型"}
                              </span>
                              <span className="composer-model-trigger-reasoning">
                                {reasoningLabel}
                              </span>
                              <ChevronDown size={16} />
                            </button>

                            {composerMenuOpen && (
                              <div
                                className="composer-model-popover"
                                role="menu"
                                aria-label="模型设置"
                              >
                                <button
                                  className="composer-model-popover-title"
                                  type="button"
                                  onClick={closeComposerMenu}
                                >
                                  <span>高级</span>
                                  <ChevronUp size={15} />
                                </button>
                                <div className="composer-model-popover-divider" />
                                <button
                                  className={`composer-model-row ${
                                    composerMenuSection === "model"
                                      ? "active"
                                      : ""
                                  }`}
                                  type="button"
                                  role="menuitem"
                                  onClick={() =>
                                    setComposerMenuSection((current) =>
                                      current === "model" ? undefined : "model",
                                    )
                                  }
                                >
                                  <span>模型</span>
                                  <span className="composer-model-row-value">
                                    {provider?.model ?? "未配置"}
                                  </span>
                                  <ChevronRight size={17} />
                                </button>
                                <button
                                  className={`composer-model-row ${
                                    composerMenuSection === "reasoning"
                                      ? "active"
                                      : ""
                                  }`}
                                  type="button"
                                  role="menuitem"
                                  onClick={() =>
                                    setComposerMenuSection((current) =>
                                      current === "reasoning"
                                        ? undefined
                                        : "reasoning",
                                    )
                                  }
                                >
                                  <span>推理强度</span>
                                  <span className="composer-model-row-value">
                                    {reasoningLabel}
                                  </span>
                                  <ChevronRight size={17} />
                                </button>

                                {composerMenuSection === "model" && (
                                  <div
                                    className="composer-model-submenu"
                                    role="menu"
                                    aria-label="模型"
                                  >
                                    <div className="composer-model-submenu-title">
                                      模型
                                    </div>
                                    <div className="composer-model-option-list">
                                      {selectableModels.length ? (
                                        selectableModels.map((model) => (
                                          <button
                                            className={`composer-model-option ${
                                              model === provider?.model
                                                ? "selected"
                                                : ""
                                            }`}
                                            type="button"
                                            role="menuitemradio"
                                            aria-checked={
                                              model === provider?.model
                                            }
                                            key={model}
                                            onClick={() => {
                                              closeComposerMenu();
                                              void changeProviderModel(model);
                                            }}
                                          >
                                            <span>{model}</span>
                                            {model === provider?.model && (
                                              <Check size={17} />
                                            )}
                                          </button>
                                        ))
                                      ) : (
                                        <div className="composer-model-option-empty">
                                          暂无可用模型
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )}

                                {composerMenuSection === "reasoning" && (
                                  <div
                                    className="composer-model-submenu"
                                    role="menu"
                                    aria-label="推理强度"
                                  >
                                    <div className="composer-model-submenu-title">
                                      推理强度
                                    </div>
                                    <div className="composer-model-option-list">
                                      {reasoningOptions.map((option) => (
                                        <button
                                          className={`composer-model-option ${
                                            option.value === reasoningEffort
                                              ? "selected"
                                              : ""
                                          }`}
                                          type="button"
                                          role="menuitemradio"
                                          aria-checked={
                                            option.value === reasoningEffort
                                          }
                                          key={option.value}
                                          onClick={() => {
                                            setReasoningEffort(option.value);
                                            closeComposerMenu();
                                          }}
                                        >
                                          <span>{option.label}</span>
                                          {option.value === reasoningEffort && (
                                            <Check size={17} />
                                          )}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                          <button
                            className={`send-button ${asking ? "stop-button" : ""}`}
                            type="button"
                            title={asking ? "停止生成" : "发送"}
                            disabled={
                              asking
                                ? stoppingAsk
                                : !question.trim() ||
                                  selectedPaper.status !== "ready"
                            }
                            onClick={() =>
                              asking ? void stopAsking() : void ask()
                            }
                          >
                            {asking ? (
                              <Square
                                size={12}
                                fill="currentColor"
                                strokeWidth={0}
                              />
                            ) : (
                              <ArrowUp size={16} />
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div
                    className="assistant-view-panel"
                    hidden={assistantView !== "notes"}
                  >
                    <PaperNotes
                      key={selectedPaper.id}
                      paper={selectedPaper}
                      onError={setNotice}
                      onGeneratingChange={handleNoteGeneratingChange}
                    />
                  </div>
                </aside>
              )}
            </div>
          </>
        )}
      </main>

      <GlobalSelectionMenu
        onTranslate={(text) => void translateSelectedText(text)}
      />
      {translationPanel && (
        <TranslationPanel
          state={translationPanel}
          onClose={() => setTranslationPanel(undefined)}
          onCopy={(text) => {
            void window.paperxcel.clipboard
              .writeText(text)
              .then(() => setNotice("已复制到剪贴板"))
              .catch((error: unknown) =>
                setNotice(
                  error instanceof Error ? error.message : String(error),
                ),
              );
          }}
          onOpenSettings={() => {
            setTranslationPanel(undefined);
            setAppSettingsSection("translation");
            setAppSettingsOpen(true);
          }}
        />
      )}
      {notice && (
        <div className="toast">
          <CircleAlert size={17} />
          <span>{notice}</span>
          <button
            type="button"
            title="关闭"
            onClick={() => setNotice(undefined)}
          >
            <X size={15} />
          </button>
        </div>
      )}
      <AppSettingsDialog
        open={appSettingsOpen}
        onClose={() => setAppSettingsOpen(false)}
        initialSection={appSettingsSection}
        onImported={(imported, detail) => {
          if (imported.length) {
            const importedIds = new Set(imported.map((paper) => paper.id));
            setPapers((current) => [
              ...imported,
              ...current.filter((paper) => !importedIds.has(paper.id)),
            ]);
            setSelectedId(imported[0].id);
            setWorkspaceView("reader");
          }
          setNotice(detail);
        }}
      />
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onChanged={refreshProviders}
      />
      <DoiDialog
        open={doiOpen}
        onClose={() => setDoiOpen(false)}
        onAdded={(paper) => {
          setPapers((current) => [
            paper,
            ...current.filter((item) => item.id !== paper.id),
          ]);
          setSelectedId(paper.id);
          setWorkspaceView("reader");
        }}
      />
      {folderDialog && (
        <div className="dialog-backdrop">
          <form
            className="dialog folder-dialog"
            aria-modal="true"
            aria-labelledby="folder-dialog-title"
            onSubmit={(event) => {
              event.preventDefault();
              void saveFolder();
            }}
          >
            <header className="dialog-header">
              <h2 id="folder-dialog-title">
                {folderDialog.mode === "create" ? "新建文件夹" : "重命名文件夹"}
              </h2>
              <button
                className="icon-button"
                type="button"
                title="关闭"
                disabled={savingFolder}
                onClick={() => setFolderDialog(undefined)}
              >
                <X size={17} />
              </button>
            </header>
            <label className="folder-dialog-field">
              <span>文件夹名称</span>
              <input
                autoFocus
                maxLength={80}
                value={folderNameDraft}
                onChange={(event) => setFolderNameDraft(event.target.value)}
              />
            </label>
            <footer className="folder-dialog-footer">
              <button
                className="secondary-button"
                type="button"
                disabled={savingFolder}
                onClick={() => setFolderDialog(undefined)}
              >
                取消
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={savingFolder || !folderNameDraft.trim()}
              >
                {savingFolder ? "正在保存" : "保存"}
              </button>
            </footer>
          </form>
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({
  content,
  durationMs,
  isStreaming = false,
}: {
  content?: string;
  durationMs?: number;
  isStreaming?: boolean;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(isStreaming);
  const hasReasoning = Boolean(content?.trim());
  const duration = formatProcessingDuration(durationMs);
  const title = isStreaming
    ? `模型推理中${duration ? ` ${duration}` : ""}`
    : hasReasoning
      ? `模型推理${duration ? ` · ${duration}` : ""}`
      : `已处理${duration ? ` ${duration}` : ""}`;

  useEffect(() => {
    if (isStreaming) setExpanded(true);
  }, [isStreaming]);

  if (!hasReasoning) {
    return <div className="processing-duration">{title}</div>;
  }

  return (
    <section className={`thinking-block${isStreaming ? " is-streaming" : ""}`}>
      <button
        className="thinking-block-toggle"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{title}</span>
      </button>
      {expanded && (
        <div className="thinking-block-content">
          <div className="thinking-summary">
            <MarkdownMessage content={content ?? ""} />
          </div>
        </div>
      )}
    </section>
  );
}

function MarkdownMessage({ content }: { content: string }): React.JSX.Element {
  const normalizedContent = normalizeMarkdownMath(content);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
      rehypePlugins={[rehypeKatex]}
      components={{
        a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
      }}
    >
      {normalizedContent}
    </ReactMarkdown>
  );
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    /aborted|aborterror|cancelled|canceled/i.test(error.message)
  );
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    return `${Math.max(0.1, bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    if (value === "true") return true;
    if (value === "false") return false;
  } catch {
    // Local storage can be unavailable in restricted renderer contexts.
  }
  return fallback;
}

function readStoredNumber(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  try {
    const value = Number(window.localStorage.getItem(key));
    if (Number.isFinite(value)) return clampPanelWidth(value, min, max);
  } catch {
    // Local storage can be unavailable in restricted renderer contexts.
  }
  return fallback;
}

function writeStoredBoolean(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Keeping the current session usable matters more than preference storage.
  }
}

function writeStoredNumber(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Keeping the current session usable matters more than preference storage.
  }
}

function clampPanelWidth(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function statusLabel(paper: Paper): string {
  if (paper.status === "needs_file") return "待添加 PDF";
  if (paper.status === "error") return "解析失败";
  if (paper.status === "ready") return "已就绪";
  return paper.statusText || "处理中";
}
