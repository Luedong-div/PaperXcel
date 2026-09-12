import { useCallback, useLayoutEffect, useRef, useState } from "react";

const BOTTOM_THRESHOLD = 64;

/** Follow content growth only while the reader is already near the bottom. */
export function useChatScroll(conversationKey: string) {
  const [scrollElement, scrollRef] = useState<HTMLDivElement | null>(null);
  const [contentElement, contentRef] = useState<HTMLDivElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const following = useRef(true);

  const scrollToBottom = useCallback(() => {
    following.current = true;
    if (scrollElement) {
      scrollElement.scrollTo({
        top: Math.max(
          0,
          scrollElement.scrollHeight - scrollElement.clientHeight,
        ),
        behavior: "instant",
      });
    }
    setIsAtBottom(true);
  }, [scrollElement]);

  useLayoutEffect(() => {
    if (!scrollElement || !contentElement) return;
    let animationFrame: number | undefined;
    following.current = true;

    const nearBottom = () =>
      scrollElement.scrollHeight -
        scrollElement.scrollTop -
        scrollElement.clientHeight <=
      BOTTOM_THRESHOLD;

    const onScroll = () => {
      // A hidden panel reports a zero viewport and must not lose its intent
      // to follow when switching between the chat and notes tabs.
      if (!scrollElement.clientHeight) return;
      following.current = nearBottom();
      setIsAtBottom(following.current);
    };

    const updatePosition = () => {
      animationFrame = undefined;
      if (!scrollElement.clientHeight) return;
      if (following.current) {
        scrollElement.scrollTo({
          top: Math.max(
            0,
            scrollElement.scrollHeight - scrollElement.clientHeight,
          ),
          behavior: "instant",
        });
      }
      const atBottom = nearBottom();
      following.current = atBottom;
      setIsAtBottom(atBottom);
    };

    const onResize = () => {
      if (animationFrame === undefined) {
        animationFrame = window.requestAnimationFrame(updatePosition);
      }
    };

    scrollElement.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(onResize);
    // Token updates render in ChatStreamView independently of App. Observing
    // the content is what keeps scrolling responsive without lifting tokens
    // back into the application component's state.
    observer.observe(contentElement);
    observer.observe(scrollElement);
    onResize();

    return () => {
      observer.disconnect();
      scrollElement.removeEventListener("scroll", onScroll);
      if (animationFrame !== undefined) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, [scrollElement, contentElement, conversationKey]);

  return { scrollRef, contentRef, isAtBottom, scrollToBottom };
}
