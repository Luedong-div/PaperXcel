import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type {
  ChatAttachment,
  ChatAttachmentKind,
  ChatAttachmentSource,
} from "../shared/contracts";

const MAX_CHAT_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const ATTACHMENT_ID_PATTERN = /^[0-9a-f-]{36}$/i;

const MIME_TYPES: Record<string, string> = {
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".rtf": "application/rtf",
  ".tex": "application/x-tex",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

export interface SaveChatAttachmentOptions {
  paperId?: string;
  pageCount?: number;
  source?: ChatAttachmentSource;
  fileName?: string;
  mimeType?: string;
}

export interface ResolvedChatAttachment {
  attachment: ChatAttachment;
  filePath: string;
}

export interface SaveChatAttachmentDataInput {
  fileName: string;
  mimeType?: string;
  data: Uint8Array;
}

export async function saveChatAttachment(
  userDataPath: string,
  sourcePath: string,
  options: SaveChatAttachmentOptions = {},
): Promise<ChatAttachment> {
  const absoluteSourcePath = resolve(sourcePath);
  const sourceInfo = await stat(absoluteSourcePath);
  if (!sourceInfo.isFile()) throw new Error("附件不是有效的本机文件。");
  if (sourceInfo.size <= 0) throw new Error("不能上传空文件。");
  if (sourceInfo.size > MAX_CHAT_ATTACHMENT_BYTES) {
    throw new Error("单个附件不能超过 50 MB。");
  }

  const attachment = createChatAttachment(
    options.fileName || basename(absoluteSourcePath),
    sourceInfo.size,
    options,
  );
  const directory = attachmentDirectory(userDataPath, attachment.id);
  await mkdir(directory, { recursive: true });
  try {
    await copyFile(
      absoluteSourcePath,
      join(directory, attachment.fileName),
    );
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return attachment;
}

export async function saveChatAttachmentData(
  userDataPath: string,
  input: SaveChatAttachmentDataInput,
  options: SaveChatAttachmentOptions = {},
): Promise<ChatAttachment> {
  const bytes = normalizeAttachmentData(input.data);
  if (bytes.byteLength <= 0) throw new Error("不能上传空文件。");
  if (bytes.byteLength > MAX_CHAT_ATTACHMENT_BYTES) {
    throw new Error("单个附件不能超过 50 MB。");
  }

  const attachment = createChatAttachment(input.fileName, bytes.byteLength, {
    ...options,
    mimeType: input.mimeType || options.mimeType,
  });
  const directory = attachmentDirectory(userDataPath, attachment.id);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(join(directory, attachment.fileName), bytes);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return attachment;
}

export async function resolveChatAttachment(
  userDataPath: string,
  attachment: ChatAttachment,
): Promise<ResolvedChatAttachment> {
  validateAttachmentId(attachment.id);
  const safeName = sanitizeFileName(attachment.fileName);
  if (safeName !== attachment.fileName) {
    throw new Error("附件文件名无效。");
  }
  const filePath = join(
    attachmentDirectory(userDataPath, attachment.id),
    safeName,
  );
  const info = await stat(filePath);
  if (!info.isFile() || info.size !== attachment.size) {
    throw new Error(`附件 ${attachment.fileName} 已丢失或发生变化。`);
  }
  return { attachment: { ...attachment }, filePath };
}

export async function removeChatAttachment(
  userDataPath: string,
  attachmentId: string,
): Promise<boolean> {
  validateAttachmentId(attachmentId);
  await rm(attachmentDirectory(userDataPath, attachmentId), {
    recursive: true,
    force: true,
  });
  return true;
}

export async function readChatAttachmentDataUrl(
  resolvedAttachment: ResolvedChatAttachment,
): Promise<string> {
  const data = await readFile(resolvedAttachment.filePath);
  return `data:${resolvedAttachment.attachment.mimeType};base64,${data.toString("base64")}`;
}

function attachmentDirectory(
  userDataPath: string,
  attachmentId: string,
): string {
  validateAttachmentId(attachmentId);
  return join(userDataPath, "chat-attachments", attachmentId);
}

function validateAttachmentId(attachmentId: string): void {
  if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) {
    throw new Error("附件 ID 无效。");
  }
}

function sanitizeFileName(value: string): string {
  const name = basename(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return name.slice(0, 180) || "attachment";
}

function normalizeMimeType(value?: string): string {
  const mimeType = value?.trim().toLowerCase() ?? "";
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mimeType) ? mimeType : "";
}

function createChatAttachment(
  fileNameValue: string,
  size: number,
  options: SaveChatAttachmentOptions,
): ChatAttachment {
  const fileName = sanitizeFileName(fileNameValue);
  const extension = extname(fileName).toLowerCase();
  const mimeType =
    normalizeMimeType(options.mimeType) ||
    MIME_TYPES[extension] ||
    "application/octet-stream";
  return {
    id: randomUUID(),
    fileName,
    mimeType,
    size,
    kind: inferAttachmentKind(extension, mimeType),
    source: options.source ?? "uploaded",
    paperId: options.paperId,
    pageCount: options.pageCount,
  };
}

function normalizeAttachmentData(value: Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error("附件数据无效。");
}

function inferAttachmentKind(
  extension: string,
  mimeType: string,
): ChatAttachmentKind {
  if (extension === ".pdf" || mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("image/")) return "image";
  if (
    mimeType.startsWith("text/") ||
    ["application/json", "application/xml", "application/yaml"].includes(
      mimeType,
    )
  ) {
    return "text";
  }
  if (
    [
      ".doc",
      ".docx",
      ".ppt",
      ".pptx",
      ".rtf",
      ".xls",
      ".xlsx",
    ].includes(extension)
  ) {
    return "document";
  }
  return "other";
}
