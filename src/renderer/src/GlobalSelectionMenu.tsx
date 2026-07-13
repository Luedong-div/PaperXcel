import { useCallback, useEffect, useRef, useState } from "react";
import { Languages } from "lucide-react";

interface GlobalSelectionMenuProps {
  onTranslate: (text: string) => void;
}

interface SelectionMenuState {
  text: string;
  left: number;
  top: number;
  below: boolean;
}

const ignoredSelectionSelector = [
  ".pdf-page-surface",
  ".pdf-selection-menu",
  ".global-selection-menu",
  ".translation-panel",
  ".translation-panel-minimized",
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
].join(",");

export function GlobalSelectionMenu({
  onTranslate,
}: GlobalSelectionMenuProps): React.JSX.Element | null {
  const [menu, setMenu] = useState<SelectionMenuState>();
  const menuRef = useRef<HTMLDivElement>(null);
  const captureTimerRef = useRef<number | undefined>(undefined);

  const clearSelectionMenu = useCallback((removeSelection = false): void => {
    window.clearTimeout(captureTimerRef.current);
    setMenu(undefined);
    if (removeSelection) window.getSelection()?.removeAllRanges();
  }, []);

  const captureSelection = useCallback((): void => {
    window.clearTimeout(captureTimerRef.current);
    captureTimerRef.current = window.setTimeout(() => {
      const selection = window.getSelection();
      if (
        !selection ||
        selection.isCollapsed ||
        selection.rangeCount === 0
      ) {
        setMenu(undefined);
        return;
      }

      const range = selection.getRangeAt(0);
      const ancestor =
        range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
          ? (range.commonAncestorContainer as Element)
          : range.commonAncestorContainer.parentElement;
      if (!ancestor || ancestor.closest(ignoredSelectionSelector)) {
        setMenu(undefined);
        return;
      }

      const text = selection.toString().replace(/\s+/g, " ").trim();
      if (text.length < 2) {
        setMenu(undefined);
        return;
      }

      const rects = [...range.getClientRects()].filter(
        (rect) => rect.width > 0 && rect.height > 0,
      );
      const rect = rects.at(-1) ?? range.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        setMenu(undefined);
        return;
      }

      const below = rect.top < 52;
      setMenu({
        text,
        left: Math.max(
          48,
          Math.min(window.innerWidth - 48, rect.left + rect.width / 2),
        ),
        top: below ? rect.bottom + 8 : rect.top - 8,
        below,
      });
    }, 0);
  }, []);

  useEffect(() => {
    const dismissOnPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      clearSelectionMenu();
    };
    const dismissOnKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") clearSelectionMenu(true);
    };
    const captureOnKeyUp = (event: KeyboardEvent): void => {
      if (
        event.key === "Shift" ||
        event.key.startsWith("Arrow") ||
        event.key === "Home" ||
        event.key === "End"
      ) {
        captureSelection();
      }
    };
    const dismissOnViewportChange = (): void => clearSelectionMenu();

    document.addEventListener("mouseup", captureSelection, true);
    document.addEventListener("keyup", captureOnKeyUp, true);
    document.addEventListener("pointerdown", dismissOnPointerDown, true);
    document.addEventListener("keydown", dismissOnKeyDown, true);
    window.addEventListener("resize", dismissOnViewportChange);
    window.addEventListener("scroll", dismissOnViewportChange, true);
    return () => {
      window.clearTimeout(captureTimerRef.current);
      document.removeEventListener("mouseup", captureSelection, true);
      document.removeEventListener("keyup", captureOnKeyUp, true);
      document.removeEventListener("pointerdown", dismissOnPointerDown, true);
      document.removeEventListener("keydown", dismissOnKeyDown, true);
      window.removeEventListener("resize", dismissOnViewportChange);
      window.removeEventListener("scroll", dismissOnViewportChange, true);
    };
  }, [captureSelection, clearSelectionMenu]);

  if (!menu) return null;

  return (
    <div
      ref={menuRef}
      className={`global-selection-menu ${menu.below ? "below" : ""}`}
      style={{ left: menu.left, top: menu.top }}
      role="toolbar"
      aria-label="选中文本操作"
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        title="使用百度翻译 API 翻译"
        onClick={() => {
          onTranslate(menu.text);
          clearSelectionMenu(true);
        }}
      >
        <Languages size={13} />
        翻译
      </button>
    </div>
  );
}
