import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** An interrupted write must never truncate the currently usable paper artifact. */
export async function writeCancellableUtf8(
  path: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await writeFile(path, content, "utf8");
    return;
  }
  signal.throwIfAborted();
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, content, {
      encoding: "utf8",
      signal,
      flag: "wx",
    });
    signal.throwIfAborted();
    await rename(temporaryPath, path);
  } finally {
    try {
      await rm(temporaryPath, { force: true });
    } catch {
      /* Cleanup must not hide the original storage or cancellation error. */
    }
  }
}
