// "Folders" — a hierarchical organization layer over notes, built entirely
// from tags that contain a separator ('/'). A tag like
// "cooking/italian/dessert" files a note at that path in the folder tree;
// FLAT tags (no '/') are NOT folders — they stay regular tags. The tree is
// derived client-side from whatever notes are in scope (single-user corpus,
// so no backend aggregation needed).
//
// We deliberately overload the existing `tags` field rather than add a new
// column: a slash-containing tag IS a folder path. This keeps the whole
// feature frontend-only (no migration / server restart) and mirrors how Bear
// implements nested tags.

export const FOLDER_SEP = '/';

export interface FolderNode {
  /** Full path, e.g. "cooking/italian". */
  path: string;
  /** Last segment, e.g. "italian". */
  name: string;
  children: FolderNode[];
  /** Notes filed at this exact path OR any descendant (deduped). */
  noteCount: number;
}

/** A folder path is a tag containing the separator. */
export function isFolderTag(tag: string): boolean {
  return tag.includes(FOLDER_SEP);
}

/** Split flat tags from folder paths on a note. */
export function splitTags(tags: string[]): { flat: string[]; folders: string[] } {
  const flat: string[] = [];
  const folders: string[] = [];
  for (const t of tags) (isFolderTag(t) ? folders : flat).push(t);
  return { flat, folders };
}

/** Normalize a path: trim, collapse repeated/edge separators, drop blanks. */
export function normalizeFolderPath(raw: string): string {
  return raw
    .split(FOLDER_SEP)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(FOLDER_SEP);
}

/** Build the folder tree from a set of notes. Each slash-tag contributes all
 *  of its ancestor paths as nodes; a node's count includes notes filed at it
 *  or below. */
export function buildFolderTree(notes: { tags: string[] }[]): FolderNode[] {
  const nodes = new Map<string, FolderNode>();
  const counted = new Map<string, Set<number>>();

  const ensure = (path: string): FolderNode => {
    let n = nodes.get(path);
    if (!n) {
      const segs = path.split(FOLDER_SEP);
      n = { path, name: segs[segs.length - 1]!, children: [], noteCount: 0 };
      nodes.set(path, n);
      if (segs.length > 1) {
        ensure(segs.slice(0, -1).join(FOLDER_SEP)).children.push(n);
      }
    }
    return n;
  };

  notes.forEach((note, i) => {
    for (const fp of note.tags.filter(isFolderTag)) {
      const segs = fp.split(FOLDER_SEP).filter(Boolean);
      for (let k = 1; k <= segs.length; k++) {
        const ancestor = segs.slice(0, k).join(FOLDER_SEP);
        ensure(ancestor);
        let set = counted.get(ancestor);
        if (!set) { set = new Set(); counted.set(ancestor, set); }
        set.add(i);
      }
    }
  });

  for (const [path, set] of counted) {
    const n = nodes.get(path);
    if (n) n.noteCount = set.size;
  }

  const sortRec = (arr: FolderNode[]) => {
    arr.sort((a, b) => a.name.localeCompare(b.name));
    arr.forEach((c) => sortRec(c.children));
  };
  const roots = [...nodes.values()].filter((n) => !n.path.includes(FOLDER_SEP));
  sortRec(roots);
  return roots;
}

/** All ancestor paths of a folder path, inclusive:
 *  "a/b/c" → ["a", "a/b", "a/b/c"]. */
export function ancestorsOf(path: string): string[] {
  const segs = path.split(FOLDER_SEP).filter(Boolean);
  return segs.map((_, i) => segs.slice(0, i + 1).join(FOLDER_SEP));
}

/** Does a note belong under `path` (exact match or any descendant)? */
export function noteInFolder(tags: string[], path: string): boolean {
  return tags.filter(isFolderTag).some((fp) => fp === path || fp.startsWith(path + FOLDER_SEP));
}

/** Replace a note's folder paths, preserving its flat tags. Returns the new
 *  combined tags array for updateContent. */
export function withFolders(tags: string[], folders: string[]): string[] {
  const flat = tags.filter((t) => !isFolderTag(t));
  const cleaned = folders.map(normalizeFolderPath).filter(Boolean);
  // de-dup while keeping order: flat tags first, then unique folder paths
  return [...flat, ...Array.from(new Set(cleaned))];
}
