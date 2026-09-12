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

interface PdfPageViewProps {
  document: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  blockSelectMode: boolean;
  pageRef: (element: HTMLDivElement | null) => void;
  onTextSelection?: (selection?: PdfTextSelection) => void;
  onReferenceSelection?: (selection: PdfTextSelection) => void;
  onTranslateSelection?: (selection: PdfTextSelection) => void;
}

function PdfPageView({
  document,
  pageNumber,
  zoom,
  blockSelectMode,
  pageRef,
  onTextSelection,
  onReferenceSelection,
  onTranslateSelection,
}: PdfPageViewProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const textLayerRenderRef = useRef<TextLayer | null>(null);
  const selectionStartRef = useRef<SelectionPoint | undefined>(undefined);
  const [selection, setSelection] = useState<SelectionRect>();
  const [confirmedSelection, setConfirmedSelection] = useState<SelectionRect>();
  const [selectionMenu, setSelectionMenu] = useState<
    (PdfTextSelection & { left: number; top: number }) | undefined
  >();

  const clearSelection = useCallback((): void => {
    setSelectionMenu(undefined);
    setConfirmedSelection(undefined);
    onTextSelection?.(undefined);
    window.getSelection()?.removeAllRanges();
  }, [onTextSelection]);

  useEffect(() => {
    let disposed = false;
    void document.getPage(pageNumber).then(async (pdfPage) => {
      if (disposed || !canvasRef.current || !surfaceRef.current || !textLayerRef.current) return;
      renderTaskRef.current?.cancel();
      textLayerRenderRef.current?.cancel();
      const viewport = pdfPage.getViewport({ scale: zoom });
      const canvas = canvasRef.current;
      const surface = surfaceRef.current;
      const textLayer = textLayerRef.current;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      surface.style.width = `${viewport.width}px`;
      surface.style.height = `${viewport.height}px`;
      textLayer.replaceChildren();
      textLayer.style.setProperty("--total-scale-factor", String(zoom));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Unable to create PDF canvas.");
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      const renderTask = pdfPage.render({ canvas, canvasContext: context, viewport });
      renderTaskRef.current = renderTask;
      await renderTask.promise;
      if (disposed) return;
      const textContent = await pdfPage.getTextContent();
      const layer = new pdfjs.TextLayer({
        textContentSource: textContent,
        container: textLayer,
        viewport,
      });
      textLayerRenderRef.current = layer;
      await layer.render();
    }).catch((reason: unknown) => {
      if (!disposed && !(reason instanceof Error && reason.name === "RenderingCancelledException")) {
        console.error(`Failed to render PDF page ${pageNumber}`, reason);
      }
    });
    return () => {
      disposed = true;
      renderTaskRef.current?.cancel();
      textLayerRenderRef.current?.cancel();
    };
  }, [document, pageNumber, zoom]);

  useEffect(() => {
    if (!selectionMenu) return;
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && !surfaceRef.current?.contains(event.target)) {
        clearSelection();
      }
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") clearSelection();
    };
    window.document.addEventListener("pointerdown", dismiss);
    window.document.addEventListener("keydown", escape);
    return () => {
      window.document.removeEventListener("pointerdown", dismiss);
      window.document.removeEventListener("keydown", escape);
    };
  }, [clearSelection, selectionMenu]);

  const captureTextSelection = (): void => {
    if (blockSelectMode) return;
    window.setTimeout(() => {
      const browserSelection = window.getSelection();
      const textLayer = textLayerRef.current;
      const surface = surfaceRef.current;
      if (!browserSelection || browserSelection.isCollapsed || browserSelection.rangeCount === 0 || !textLayer || !surface) return;
      const range = browserSelection.getRangeAt(0);
      const ancestor = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentNode
        : range.commonAncestorContainer;
      if (!ancestor || !textLayer.contains(ancestor)) return;
      const text = browserSelection.toString().replace(/\s+/g, " ").trim().slice(0, 8_000);
      if (text.length < 2) return;
      const rangeRect = range.getBoundingClientRect();
      const surfaceRect = surface.getBoundingClientRect();
      setSelectionMenu({
        text,
        page: pageNumber,
        left: Math.max(88, Math.min(surfaceRect.width - 88, rangeRect.left - surfaceRect.left + rangeRect.width / 2)),
        top: Math.max(8, rangeRect.top - surfaceRect.top - 42),
      });
      onTextSelection?.({ text, page: pageNumber });
    }, 0);
  };

  const pointFromEvent = (event: React.PointerEvent<HTMLDivElement>): SelectionPoint | null => {
    const surface = surfaceRef.current;
    if (!surface) return null;
    const rect = surface.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
    };
  };

  const captureBlock = (rect: SelectionRect): void => {
    const canvas = canvasRef.current;
    const surface = surfaceRef.current;
    if (!canvas || !surface) return;
    const scale = canvas.width / surface.clientWidth;
    const sourceX = Math.floor(rect.left * scale);
    const sourceY = Math.floor(rect.top * scale);
    const sourceWidth = Math.min(canvas.width - sourceX, Math.ceil(rect.width * scale));
    const sourceHeight = Math.min(canvas.height - sourceY, Math.ceil(rect.height * scale));
    if (sourceWidth < 1 || sourceHeight < 1) return;
    const imageCanvas = window.document.createElement("canvas");
    const imageScale = Math.min(1, 1_600 / Math.max(sourceWidth, sourceHeight));
    imageCanvas.width = Math.max(1, Math.round(sourceWidth * imageScale));
    imageCanvas.height = Math.max(1, Math.round(sourceHeight * imageScale));
    const context = imageCanvas.getContext("2d");
    if (!context) return;
    context.drawImage(canvas, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, imageCanvas.width, imageCanvas.height);
    const selectionData: PdfTextSelection = {
      text: "Image selection",
      page: pageNumber,
      imageDataUrl: imageCanvas.toDataURL("image/png"),
      imageOnly: true,
    };
    setConfirmedSelection(rect);
    setSelectionMenu({ ...selectionData, left: Math.max(88, Math.min(surface.clientWidth - 88, rect.left + rect.width / 2)), top: Math.max(8, rect.top - 42) });
    onTextSelection?.(selectionData);
  };

  const startBlockSelection = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!blockSelectMode || event.button !== 0) return;
    const point = pointFromEvent(event);
    if (!point) return;
    clearSelection();
    selectionStartRef.current = point;
    setSelection({ left: point.x, top: point.y, width: 0, height: 0 });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const updateBlockSelection = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = selectionStartRef.current;
    const point = pointFromEvent(event);
    if (start && point) setSelection(createSelectionRect(start, point));
  };
  const finishBlockSelection = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = selectionStartRef.current;
    const point = pointFromEvent(event);
    selectionStartRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setSelection(undefined);
    if (start && point) {
      const next = createSelectionRect(start, point);
      if (hasSelectionArea(next)) captureBlock(next);
    }
  };

  return (
    <div
      className="pdf-page-surface"
      ref={(element) => {
        surfaceRef.current = element;
        pageRef(element);
      }}
      onMouseUp={captureTextSelection}
      onPointerDown={startBlockSelection}
      onPointerMove={updateBlockSelection}
      onPointerUp={finishBlockSelection}
      onPointerCancel={() => { selectionStartRef.current = undefined; setSelection(undefined); }}
      data-page-number={pageNumber}
      data-block-selecting={blockSelectMode || undefined}
    >
      <canvas ref={canvasRef} />
      <div className="textLayer pdf-text-layer" ref={textLayerRef} />
      {selection && <div className="pdf-block-selection" style={selection} />}
      {!selection && confirmedSelection && <div className="pdf-block-selection pdf-block-selection-confirmed" style={confirmedSelection} />}
      {selectionMenu && (
        <div className="pdf-selection-menu" style={{ left: selectionMenu.left, top: selectionMenu.top }} onMouseDown={(event) => event.preventDefault()} onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" title="引用选中的原文" onClick={() => { onReferenceSelection?.(selectionMenu); clearSelection(); }}><Quote size={13} />引用</button>
          {!selectionMenu.imageOnly && <button type="button" title="翻译选中的原文" onClick={() => { onTranslateSelection?.(selectionMenu); clearSelection(); }}><Languages size={13} />翻译</button>}
        </div>
      )}
    </div>
  );
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
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(Math.max(1, requestedPage));
  const [zoom, setZoom] = useState(1);
  const [blockSelectMode, setBlockSelectMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const stageRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  const navigationTargetRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError("");
    const task = pdfjs.getDocument({ url, standardFontDataUrl: getStandardFontDataUrl(), wasmUrl: getWasmUrl() });
    void task.promise.then((nextDocument) => {
      if (disposed) { void nextDocument.cleanup(); return; }
      setDocument(nextDocument);
      const nextPage = Math.max(1, Math.min(requestedPage, nextDocument.numPages));
      navigationTargetRef.current = nextPage;
      setCurrentPage(nextPage);
    }).catch((reason: unknown) => {
      if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; void task.destroy(); setDocument(null); pageRefs.current.clear(); };
  }, [url]);

  useEffect(() => {
    if (!document) return;
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new IntersectionObserver((entries) => {
      const target = navigationTargetRef.current;
      const targetEntry = target
        ? entries.find(
            (entry) =>
              entry.isIntersecting &&
              entry.target instanceof HTMLElement &&
              Number(entry.target.dataset.pageNumber) === target,
          )
        : undefined;
      if (target && !targetEntry) return;
      const visible = targetEntry ?? entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      const value = visible?.target instanceof HTMLElement
        ? Number(visible.target.dataset.pageNumber)
        : 0;
      if (value) {
        if (navigationTargetRef.current !== undefined) {
          if (navigationTargetRef.current !== value) return;
          navigationTargetRef.current = undefined;
        }
        setCurrentPage(value);
        onPageChange(value);
      }
    }, { root: stage, threshold: [0.25, 0.5, 0.75] });
    pageRefs.current.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [document, onPageChange]);

  useEffect(() => {
    if (document && (requestedPage !== currentPage || navigationTargetRef.current !== undefined)) {
      const next = Math.max(1, Math.min(requestedPage, document.numPages));
      setCurrentPage(next);
      navigationTargetRef.current = next;
      window.requestAnimationFrame(() => {
        pageRefs.current
          .get(next)
          ?.scrollIntoView({ behavior: "auto", block: "start" });
      });
    }
  }, [currentPage, document, requestedPage]);

  const jumpToPage = (value: number): void => {
    if (!document) return;
    const next = Math.max(1, Math.min(value, document.numPages));
    setCurrentPage(next);
    navigationTargetRef.current = next;
    onPageChange(next);
    pageRefs.current.get(next)?.scrollIntoView({ behavior: "auto", block: "start" });
  };
  const handleStageWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    if (event.ctrlKey) {
      event.preventDefault();
      setZoom((value) => nextPdfZoom(value, event.deltaY));
    }
  };

  return (
    <section className="pdf-viewer">
      <div className="pdf-toolbar">
        <div className="toolbar-group">
          <button className="icon-button" type="button" title="上一页" disabled={!document || currentPage <= 1} onClick={() => jumpToPage(currentPage - 1)}><ChevronLeft size={17} /></button>
          <label className="page-counter"><input aria-label="页码" value={currentPage} inputMode="numeric" onChange={(event) => jumpToPage(Number(event.target.value) || 1)} /><span>/ {document?.numPages ?? "—"}</span></label>
          <button className="icon-button" type="button" title="下一页" disabled={!document || currentPage >= (document?.numPages ?? 1)} onClick={() => jumpToPage(currentPage + 1)}><ChevronRight size={17} /></button>
        </div>
        {onViewModeChange ? <DocumentViewToggle value={viewMode} onChange={onViewModeChange} /> : <span />}
        <div className="toolbar-group">
          <button className="icon-button" type="button" title="缩小" onClick={() => setZoom((value) => Math.max(PDF_MIN_ZOOM, value - 0.1))}><Minus size={16} /></button>
          <span className="zoom-value">{Math.round(zoom * 100)}%</span>
          <button className="icon-button" type="button" title="放大" onClick={() => setZoom((value) => Math.min(PDF_MAX_ZOOM, value + 0.1))}><Plus size={16} /></button>
          <button className={`icon-button ${blockSelectMode ? "active" : ""}`} type="button" title={blockSelectMode ? "退出块选择" : "块选择公式或图表"} aria-pressed={blockSelectMode} onClick={() => { setBlockSelectMode((value) => !value); onTextSelection?.(undefined); }}><ScanLine size={16} /></button>
        </div>
      </div>
      <div className="pdf-stage" ref={stageRef} onWheel={handleStageWheel}>
        {loading && <div className="stage-state"><LoaderCircle className="spin" size={24} /><span>正在渲染</span></div>}
        {error && <div className="stage-state error-state"><FileWarning size={24} /><span>PDF 加载失败</span><small>{error}</small></div>}
        {document && <div className="pdf-pages">{Array.from({ length: document.numPages }, (_, index) => {
          const pageNumber = index + 1;
          return <PdfPageView key={`${url}-${pageNumber}`} document={document} pageNumber={pageNumber} zoom={zoom} blockSelectMode={blockSelectMode} pageRef={(element) => { if (element) pageRefs.current.set(pageNumber, element); else pageRefs.current.delete(pageNumber); }} onTextSelection={onTextSelection} onReferenceSelection={onReferenceSelection} onTranslateSelection={onTranslateSelection} />;
        })}</div>}
      </div>
    </section>
  );
}
