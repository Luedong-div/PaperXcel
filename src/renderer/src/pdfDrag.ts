type RectLike = Pick<DOMRectReadOnly, "left" | "right" | "top" | "bottom">;
type PointerLike = Pick<MouseEvent, "clientX" | "clientY">;

const isNode = (value: EventTarget | null): value is Node =>
  value instanceof Node;

export const isPointerWithinRect = (
  pointer: PointerLike,
  rect: RectLike,
): boolean =>
  pointer.clientX > rect.left &&
  pointer.clientX < rect.right &&
  pointer.clientY > rect.top &&
  pointer.clientY < rect.bottom;

export const isDragTransitionWithinContainer = (
  container: Pick<Node, "contains">,
  relatedTarget: EventTarget | null,
): boolean => isNode(relatedTarget) && container.contains(relatedTarget);

export const shouldIgnorePdfDragEnter = (
  isActive: boolean,
  pointer: PointerLike,
  rect: RectLike,
): boolean => isActive && isPointerWithinRect(pointer, rect);

export const shouldIgnorePdfDragLeave = (
  container: Pick<Node, "contains">,
  relatedTarget: EventTarget | null,
  pointer: PointerLike,
  rect: RectLike,
): boolean =>
  isDragTransitionWithinContainer(container, relatedTarget) ||
  isPointerWithinRect(pointer, rect);
