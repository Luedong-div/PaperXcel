import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileText, FolderOpen } from "lucide-react";
import type { LibraryFolder, Paper } from "../../shared/contracts";

export function CitationPaperSelector({
  papers,
  folders,
  selectedPaperIds,
  onTogglePaper,
  onToggleGroup,
}: {
  papers: Paper[];
  folders: LibraryFolder[];
  selectedPaperIds: Set<string>;
  onTogglePaper: (paperId: string) => void;
  onToggleGroup: (paperIds: string[]) => void;
}): React.JSX.Element {
  const groups = useMemo(
    () => buildPaperGroups(papers, folders),
    [papers, folders],
  );
  return (
    <>
      {groups.map((group) => (
        <PaperSelectionGroup
          key={group.id}
          group={group}
          selectedPaperIds={selectedPaperIds}
          onTogglePaper={onTogglePaper}
          onToggleGroup={onToggleGroup}
        />
      ))}
      {papers.length === 0 && (
        <span className="citation-local-picker-empty">本地资料库暂无论文</span>
      )}
    </>
  );
}

interface PaperSelectionGroup {
  id: string;
  name: string;
  papers: Paper[];
  children: PaperSelectionGroup[];
}

function buildPaperGroups(
  papers: Paper[],
  folders: LibraryFolder[],
): PaperSelectionGroup[] {
  const papersByFolder = new Map<string | undefined, Paper[]>();
  for (const paper of papers) {
    const group = papersByFolder.get(paper.folderId) ?? [];
    group.push(paper);
    papersByFolder.set(paper.folderId, group);
  }
  const foldersByParent = new Map<string | undefined, LibraryFolder[]>();
  for (const folder of folders) {
    const group = foldersByParent.get(folder.parentId) ?? [];
    group.push(folder);
    foldersByParent.set(folder.parentId, group);
  }

  const buildFolder = (folder: LibraryFolder): PaperSelectionGroup => ({
    id: `folder:${folder.id}`,
    name: folder.name,
    papers: (papersByFolder.get(folder.id) ?? []).sort((first, second) =>
      first.title.localeCompare(second.title),
    ),
    children: (foldersByParent.get(folder.id) ?? [])
      .map(buildFolder)
      .filter((group) => group.papers.length > 0 || group.children.length > 0)
      .sort((first, second) => first.name.localeCompare(second.name)),
  });

  const groups: PaperSelectionGroup[] = [];
  const folderIds = new Set(folders.map((folder) => folder.id));
  const unfiled = papers
    .filter((paper) => !paper.folderId || !folderIds.has(paper.folderId))
    .sort((first, second) => first.title.localeCompare(second.title));
  if (unfiled.length) {
    groups.push({
      id: "folder:unfiled",
      name: "未分类",
      papers: unfiled,
      children: [],
    });
  }
  groups.push(
    ...(foldersByParent.get(undefined) ?? [])
      .map(buildFolder)
      .filter((group) => group.papers.length > 0 || group.children.length > 0)
      .sort((first, second) => first.name.localeCompare(second.name)),
  );
  return groups;
}

function PaperSelectionGroup({
  group,
  selectedPaperIds,
  onTogglePaper,
  onToggleGroup,
  depth = 0,
}: {
  group: PaperSelectionGroup;
  selectedPaperIds: Set<string>;
  onTogglePaper: (paperId: string) => void;
  onToggleGroup: (paperIds: string[]) => void;
  depth?: number;
}): React.JSX.Element {
  const [open, setOpen] = useState(depth < 1);
  const paperIds = getGroupPaperIds(group);
  const allSelected =
    paperIds.length > 0 &&
    paperIds.every((paperId) => selectedPaperIds.has(paperId));
  const selectedCount = paperIds.filter((paperId) =>
    selectedPaperIds.has(paperId),
  ).length;

  return (
    <div className="citation-paper-group" style={{ paddingLeft: depth * 9 }}>
      <div className="citation-paper-group-row">
        <button
          className="citation-paper-group-expand"
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-label={open ? "折叠文件夹" : "展开文件夹"}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <input
          type="checkbox"
          checked={allSelected}
          disabled={!paperIds.length}
          onChange={() => onToggleGroup(paperIds)}
          aria-label={`选择文件夹 ${group.name}`}
        />
        <FolderOpen size={14} />
        <span title={group.name}>{group.name}</span>
        <small>
          {selectedCount}/{paperIds.length}
        </small>
      </div>
      {open && (
        <div className="citation-paper-group-contents">
          {group.papers.map((paper) => (
            <label className="citation-paper-selection" key={paper.id}>
              <input
                type="checkbox"
                checked={selectedPaperIds.has(paper.id)}
                onChange={() => onTogglePaper(paper.id)}
              />
              <FileText size={12} />
              <span title={paper.title}>{paper.title}</span>
            </label>
          ))}
          {group.children.map((child) => (
            <PaperSelectionGroup
              key={child.id}
              group={child}
              selectedPaperIds={selectedPaperIds}
              onTogglePaper={onTogglePaper}
              onToggleGroup={onToggleGroup}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function getGroupPaperIds(group: PaperSelectionGroup): string[] {
  return [
    ...group.papers.map((paper) => paper.id),
    ...group.children.flatMap((child) => getGroupPaperIds(child)),
  ];
}
