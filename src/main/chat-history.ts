import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "../shared/contracts";

const CHAT_HISTORY_FORMAT = "paperxcel-chat-history";
const CHAT_HISTORY_VERSION = 1;
const CHAT_HISTORY_FILE = "chat.json";

interface PaperChatHistoryArtifact {
  format: typeof CHAT_HISTORY_FORMAT;
  version: typeof CHAT_HISTORY_VERSION;
  paper_id: string;
  updated_at: string;
  messages: ChatMessage[];
}

export function readPaperChatHistory(
  directory: string,
  paperId: string,
): ChatMessage[] | null {
  const path = join(directory, CHAT_HISTORY_FILE);
  if (!existsSync(path)) return null;

  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isPaperChatHistoryArtifact(parsed, paperId)) {
    throw new Error(`Invalid chat history artifact for paper ${paperId}.`);
  }

  return parsed.messages;
}

export function writePaperChatHistory(
  directory: string,
  paperId: string,
  messages: ChatMessage[],
): void {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, CHAT_HISTORY_FILE);
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const artifact: PaperChatHistoryArtifact = {
    format: CHAT_HISTORY_FORMAT,
    version: CHAT_HISTORY_VERSION,
    paper_id: paperId,
    updated_at: new Date().toISOString(),
    messages,
  };

  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(artifact, null, 2)}\n`,
      "utf8",
    );
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function removePaperChatHistory(directory: string): void {
  rmSync(join(directory, CHAT_HISTORY_FILE), { force: true });
}

function isPaperChatHistoryArtifact(
  value: unknown,
  paperId: string,
): value is PaperChatHistoryArtifact {
  if (!isRecord(value)) return false;
  if (value.format !== CHAT_HISTORY_FORMAT) return false;
  if (value.version !== CHAT_HISTORY_VERSION) return false;
  if (value.paper_id !== paperId) return false;
  return Array.isArray(value.messages) && value.messages.every(isChatMessage);
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.content === "string" &&
    typeof value.createdAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
