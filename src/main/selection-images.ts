import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";

const IMAGE_DATA_URL_PREFIX = "data:image/png;base64,";
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export function selectionImageUrl(id: string): string {
  assertSelectionImageId(id);
  return `paperxcel://selection/${id}`;
}

export async function saveSelectionImage(dataUrl: string): Promise<string> {
  const encoded = dataUrl.startsWith(IMAGE_DATA_URL_PREFIX)
    ? dataUrl.slice(IMAGE_DATA_URL_PREFIX.length)
    : "";
  if (!encoded) throw new Error("Only PNG selection images are supported.");

  const data = Buffer.from(encoded, "base64");
  if (!data.length || data.length > MAX_IMAGE_BYTES) {
    throw new Error("The selection image is empty or exceeds 12 MB.");
  }
  if (
    data[0] !== 0x89 ||
    data[1] !== 0x50 ||
    data[2] !== 0x4e ||
    data[3] !== 0x47
  ) {
    throw new Error("The selection image is not a valid PNG.");
  }

  const id = crypto.randomUUID();
  await mkdir(selectionImageDirectory(), { recursive: true });
  await writeFile(selectionImagePath(id), data, { flag: "wx" });
  return id;
}

export async function readSelectionImageDataUrl(
  id: string,
): Promise<string | undefined> {
  try {
    const data = await readFile(selectionImagePath(id));
    return `${IMAGE_DATA_URL_PREFIX}${data.toString("base64")}`;
  } catch {
    return undefined;
  }
}

export async function removeSelectionImages(
  ids: Iterable<string>,
): Promise<void> {
  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      try {
        await rm(selectionImagePath(id), { force: true });
      } catch {
        // Missing or already-cleaned images do not affect chat history.
      }
    }),
  );
}

export function selectionImagePath(id: string): string {
  assertSelectionImageId(id);
  return join(selectionImageDirectory(), `${id}.png`);
}

function selectionImageDirectory(): string {
  return join(app.getPath("userData"), "selection-images");
}

function assertSelectionImageId(id: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  ) {
    throw new Error("Invalid selection image id.");
  }
}
