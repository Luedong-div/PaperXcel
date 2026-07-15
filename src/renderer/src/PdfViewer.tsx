import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  FileWarning,
  Languages,
  LoaderCircle,
  Minus,
  Plus,
  Quote,
  ScanLine,
} from "lucide-react";
import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import type { PDFDocumentProxy, RenderTask, TextLayer } from "pdfjs-dist";
import {
  createSelectionRect,
  hasSelectionArea,
  type SelectionPoint,
  type SelectionRect,
} from "./pdfSelection";
import { nextPdfZoom, PDF_MAX_ZOOM, PDF_MIN_ZOOM } from "./pdfZoom";
import {
  DocumentViewToggle,
  type DocumentViewMode,
} from "./DocumentViewToggle";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

function getStandardFontDataUrl(): string {
  if (window.location.protocol === "file:") {
    return new URL("./pdfjs/standard_fonts/", document.baseURI).toString();
  }
  return new URL("/pdfjs/standard_fonts/", window.location.origin).toString();
}

function getWasmUrl(): string {
  if (window.location.protocol === "file:") {
    return new URL("./pdfjs/wasm/", document.baseURI).toString();
  }
  return new URL("/pdfjs/wasm/", window.location.origin).toString();
}

export interface PdfTextSelection {
  text: string;
  page: number;
  imageDataUrl?: string;
  imageOnly?: boolean;
}

interface PdfViewerProps {
  url: string;
  page: number;
  viewMode?: DocumentViewMode;
  onViewModeChange?: (viewMode: DocumentViewMode) => void;
  onPageChange: (page: number) => void;
  onTextSelection?: (selection?: PdfTextSelection) => void;
  onReferenceSelection?: (selection: PdfTextSelection) => void;
  onTranslateSelection?: (selection: PdfTextSelection) => void;
}

export function PdfViewer({
  url,
  page: requestedPage,
  viewMode = "pdf",
  onViewModeChange,
  onPageChange,
  onTextSelection,
  onReferenceSelection,
  onTranslateSelection,
}: PdfViewerProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageSurfaceRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const textLayerRenderRef = useRef<TextLayer | null>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(requestedPage);
  const [zoom, setZoom] = useState(1);
  const [blockSelectMode, setBlockSelectMode] = useState(false);
  const [blockSelection, setBlockSelection] = useState<SelectionRect>();
  const [confirmedBlockSelection, setConfirmedBlockSelection] =
    useState<SelectionRect>();
  const blockSelectionStartRef = useRef<SelectionPoint | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectionMenu, setSelectionMenu] = useState<
    (PdfTextSelection & { left: number; top: number }) | undefined
  >();

  const clearFloatingSelection = useCallback((): void => {
    setSelectionMenu(undefined);
    setConfirmedBlockSelection(undefined);
    onTextSelection?.(undefined);
    window.getSelection()?.removeAllRanges();
  }, [onTextSelection]);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError("");
    const task = pdfjs.getDocument({
      url,
      standardFontDataUrl: getStandardFontDataUrl(),
      wasmUrl: getWasmUrl(),
    });
    void task.promise
      .then((nextDocument) => {
        if (disposed) {
          void nextDocument.cleanup();
          return;
        }
        setDocument(nextDocument);
      })
      .catch((reason: unknown) => {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      void task.destroy();
      setDocument(null);
    };
  }, [url]);

  useEffect(() => {
    if (!document) return;
    // App 传入的 requestedPage 来自检索结果页码。这里先限制到 PDF
    // 的有效页数，再更新本地 page；后续渲染 effect 会调用 getPage(page)。
    setPage(Math.max(1, Math.min(requestedPage, document.numPages)));
  }, [document, requestedPage]);

  useEffect(() => {
    if (!selectionMenu) return;
    const dismissOnPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const menu = pageSurfaceRef.current?.querySelector(".pdf-selection-menu");
      if (menu?.contains(target)) return;
      clearFloatingSelection();
    };
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") clearFloatingSelection();
    };
    window.document.addEventListener("pointerdown", dismissOnPointerDown);
    window.document.addEventListener("keydown", dismissOnEscape);
    return () => {
      window.document.removeEventListener("pointerdown", dismissOnPointerDown);
      window.document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [clearFloatingSelection, selectionMenu]);

  useEffect(() => {
    if (
      !document ||
      !canvasRef.current ||
      !pageSurfaceRef.current ||
      !textLayerRef.current
    ) {
      return;
    }
    let disposed = false;
    setLoading(true);
    clearFloatingSelection();
    // page 改变后，PDF.js 读取真正的 PDF 第 page 页：先把页面绘制到 canvas，
    // 再创建透明 text layer，后者负责文本选择、复制和划词功能。
    void document
      .getPage(page)
      .then(async (pdfPage) => {
        if (
          disposed ||
          !canvasRef.current ||
          !pageSurfaceRef.current ||
          !textLayerRef.current
        ) {
          return;
        }
        await renderTaskRef.current?.cancel();
        textLayerRenderRef.current?.cancel();
        const viewport = pdfPage.getViewport({ scale: zoom });
        const canvas = canvasRef.current;
        const surface = pageSurfaceRef.current;
        const textLayerContainer = textLayerRef.current;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("无法创建 PDF 画布。");
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * pixelRatio);
        canvas.height = Math.floor(viewport.height * pixelRatio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        surface.style.width = `${viewport.width}px`;
        surface.style.height = `${viewport.height}px`;
        textLayerContainer.replaceChildren();
        textLayerContainer.style.setProperty(
          "--total-scale-factor",
          String(zoom),
        );
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        const renderTask = pdfPage.render({
          canvas,
          canvasContext: context,
          viewport,
        });
        renderTaskRef.current = renderTask;
        await renderTask.promise;
        if (disposed) return;
        const textContent = await pdfPage.getTextContent();
        const textLayer = new pdfjs.TextLayer({
          textContentSource: textContent,
          container: textLayerContainer,
          viewport,
        });
        textLayerRenderRef.current = textLayer;
        await textLayer.render();
      })
      .catch((reason: unknown) => {
        if (
          !disposed &&
          !(
            reason instanceof Error &&
            reason.name === "RenderingCancelledException"
          )
        ) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      renderTaskRef.current?.cancel();
      textLayerRenderRef.current?.cancel();
    };
  }, [clearFloatingSelection, document, page, zoom]);

  useEffect(() => {
    onPageChange(page);
  }, [onPageChange, page]);

  const changePage = (next: number): void => {
    if (!document) return;
    setPage(Math.max(1, Math.min(next, document.numPages)));
  };

  const handleStageWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    setZoom((current) => nextPdfZoom(current, event.deltaY));
  };

  const captureSelection = (): void => {
    if (blockSelectMode) return;
    window.setTimeout(() => {
      const browserSelection = window.getSelection();
      const textLayer = textLayerRef.current;
      const surface = pageSurfaceRef.current;
      if (
        !browserSelection ||
        browserSelection.isCollapsed ||
        browserSelection.rangeCount === 0 ||
        !textLayer ||
        !surface
      ) {
        return;
      }
      const range = browserSelection.getRangeAt(0);
      const ancestor =
        range.commonAncestorContainer.nodeType === Node.TEXT_NODE
          ? range.commonAncestorContainer.parentNode
          : range.commonAncestorContainer;
      if (!ancestor || !textLayer.contains(ancestor)) return;
      const text = browserSelection
        .toString()
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 8_000);
      if (text.length < 2) return;
      const rangeRect = range.getBoundingClientRect();
      const surfaceRect = surface.getBoundingClientRect();
      const left = Math.max(
        88,
        Math.min(
          surfaceRect.width - 88,
          rangeRect.left - surfaceRect.left + rangeRect.width / 2,
        ),
      );
      const top = Math.max(8, rangeRect.top - surfaceRect.top - 42);
      const nextSelection = { text, page, left, top };
      setSelectionMenu(nextSelection);
      onTextSelection?.({ text, page });
    }, 0);
  };

  const getSurfacePoint = (
    event: React.PointerEvent<HTMLDivElement>,
  ): SelectionPoint | null => {
    const surface = pageSurfaceRef.current;
    if (!surface) return null;
    const rect = surface.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
    };
  };

  const captureBlockImage = (selection: SelectionRect): string | undefined => {
    const canvas = canvasRef.current;
    const surface = pageSurfaceRef.current;
    if (!canvas || !surface) return undefined;
    const scale = canvas.width / surface.clientWidth;
    const sourceX = Math.floor(selection.left * scale);
    const sourceY = Math.floor(selection.top * scale);
    const sourceWidth = Math.min(
      canvas.width - sourceX,
      Math.ceil(selection.width * scale),
    );
    const sourceHeight = Math.min(
      canvas.height - sourceY,
      Math.ceil(selection.height * scale),
    );
    if (sourceWidth < 1 || sourceHeight < 1) return undefined;
    const imageCanvas = window.document.createElement("canvas");
    const maxDimension = 1_600;
    const imageScale = Math.min(
      1,
      maxDimension / Math.max(sourceWidth, sourceHeight),
    );
    imageCanvas.width = Math.max(1, Math.round(sourceWidth * imageScale));
    imageCanvas.height = Math.max(1, Math.round(sourceHeight * imageScale));
    const context = imageCanvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(
      canvas,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      imageCanvas.width,
      imageCanvas.height,
    );
    return imageCanvas.toDataURL("image/png");
  };

  const captureBlockSelection = (selection: SelectionRect): void => {
    const surface = pageSurfaceRef.current;
    if (!surface) return;
    const imageDataUrl = captureBlockImage(selection);
    if (!imageDataUrl) return;
    const left = selection.left + selection.width / 2;
    const top = Math.max(8, selection.top - 42);
    const nextSelection = {
      text: "图片选区",
      page,
      imageDataUrl,
      imageOnly: true,
      left: Math.max(88, Math.min(surface.clientWidth - 88, left)),
      top,
    };
    setConfirmedBlockSelection(selection);
    setSelectionMenu(nextSelection);
    onTextSelection?.({
      text: nextSelection.text,
      page,
      imageDataUrl,
      imageOnly: true,
    });
  };

  const startBlockSelection = (
    event: React.PointerEvent<HTMLDivElement>,
  ): void => {
    if (!blockSelectMode || event.button !== 0) return;
    const point = getSurfacePoint(event);
    if (!point) return;
    clearFloatingSelection();
    blockSelectionStartRef.current = point;
    setBlockSelection({ left: point.x, top: point.y, width: 0, height: 0 });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const updateBlockSelection = (
    event: React.PointerEvent<HTMLDivElement>,
  ): void => {
    const start = blockSelectionStartRef.current;
    const point = getSurfacePoint(event);
    if (!start || !point) return;
    setBlockSelection(createSelectionRect(start, point));
  };

  const finishBlockSelection = (
    event: React.PointerEvent<HTMLDivElement>,
  ): void => {
    const start = blockSelectionStartRef.current;
    const point = getSurfacePoint(event);
    blockSelectionStartRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!start || !point) {
      setBlockSelection(undefined);
      return;
    }
    const selection = createSelectionRect(start, point);
    setBlockSelection(undefined);
    if (hasSelectionArea(selection)) captureBlockSelection(selection);
  };

  const cancelBlockSelection = (
    event: React.PointerEvent<HTMLDivElement>,
  ): void => {
    blockSelectionStartRef.current = undefined;
    setBlockSelection(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <section className="pdf-viewer">
      <div className="pdf-toolbar">
        <div className="toolbar-group">
          <button
            className="icon-button"
            type="button"
            title="上一页"
            disabled={page <= 1}
            onClick={() => changePage(page - 1)}
          >
            <ChevronLeft size={17} />
          </button>
          <label className="page-counter">
            <input
              aria-label="页码"
              value={page}
              inputMode="numeric"
              onChange={(event) => changePage(Number(event.target.value) || 1)}
            />
            <span>/ {document?.numPages ?? "—"}</span>
          </label>
          <button
            className="icon-button"
            type="button"
            title="下一页"
            disabled={!document || page >= document.numPages}
            onClick={() => changePage(page + 1)}
          >
            <ChevronRight size={17} />
          </button>
        </div>
        {onViewModeChange ? (
          <DocumentViewToggle value={viewMode} onChange={onViewModeChange} />
        ) : (
          <span />
        )}
        <div className="toolbar-group">
          <button
            className="icon-button"
            type="button"
            title="缩小"
            onClick={() =>
              setZoom((value) => Math.max(PDF_MIN_ZOOM, value - 0.1))
            }
          >
            <Minus size={16} />
          </button>
          <span className="zoom-value">{Math.round(zoom * 100)}%</span>
          <button
            className="icon-button"
            type="button"
            title="放大"
            onClick={() =>
              setZoom((value) => Math.min(PDF_MAX_ZOOM, value + 0.1))
            }
          >
            <Plus size={16} />
          </button>
          <button
            className={`icon-button ${blockSelectMode ? "active" : ""}`}
            type="button"
            title={blockSelectMode ? "退出块选择" : "块选择公式或图表"}
            aria-pressed={blockSelectMode}
            onClick={() => {
              setBlockSelectMode((current) => !current);
              setBlockSelection(undefined);
              clearFloatingSelection();
            }}
          >
            <ScanLine size={16} />
          </button>
        </div>
      </div>
      <div className="pdf-stage" onWheel={handleStageWheel}>
        {loading && (
          <div className="stage-state">
            <LoaderCircle className="spin" size={24} />
            <span>正在渲染</span>
          </div>
        )}
        {error && (
          <div className="stage-state error-state">
            <FileWarning size={24} />
            <span>PDF 加载失败</span>
            <small>{error}</small>
          </div>
        )}
        <div
          className="pdf-page-surface"
          ref={pageSurfaceRef}
          onMouseUp={captureSelection}
          onPointerDown={startBlockSelection}
          onPointerMove={updateBlockSelection}
          onPointerUp={finishBlockSelection}
          onPointerCancel={cancelBlockSelection}
          data-block-selecting={blockSelectMode || undefined}
        >
          <canvas ref={canvasRef} />
          <div className="textLayer pdf-text-layer" ref={textLayerRef} />
          {blockSelection && (
            <div
              className="pdf-block-selection"
              style={{
                left: blockSelection.left,
                top: blockSelection.top,
                width: blockSelection.width,
                height: blockSelection.height,
              }}
            />
          )}
          {!blockSelection && confirmedBlockSelection && (
            <div
              className="pdf-block-selection pdf-block-selection-confirmed"
              style={{
                left: confirmedBlockSelection.left,
                top: confirmedBlockSelection.top,
                width: confirmedBlockSelection.width,
                height: confirmedBlockSelection.height,
              }}
            />
          )}
          {selectionMenu && (
            <div
              className="pdf-selection-menu"
              style={{ left: selectionMenu.left, top: selectionMenu.top }}
              onMouseDown={(event) => event.preventDefault()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                title="引用选中的原文"
                onClick={() => {
                  onReferenceSelection?.(selectionMenu);
                  clearFloatingSelection();
                }}
              >
                <Quote size={13} />
                引用
              </button>
              {!selectionMenu.imageOnly && (
                <button
                  type="button"
                  title="使用百度翻译 API 翻译"
                  onClick={() => {
                    onTranslateSelection?.(selectionMenu);
                    clearFloatingSelection();
                  }}
                >
                  <Languages size={13} />
                  翻译
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
