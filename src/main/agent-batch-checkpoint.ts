import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

export function createAgentBatchCheckpoint(
  directory: string,
): ProviderBatchCheckpoint {
  const filePath = join(directory, CHECKPOINT_FILE_NAME);
  let queue = Promise.resolve();

  const transact = async <T>(operation: () => Promise<T>): Promise<T> => {
    const current = queue.then(operation, operation);
    queue = current.then(
      () => undefined,
      () => undefined,
    );
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

export const createPaperAgentBatchCheckpoint = createAgentBatchCheckpoint;

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
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}
