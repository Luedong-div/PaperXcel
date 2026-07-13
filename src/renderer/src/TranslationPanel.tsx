import { useEffect, useRef, useState } from "react";
import {
  Copy,
  Languages,
  LoaderCircle,
  Maximize2,
  Minus,
  Settings2,
  X,
} from "lucide-react";
import type {
  TranslationLanguage,
  TranslationResult,
} from "../../shared/contracts";

export interface TranslationPanelState {
  sourceText: string;
  source: TranslationLanguage;
  target: TranslationLanguage;
  result?: TranslationResult;
  loading: boolean;
  error?: string;
}

interface TranslationPanelProps {
  state: TranslationPanelState;
  onClose: () => void;
  onCopy: (text: string) => void;
  onOpenSettings: () => void;
}

interface PanelPosition {
  left: number;
  top: number;
}

function languageLabel(language: TranslationLanguage): string {
  return language === "en" ? "英语" : "中文";
}

export function TranslationPanel({
  state,
  onClose,
  onCopy,
  onOpenSettings,
}: TranslationPanelProps): React.JSX.Element {
  const [minimized, setMinimized] = useState(false);
  const [position, setPosition] = useState<PanelPosition>(() => ({
    left: Math.max(18, window.innerWidth - 458),
    top: 54,
  }));
  const dragRef = useRef<
    | {
        pointerId: number;
        offsetX: number;
        offsetY: number;
      }
    | undefined
  >(undefined);

  const result = state.result;
  const source = result?.source ?? state.source;
  const target = result?.target ?? state.target;

  useEffect(() => {
    setMinimized(false);
  }, [state.sourceText]);

  useEffect(() => {
    const keepPanelInViewport = (): void => {
      setPosition((current) => ({
        left: Math.max(12, Math.min(current.left, window.innerWidth - 452)),
        top: Math.max(46, Math.min(current.top, window.innerHeight - 120)),
      }));
    };
    window.addEventListener("resize", keepPanelInViewport);
    return () => window.removeEventListener("resize", keepPanelInViewport);
  }, []);

  const startDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    const rect = event.currentTarget
      .closest(".translation-panel")
      ?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const movePanel = (event: React.PointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPosition({
      left: Math.max(
        12,
        Math.min(event.clientX - drag.offsetX, window.innerWidth - 452),
      ),
      top: Math.max(
        46,
        Math.min(event.clientY - drag.offsetY, window.innerHeight - 120),
      ),
    });
  };

  const stopDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = undefined;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  if (minimized) {
    return (
      <button
        className="translation-panel-minimized"
        type="button"
        title="恢复划词翻译"
        onClick={() => setMinimized(false)}
      >
        <span className="translation-panel-icon">
          <Languages size={15} />
        </span>
        <span>划词翻译</span>
        <Maximize2 size={13} />
      </button>
    );
  }

  return (
    <section
      className="translation-panel"
      style={{ left: position.left, top: position.top }}
      role="dialog"
      aria-label="划词翻译"
      aria-live="polite"
    >
      <header
        className="translation-panel-header"
        onPointerDown={startDrag}
        onPointerMove={movePanel}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
      >
        <div className="translation-panel-title">
          <span className="translation-panel-icon">
            <Languages size={16} />
          </span>
          <div>
            <strong>划词翻译</strong>
            <small>百度翻译 API</small>
          </div>
        </div>
        <div className="translation-panel-actions">
          <button
            className="icon-button"
            type="button"
            title="最小化翻译"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setMinimized(true)}
          >
            <Minus size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            title="关闭翻译"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="translation-panel-direction">
        <span>{languageLabel(source)}</span>
        <span className="translation-panel-arrow">→</span>
        <span>{languageLabel(target)}</span>
      </div>

      <div className="translation-panel-section">
        <div className="translation-panel-label">
          <span>原文</span>
          <button
            className="translation-copy-button"
            type="button"
            title="复制原文"
            onClick={() => onCopy(result?.sourceText ?? state.sourceText)}
          >
            <Copy size={13} />
          </button>
        </div>
        <p className="translation-source-text">
          {result?.sourceText ?? state.sourceText}
        </p>
      </div>

      <div className="translation-panel-section translation-panel-result">
        <div className="translation-panel-label">
          <span>译文</span>
          {result && (
            <button
              className="translation-copy-button"
              type="button"
              title="复制译文"
              onClick={() => onCopy(result.translatedText)}
            >
              <Copy size={13} />
            </button>
          )}
        </div>
        {state.loading ? (
          <div className="translation-loading">
            <LoaderCircle className="spin" size={17} />
            <span>正在请求百度翻译...</span>
          </div>
        ) : state.error ? (
          <div className="translation-error">
            <p>{state.error}</p>
            <button
              className="secondary-button"
              type="button"
              onClick={onOpenSettings}
            >
              <Settings2 size={14} />
              打开翻译设置
            </button>
          </div>
        ) : (
          <p className="translation-result-text">
            {result?.translatedText || "暂无译文"}
          </p>
        )}
      </div>
    </section>
  );
}
