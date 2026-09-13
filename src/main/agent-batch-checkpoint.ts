import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type {
  ProviderBatchCheckpoint,
  ProviderBatchCheckpointValue,
} from "./provider";

interface StoredCheckpointEntry extends ProviderBatchCheckpointValue {
  updatedAt: string;
}

interface StoredCheckpointNamespace {
  sourceKey: string;
  entries: Record<string, StoredCheckpointEntry>;
}

interface StoredCheckpointFile {
  version: 1;
  namespaces: Record<string, StoredCheckpointNamespace>;
}

const CHECKPOINT_FILE_NAME = "agent-checkpoints.json";
const checkpointQueues = new Map<string, Promise<void>>();

export function createAgentBatchCheckpoint(
  directory: string,
): ProviderBatchCheckpoint {
  const filePath = join(directory, CHECKPOINT_FILE_NAME);
  const transact = async <T>(operation: () => Promise<T>): Promise<T> => {
    const queue = checkpointQueues.get(filePath) ?? Promise.resolve();
    const current = queue.then(operation, operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    checkpointQueues.set(filePath, settled);
    void settled.then(() => {
      if (checkpointQueues.get(filePath) === settled)
        checkpointQueues.delete(filePath);
    });
    return current;
  };

  return {
    read: (namespace, sourceKey, index) =>
      transact(async () => {
        const stored = await readCheckpointFile(filePath);
        const group = stored.namespaces[namespace];
        if (!group || group.sourceKey !== sourceKey) return undefined;
        const entry = group.entries[String(index)];
        if (!entry?.content.trim()) return undefined;
        return { content: entry.content, protocol: entry.protocol };
      }),
    write: (namespace, sourceKey, index, value) =>
      transact(async () => {
        const stored = await readCheckpointFile(filePath);
        const current = stored.namespaces[namespace];
        const group =
          current?.sourceKey === sourceKey
            ? current
            : { sourceKey, entries: {} };
        group.entries[String(index)] = {
          ...value,
          updatedAt: new Date().toISOString(),
        };
        stored.namespaces[namespace] = group;
        await writeCheckpointFile(filePath, stored);
      }),
  };
}

async function readCheckpointFile(
  filePath: string,
): Promise<StoredCheckpointFile> {
  try {
    const parsed = JSON.parse(
      await readFile(filePath, "utf8"),
    ) as Partial<StoredCheckpointFile>;
    if (
      parsed.version === 1 &&
      parsed.namespaces &&
      typeof parsed.namespaces === "object"
    ) {
      return parsed as StoredCheckpointFile;
    }
  } catch {
    // Missing or interrupted checkpoint files are rebuilt on the next write.
  }
  return { version: 1, namespaces: {} };
}

async function writeCheckpointFile(
  filePath: string,
  value: StoredCheckpointFile,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}
