export interface SelectionPoint {
  x: number;
  y: number;
}

export interface SelectionRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

type RectLike = Pick<DOMRectReadOnly, "left" | "right" | "top" | "bottom">;

export function createSelectionRect(
  start: SelectionPoint,
  end: SelectionPoint,
): SelectionRect {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  return {
    left,
    top,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function hasSelectionArea(
  rect: Pick<SelectionRect, "width" | "height">,
  minimumSize = 8,
): boolean {
  return rect.width >= minimumSize && rect.height >= minimumSize;
}

export function rectsIntersect(first: RectLike, second: RectLike): boolean {
  return (
    first.left < second.right &&
    first.right > second.left &&
    first.top < second.bottom &&
    first.bottom > second.top
  );
}
