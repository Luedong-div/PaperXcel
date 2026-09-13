import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";

const MAX_NATIVE_PDF_PAGE_BYTES = 50 * 1024 * 1024;

class PdfPageSizeError extends Error {}

export interface PaperPdfPage {
  /** One-based page number in the original paper. */
  page: number;
  /** A real one-page PDF, including the original graphics and font resources. */
  dataUrl: string;
  fileName: string;
}

export interface PaperPdfPages {
  pageCount: number;
  /** SHA-256 of the original PDF bytes, not extracted text or a previous export. */
  sourceHash: string;
  readPage(page: number): Promise<PaperPdfPage>;
  readRange(startPage: number, endPage: number): Promise<PaperPdfRange>;
  /** Release the loaded source; outstanding reads are prevented from returning. */
  dispose(): void;
}

export interface PaperPdfRange {
  startPage: number;
  endPage: number;
  dataUrl: string;
  fileName: string;
}

/** Copy native PDF pages lazily. No text extraction, OCR or Markdown input. */
export async function openPaperPdfPages(
  pdfPath: string,
  signal?: AbortSignal,
): Promise<PaperPdfPages> {
  signal?.throwIfAborted();
  let bytes: Buffer;
  try {
    bytes = await readFile(pdfPath, { signal });
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error("无法读取原始 PDF，请确认文件存在且可访问。", {
      cause: error,
    });
  }
  signal?.throwIfAborted();
  // The PDF header may follow a short binary prefix, but arbitrary text is not PDF.
  if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
    throw new Error("原始文件不是有效的 PDF，无法逐页生成 Markdown。");
  }
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  let document: PDFDocument | undefined;
  let pageCount: number;
  try {
    document = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
    signal?.throwIfAborted();
    pageCount = document.getPageCount();
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && /encrypt|password/i.test(error.message)) {
      throw new Error("原始 PDF 受密码保护，请先解锁后再生成 Markdown。", {
        cause: error,
      });
    }
    throw new Error("原始 PDF 已损坏或无法解析，无法逐页生成 Markdown。", {
      cause: error,
    });
  }
  signal?.throwIfAborted();
  if (!pageCount) throw new Error("原始 PDF 没有可读取的页面。");
  let disposed = false;
  const check = (): PDFDocument => {
    signal?.throwIfAborted();
    if (disposed || !document) throw new Error("原始 PDF 页面读取器已关闭。");
    return document;
  };
  const readRange = async (
    startPage: number,
    endPage: number,
  ): Promise<PaperPdfRange> => {
    const source = check();
    if (
      !Number.isSafeInteger(startPage) ||
      !Number.isSafeInteger(endPage) ||
      startPage < 1 ||
      endPage < startPage ||
      endPage > pageCount
    ) {
      throw new Error(`PDF 页码必须是 1 到 ${pageCount} 之间的整数。`);
    }
    if (endPage - startPage + 1 > 10)
      throw new Error("每个 PDF 批次最多包含 10 页。");
    try {
      const output = await PDFDocument.create();
      check();
      const copied = await output.copyPages(
        source,
        Array.from(
          { length: endPage - startPage + 1 },
          (_, index) => startPage + index - 1,
        ),
      );
      check();
      for (const page of copied) output.addPage(page);
      const data = await output.save();
      check();
      if (data.byteLength > MAX_NATIVE_PDF_PAGE_BYTES) {
        throw new PdfPageSizeError(
          `原始 PDF 第 ${startPage === endPage ? startPage : `${startPage}–${endPage}`} 页拆分后为 ${(data.byteLength / 1024 / 1024).toFixed(2)} MiB，超过${startPage === endPage ? "单页" : "批次"} PDF 输入的 50 MiB 上限。请先压缩这些页面的图像后重试。`,
        );
      }
      return {
        startPage,
        endPage,
        fileName: `paper-pages-${startPage}-${endPage}.pdf`,
        dataUrl: `data:application/pdf;base64,${Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64")}`,
      };
    } catch (error) {
      // Cancellation and disposal must not be disguised as PDF corruption.
      check();
      if (error instanceof PdfPageSizeError) throw error;
      throw new Error(`无法从原始 PDF 读取第 ${startPage}–${endPage} 页。`, {
        cause: error,
      });
    }
  };
  return {
    pageCount,
    sourceHash,
    readRange,
    async readPage(page) {
      const result = await readRange(page, page);
      return {
        page,
        dataUrl: result.dataUrl,
        fileName: `paper-page-${page}.pdf`,
      };
    },
    dispose() {
      disposed = true;
      document = undefined;
    },
  };
}
