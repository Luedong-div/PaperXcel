import { app, safeStorage } from "electron";
import Store from "electron-store";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  emptyCitationGraphCache,
  type CitationGraphCache,
} from "../shared/citationGraph";
import { normalizeZoteroUserLibraryId } from "../shared/zotero";
import type {
  ChatMessage,
  ComparisonReport,
  CreateLibraryFolderInput,
  LibraryFolder,
  LibraryFolderRemovalResult,
  Paper,
  PaperNote,
  OpenAlexConfig,
  OpenAlexConfigInput,
  ProviderProfile,
  ProviderProfileInput,
  ProviderProtocol,
  TranslationConfig,
  TranslationConfigInput,
  ZoteroConfig,
  ZoteroConfigInput,
} from "../shared/contracts";

interface StoredProvider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  protocol: ProviderProtocol;
  encryptedApiKey?: string;
}

interface StoredZoteroConfig {
  mode: ZoteroConfig["mode"];
  libraryType: ZoteroConfig["libraryType"];
  libraryId: string;
  collection: string;
  dataDir: string;
  encryptedApiKey?: string;
}

interface StoredOpenAlexConfig {
  encryptedApiKey?: string;
}

interface StoredTranslationConfig {
  encryptedAppId?: string;
  encryptedSecretKey?: string;
}

interface StoreSchema {
  papers: Paper[];
  paperOrder: string[];
  folders: LibraryFolder[];
  chats: Record<string, ChatMessage[]>;
  notes: Record<string, PaperNote>;
  comparisons: ComparisonReport[];
  providers: StoredProvider[];
  activeProviderId: string;
  // 用户是否已接受免责声明并启用 Sci-Hub 兜底下载。
  scihubEnabled: boolean;
  zotero: StoredZoteroConfig;
  openAlex: StoredOpenAlexConfig;
  citationGraph: CitationGraphCache;
  translation: StoredTranslationConfig;
}

const DEFAULT_PROVIDER_ID = "openai";
const MAX_CHAT_MESSAGES = 200;
const MAX_NOTE_LENGTH = 200_000;
const MAX_COMPARISON_REPORTS = 50;

export class AppStore {
  private readonly store: Store<StoreSchema>;

  constructor() {
    this.store = new Store<StoreSchema>({
      name: "paperxcel",
      defaults: {
        papers: [],
        paperOrder: [],
        folders: [],
        chats: {},
        notes: {},
        comparisons: [],
        providers: [
          {
            id: DEFAULT_PROVIDER_ID,
            name: "OpenAI",
            baseUrl: "https://api.openai.com/v1",
            model: "gpt-5.4-mini",
            protocol: "responses",
          },
        ],
        activeProviderId: DEFAULT_PROVIDER_ID,
        scihubEnabled: false,
        zotero: {
          mode: "local",
          libraryType: "user",
          libraryId: "",
          collection: "",
          dataDir: "",
        },
        openAlex: {},
        citationGraph: emptyCitationGraphCache(),
        translation: {},
      },
    });
  }

  listPapers(): Paper[] {
    const paperOrder = this.store.get("paperOrder");
    if (!paperOrder.length) {
      return [...this.store.get("papers")].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );
    }

    const orderById = new Map(paperOrder.map((id, index) => [id, index]));
    return [...this.store.get("papers")].sort((a, b) => {
      const aIndex = orderById.get(a.id);
      const bIndex = orderById.get(b.id);
      if (aIndex !== undefined && bIndex !== undefined) return aIndex - bIndex;
      if (aIndex !== undefined) return -1;
      if (bIndex !== undefined) return 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }

  getPaper(id: string): Paper | undefined {
    return this.store.get("papers").find((paper) => paper.id === id);
  }

  savePaper(paper: Paper): Paper {
    const papers = this.store.get("papers");
    const index = papers.findIndex((item) => item.id === paper.id);
    const next = [...papers];
    if (index >= 0) next[index] = paper;
    else {
      next.push(paper);
      this.store.set("paperOrder", [
        paper.id,
        ...this.store.get("paperOrder").filter((id) => id !== paper.id),
      ]);
    }
    this.store.set("papers", next);
    return paper;
  }

  reorderPapers(paperIds: string[]): Paper[] {
    const existingIds = new Set(
      this.store.get("papers").map((paper) => paper.id),
    );
    const seenIds = new Set<string>();
    const orderedIds = paperIds.filter((id) => {
      if (!existingIds.has(id) || seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });
    const missingIds = this.listPapers()
      .map((paper) => paper.id)
      .filter((id) => !seenIds.has(id));
    this.store.set("paperOrder", [...orderedIds, ...missingIds]);
    return this.listPapers();
  }

  setPaperArchived(id: string, archived: boolean): Paper {
    const paper = this.getPaper(id);
    if (!paper) throw new Error("Paper not found.");
    return this.savePaper({
      ...paper,
      archived,
      updatedAt: new Date().toISOString(),
    });
  }

  listFolders(): LibraryFolder[] {
    return [...this.store.get("folders")].sort((a, b) => {
      const byCreatedAt = a.createdAt.localeCompare(b.createdAt);
      return byCreatedAt || a.name.localeCompare(b.name);
    });
  }

  createFolder(input: CreateLibraryFolderInput): LibraryFolder {
    const folders = this.store.get("folders");
    const parentId = this.resolveFolderId(input.parentId);
    const name = normalizeFolderName(input.name);
    this.assertFolderNameAvailable(name, parentId);
    const now = new Date().toISOString();
    const folder: LibraryFolder = {
      id: crypto.randomUUID(),
      name,
      parentId,
      createdAt: now,
      updatedAt: now,
    };
    this.store.set("folders", [...folders, folder]);
    return folder;
  }

  renameFolder(id: string, nameInput: string): LibraryFolder {
    const folders = this.store.get("folders");
    const existing = folders.find((folder) => folder.id === id);
    if (!existing) throw new Error("Folder not found.");
    const name = normalizeFolderName(nameInput);
    this.assertFolderNameAvailable(name, existing.parentId, id);
    const updated: LibraryFolder = {
      ...existing,
      name,
      updatedAt: new Date().toISOString(),
    };
    this.store.set(
      "folders",
      folders.map((folder) => (folder.id === id ? updated : folder)),
    );
    return updated;
  }

  removeFolder(id: string): LibraryFolderRemovalResult {
    const folders = this.store.get("folders");
    const folder = folders.find((item) => item.id === id);
    if (!folder) throw new Error("Folder not found.");

    const now = new Date().toISOString();
    const nextFolders = folders
      .filter((item) => item.id !== id)
      .map((item) =>
        item.parentId === id
          ? { ...item, parentId: folder.parentId, updatedAt: now }
          : item,
      );
    const reassignedPapers = this.store
      .get("papers")
      .map((paper) =>
        paper.folderId === id
          ? { ...paper, folderId: folder.parentId, updatedAt: now }
          : paper,
      );
    this.store.set("folders", nextFolders);
    this.store.set("papers", reassignedPapers);
    return {
      folders: this.listFolders(),
      papers: reassignedPapers.filter(
        (paper) => paper.folderId === folder.parentId,
      ),
    };
  }

  movePaperToFolder(id: string, folderId?: string): Paper {
    const paper = this.getPaper(id);
    if (!paper) throw new Error("Paper not found.");
    const resolvedFolderId = this.resolveFolderId(folderId);
    if (paper.folderId === resolvedFolderId) return paper;
    return this.savePaper({
      ...paper,
      folderId: resolvedFolderId,
      updatedAt: new Date().toISOString(),
    });
  }

  private resolveFolderId(folderId?: string): string | undefined {
    if (!folderId) return undefined;

    if (!this.store.get("folders").some((folder) => folder.id === folderId)) {
      throw new Error("Folder not found.");
    }

    return folderId;
  }

  private assertFolderNameAvailable(
    name: string,

    parentId?: string,

    ignoredFolderId?: string,
  ): void {
    const normalizedName = name.toLocaleLowerCase();

    const exists = this.store
      .get("folders")
      .some(
        (folder) =>
          folder.id !== ignoredFolderId &&
          folder.parentId === parentId &&
          folder.name.toLocaleLowerCase() === normalizedName,
      );

    if (exists) {
      throw new Error("已经存在同名文件夹。");
    }
  }

  removePaper(id: string): void {
    this.store.set(
      "papers",
      this.store.get("papers").filter((paper) => paper.id !== id),
    );
    this.store.set(
      "paperOrder",
      this.store.get("paperOrder").filter((paperId) => paperId !== id),
    );
    const chats = { ...this.store.get("chats") };
    delete chats[id];
    this.store.set("chats", chats);
    const notes = { ...this.store.get("notes") };
    delete notes[id];
    this.store.set("notes", notes);
    this.store.set(
      "comparisons",
      this.store
        .get("comparisons")
        .filter((report) => !report.paperIds.includes(id)),
    );
  }

  listChatMessages(paperId: string): ChatMessage[] {
    return (this.store.get("chats")[paperId] ?? []).map(cloneChatMessage);
  }

  appendChatMessage(paperId: string, message: ChatMessage): ChatMessage[] {
    if (!this.getPaper(paperId)) throw new Error("文献不存在。");
    const chats = this.store.get("chats");
    const next = [
      ...(chats[paperId] ?? []).map(cloneChatMessage),
      cloneChatMessage(message),
    ].slice(-MAX_CHAT_MESSAGES);
    this.store.set("chats", { ...chats, [paperId]: next });
    return next.map(cloneChatMessage);
  }

  clearChatMessages(paperId: string): void {
    const chats = { ...this.store.get("chats") };
    delete chats[paperId];
    this.store.set("chats", chats);
  }

  replaceChatMessages(paperId: string, messages: ChatMessage[]): ChatMessage[] {
    if (!this.getPaper(paperId)) throw new Error("Paper does not exist.");
    const chats = this.store.get("chats");
    const next = messages.map(cloneChatMessage).slice(-MAX_CHAT_MESSAGES);
    this.store.set("chats", { ...chats, [paperId]: next });
    return next.map(cloneChatMessage);
  }

  getPaperNote(paperId: string): PaperNote | null {
    const note = this.store.get("notes")[paperId];
    return note ? { ...note } : null;
  }

  savePaperNote(paperId: string, content: string): PaperNote {
    if (!this.getPaper(paperId)) throw new Error("文献不存在。");
    if (content.length > MAX_NOTE_LENGTH) {
      throw new Error("单篇文献笔记不能超过 200,000 个字符。");
    }
    const note: PaperNote = {
      paperId,
      content,
      updatedAt: new Date().toISOString(),
    };
    this.store.set("notes", {
      ...this.store.get("notes"),
      [paperId]: note,
    });
    return { ...note };
  }

  listComparisonReports(): ComparisonReport[] {
    return this.store
      .get("comparisons")
      .map(cloneComparisonReport)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getComparisonReport(id: string): ComparisonReport | undefined {
    const report = this.store.get("comparisons").find((item) => item.id === id);
    return report ? cloneComparisonReport(report) : undefined;
  }

  saveComparisonReport(report: ComparisonReport): ComparisonReport {
    if (report.paperIds.some((paperId) => !this.getPaper(paperId))) {
      throw new Error("比较报告包含已移除的文献。");
    }
    const reports = this.store
      .get("comparisons")
      .filter((item) => item.id !== report.id);
    const next = [cloneComparisonReport(report), ...reports].slice(
      0,
      MAX_COMPARISON_REPORTS,
    );
    this.store.set("comparisons", next);
    return cloneComparisonReport(report);
  }

  removeComparisonReport(id: string): void {
    this.store.set(
      "comparisons",
      this.store.get("comparisons").filter((report) => report.id !== id),
    );
  }

  listProviders(): ProviderProfile[] {
    const activeProviderId = this.store.get("activeProviderId");
    return this.store.get("providers").map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      protocol: provider.protocol,
      hasApiKey: Boolean(provider.encryptedApiKey),
      isActive: provider.id === activeProviderId,
    }));
  }

  saveProvider(input: ProviderProfileInput): ProviderProfile {
    const providers = this.store.get("providers");
    const existing = input.id
      ? providers.find((provider) => provider.id === input.id)
      : undefined;
    const id = existing?.id ?? crypto.randomUUID();
    const encryptedApiKey =
      input.apiKey && input.apiKey.trim()
        ? this.encryptSecret(input.apiKey.trim())
        : existing?.encryptedApiKey;
    const stored: StoredProvider = {
      id,
      name: input.name.trim(),
      baseUrl: normalizeBaseUrl(input.baseUrl),
      model: input.model.trim(),
      protocol: input.protocol,
      encryptedApiKey,
    };
    const next = existing
      ? providers.map((provider) => (provider.id === id ? stored : provider))
      : [...providers, stored];
    this.store.set("providers", next);
    if (!this.store.get("activeProviderId")) {
      this.store.set("activeProviderId", id);
    }
    return this.listProviders().find((provider) => provider.id === id)!;
  }

  removeProvider(id: string): void {
    const providers = this.store
      .get("providers")
      .filter((provider) => provider.id !== id);
    if (providers.length === 0) {
      throw new Error("至少需要保留一个模型供应商。");
    }
    this.store.set("providers", providers);
    if (this.store.get("activeProviderId") === id) {
      this.store.set("activeProviderId", providers[0].id);
    }
  }

  setActiveProvider(id: string): void {
    if (!this.store.get("providers").some((provider) => provider.id === id)) {
      throw new Error("模型供应商不存在。");
    }
    this.store.set("activeProviderId", id);
  }

  getActiveProvider(): StoredProvider & { apiKey: string } {
    const id = this.store.get("activeProviderId");
    return this.getProviderCredentials(id);
  }

  getProviderCredentials(id: string): StoredProvider & { apiKey: string } {
    const provider = this.store.get("providers").find((item) => item.id === id);
    if (!provider) throw new Error("请先配置模型供应商。");
    if (!provider.encryptedApiKey) {
      throw new Error(`请先为 ${provider.name} 配置 API Key。`);
    }
    return {
      ...provider,
      apiKey: this.decryptSecret(provider.encryptedApiKey),
    };
  }

  getScihubEnabled(): boolean {
    return this.store.get("scihubEnabled");
  }

  setScihubEnabled(enabled: boolean): boolean {
    this.store.set("scihubEnabled", enabled);
    return enabled;
  }

  getTranslationConfig(): TranslationConfig {
    const translation = this.store.get("translation");
    return {
      hasAppId: Boolean(
        translation.encryptedAppId ||
        process.env.PAPERXCEL_BAIDU_TRANSLATION_APP_ID?.trim(),
      ),
      hasSecretKey: Boolean(
        translation.encryptedSecretKey ||
        process.env.PAPERXCEL_BAIDU_TRANSLATION_SECRET_KEY?.trim(),
      ),
    };
  }

  saveTranslationConfig(input: TranslationConfigInput): TranslationConfig {
    const existing = this.store.get("translation");
    this.store.set("translation", {
      encryptedAppId: input.appId?.trim()
        ? this.encryptSecret(input.appId.trim())
        : existing.encryptedAppId,
      encryptedSecretKey: input.secretKey?.trim()
        ? this.encryptSecret(input.secretKey.trim())
        : existing.encryptedSecretKey,
    });
    return this.getTranslationConfig();
  }

  resolveTranslationCredentials(input?: TranslationConfigInput): {
    appId: string;
    secretKey: string;
  } {
    const translation = this.store.get("translation");
    const appId =
      input?.appId?.trim() ||
      process.env.PAPERXCEL_BAIDU_TRANSLATION_APP_ID?.trim() ||
      (translation.encryptedAppId
        ? this.decryptSecret(translation.encryptedAppId)
        : "");
    const secretKey =
      input?.secretKey?.trim() ||
      process.env.PAPERXCEL_BAIDU_TRANSLATION_SECRET_KEY?.trim() ||
      (translation.encryptedSecretKey
        ? this.decryptSecret(translation.encryptedSecretKey)
        : "");
    return { appId, secretKey };
  }

  getOpenAlexConfig(): OpenAlexConfig {
    return {
      hasApiKey: Boolean(
        this.store.get("openAlex").encryptedApiKey ||
        process.env.PAPERXCEL_OPENALEX_API_KEY?.trim(),
      ),
    };
  }

  saveOpenAlexConfig(input: OpenAlexConfigInput): OpenAlexConfig {
    const existing = this.store.get("openAlex");
    this.store.set("openAlex", {
      encryptedApiKey: input.apiKey?.trim()
        ? this.encryptSecret(input.apiKey.trim())
        : existing.encryptedApiKey,
    });
    return this.getOpenAlexConfig();
  }

  resolveOpenAlexApiKey(input?: OpenAlexConfigInput): string {
    if (input?.apiKey?.trim()) return input.apiKey.trim();
    if (process.env.PAPERXCEL_OPENALEX_API_KEY?.trim()) {
      return process.env.PAPERXCEL_OPENALEX_API_KEY.trim();
    }
    const encrypted = this.store.get("openAlex").encryptedApiKey;
    return encrypted ? this.decryptSecret(encrypted) : "";
  }

  getCitationGraphCache(): CitationGraphCache {
    const cache = this.store.get("citationGraph");
    return {
      works: Object.fromEntries(
        Object.entries(cache.works).map(([id, work]) => [
          id,
          {
            ...work,
            authors: [...work.authors],
            referencedOpenAlexIds: [...work.referencedOpenAlexIds],
          },
        ]),
      ),
      cores: Object.fromEntries(
        Object.entries(cache.cores).map(([paperId, core]) => [
          paperId,
          {
            ...core,
            referencedOpenAlexIds: [...core.referencedOpenAlexIds],
            citingOpenAlexIds: [...core.citingOpenAlexIds],
          },
        ]),
      ),
      updatedAt: cache.updatedAt,
    };
  }

  saveCitationGraphCache(cache: CitationGraphCache): CitationGraphCache {
    this.store.set("citationGraph", cache);
    return this.getCitationGraphCache();
  }

  getZoteroConfig(): ZoteroConfig {
    const config = this.store.get("zotero");
    return {
      mode: config.mode,
      libraryType: config.libraryType,
      libraryId: config.libraryId,
      collection: config.collection,
      dataDir: config.dataDir,
      hasApiKey: Boolean(config.encryptedApiKey),
    };
  }

  saveZoteroConfig(input: ZoteroConfigInput): ZoteroConfig {
    const existing = this.store.get("zotero");
    const libraryId =
      input.libraryType === "user"
        ? normalizeZoteroUserLibraryId(input.libraryId)
        : input.libraryId.trim();
    const encryptedApiKey = input.apiKey?.trim()
      ? this.encryptSecret(input.apiKey.trim())
      : existing.encryptedApiKey;
    this.store.set("zotero", {
      mode: input.mode,
      libraryType: input.libraryType,
      libraryId,
      collection: input.collection.trim(),
      dataDir: input.dataDir.trim(),
      encryptedApiKey,
    });
    return this.getZoteroConfig();
  }

  resolveZoteroConfig(
    input: ZoteroConfigInput,
  ): ZoteroConfigInput & { apiKey: string } {
    const libraryId =
      input.libraryType === "user"
        ? normalizeZoteroUserLibraryId(input.libraryId)
        : input.libraryId.trim();
    const apiKey =
      input.apiKey?.trim() ||
      (this.store.get("zotero").encryptedApiKey
        ? this.decryptSecret(this.store.get("zotero").encryptedApiKey!)
        : "");
    if (input.mode === "web" && !libraryId) {
      throw new Error("Zotero Web API 需要填写用户 ID 或群组 ID。");
    }
    if (input.mode === "web" && !apiKey) {
      throw new Error("Zotero Web API 需要填写 API Key。");
    }
    return {
      ...input,
      libraryId,
      collection: input.collection.trim(),
      dataDir: input.dataDir.trim(),
      apiKey,
    };
  }

  resolvePaperPath(id: string): string | null {
    const paper = this.getPaper(id);
    if (!paper?.fileName) return null;
    const directory = join(app.getPath("userData"), "library", id);
    const candidates = [
      join(directory, paper.fileName),
      join(directory, "source.pdf"),
    ];
    return candidates.find((filePath) => existsSync(filePath)) ?? null;
  }

  private encryptSecret(secret: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "当前系统凭据加密不可用，PaperXcel 不会明文保存 API Key。",
      );
    }
    return safeStorage.encryptString(secret).toString("base64");
  }

  private decryptSecret(secret: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("当前系统凭据加密不可用。");
    }
    return safeStorage.decryptString(Buffer.from(secret, "base64"));
  }
}

function normalizeFolderName(input: string): string {
  const name = input.trim().replace(/\s+/g, " ");

  if (!name) throw new Error("Folder name is required.");

  if (name.length > 120) {
    throw new Error("Folder names cannot exceed 120 characters.");
  }

  return name;
}

function cloneChatMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    selectedSnippets: message.selectedSnippets?.map((snippet) => ({
      ...snippet,
    })),
    citations: message.citations?.map((citation) => ({ ...citation })),
  };
}

function cloneComparisonReport(report: ComparisonReport): ComparisonReport {
  return {
    ...report,
    paperIds: [...report.paperIds],
    citations: report.citations.map((citation) => ({ ...citation })),
  };
}

export function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  const parsed = new URL(normalized);
  const isLocal =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1";
  if (
    parsed.protocol !== "https:" &&
    !(isLocal && parsed.protocol === "http:")
  ) {
    throw new Error("Base URL 必须使用 HTTPS；仅本机地址允许 HTTP。");
  }
  return normalized;
}
