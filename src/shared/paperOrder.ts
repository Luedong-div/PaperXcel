export type PaperDropPlacement = "before" | "after";

export function reorderIds(
  ids: string[],
  draggedId: string,
  targetId: string,
  placement: PaperDropPlacement,
): string[] {
  if (draggedId === targetId) return ids;
  if (!ids.includes(draggedId) || !ids.includes(targetId)) return ids;

  const next = ids.filter((id) => id !== draggedId);
  const targetIndex = next.indexOf(targetId);
  if (targetIndex < 0) return ids;

  next.splice(
    placement === "after" ? targetIndex + 1 : targetIndex,
    0,
    draggedId,
  );
  return next;
}
