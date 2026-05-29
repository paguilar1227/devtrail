// @vitest-environment node
// Pure logic — no DOM. Runs in node so it doesn't require jsdom (the repo's
// default vitest env), keeping this test runnable on its own.
import { describe, it, expect } from 'vitest';
import {
  isFolderTag, splitTags, normalizeFolderPath, buildFolderTree, noteInFolder, withFolders,
} from './folders';

describe('isFolderTag', () => {
  it('treats slash-containing tags as folders, flat tags as not', () => {
    expect(isFolderTag('cooking/italian')).toBe(true);
    expect(isFolderTag('chore')).toBe(false);
  });
});

describe('splitTags', () => {
  it('separates flat tags from folder paths', () => {
    const { flat, folders } = splitTags(['chore', 'cooking/italian', 'reading', 'travel/japan']);
    expect(flat).toEqual(['chore', 'reading']);
    expect(folders).toEqual(['cooking/italian', 'travel/japan']);
  });
});

describe('normalizeFolderPath', () => {
  it('trims segments and drops blank/edge separators', () => {
    expect(normalizeFolderPath(' cooking / italian / ')).toBe('cooking/italian');
    expect(normalizeFolderPath('//a//b//')).toBe('a/b');
    expect(normalizeFolderPath('   ')).toBe('');
  });
});

describe('buildFolderTree', () => {
  const notes = [
    { tags: ['cooking/italian/dessert', 'chore'] },
    { tags: ['cooking/coffee'] },
    { tags: ['cooking/italian'] },
    { tags: ['reading'] }, // flat only → not in the tree
  ];

  it('builds a nested tree from slash-tags only', () => {
    const roots = buildFolderTree(notes);
    expect(roots.map((r) => r.name)).toEqual(['cooking']); // 'reading' is flat → excluded
    const cooking = roots[0]!;
    expect(cooking.children.map((c) => c.name).sort()).toEqual(['coffee', 'italian']);
    const italian = cooking.children.find((c) => c.name === 'italian')!;
    expect(italian.children.map((c) => c.name)).toEqual(['dessert']);
  });

  it('counts a note at every ancestor exactly once', () => {
    const roots = buildFolderTree(notes);
    const cooking = roots[0]!;
    // 3 notes touch cooking/*: italian/dessert, coffee, italian
    expect(cooking.noteCount).toBe(3);
    const italian = cooking.children.find((c) => c.name === 'italian')!;
    // italian + italian/dessert → 2 distinct notes
    expect(italian.noteCount).toBe(2);
    expect(cooking.children.find((c) => c.name === 'coffee')!.noteCount).toBe(1);
  });
});

describe('noteInFolder', () => {
  it('matches exact path and descendants, not siblings/prefixes', () => {
    expect(noteInFolder(['cooking/italian'], 'cooking/italian')).toBe(true);       // exact
    expect(noteInFolder(['cooking/italian/dessert'], 'cooking/italian')).toBe(true); // descendant
    expect(noteInFolder(['cooking/italian'], 'cooking')).toBe(true);               // ancestor selects descendant
    expect(noteInFolder(['cooking/italian-extra'], 'cooking/italian')).toBe(false); // prefix, not a path boundary
    expect(noteInFolder(['travel/japan'], 'cooking')).toBe(false);                 // unrelated
    expect(noteInFolder(['chore'], 'cooking')).toBe(false);                        // flat tag
  });
});

describe('withFolders', () => {
  it('replaces folder paths while preserving flat tags, normalized + deduped', () => {
    const result = withFolders(['chore', 'cooking/old', 'reading'], ['cooking/new', ' travel / japan ', 'cooking/new']);
    expect(result).toEqual(['chore', 'reading', 'cooking/new', 'travel/japan']);
  });
});
