// @vitest-environment node
// Parser is pure — no DOM needed. Overriding to skip jsdom (not currently
// installed; the global vitest.config defaults to jsdom for component tests).

import { describe, expect, it } from 'vitest';
import {
  parseSearchSyntax,
  stringifySearchSyntax,
  toggleTagInQuery,
  removeTagFromQuery,
  removeTypeFromQuery,
} from './searchSyntax';

describe('parseSearchSyntax — basics', () => {
  it('empty / whitespace → EMPTY', () => {
    expect(parseSearchSyntax('')).toEqual({ text: '', tags: [], types: [] });
    expect(parseSearchSyntax('   ')).toEqual({ text: '', tags: [], types: [] });
  });

  it('plain text is preserved as .text', () => {
    expect(parseSearchSyntax('quarterly report')).toEqual({
      text: 'quarterly report',
      tags: [],
      types: [],
    });
  });

  it('tag tokens move to .tags (lowercased)', () => {
    const p = parseSearchSyntax('#Home #READING');
    expect(p.tags).toEqual(['home', 'reading']);
    expect(p.text).toBe('');
  });

  it('duplicate tags are deduped, insertion order kept', () => {
    expect(parseSearchSyntax('#a #b #a #c').tags).toEqual(['a', 'b', 'c']);
  });

  it('in:<alias> resolves to canonical EntityKind', () => {
    expect(parseSearchSyntax('in:todo').types).toEqual(['todo']);
    expect(parseSearchSyntax('in:notes').types).toEqual(['note']);
    expect(parseSearchSyntax('in:doc in:document in:docs').types).toEqual(['document']);
  });

  it('mixed tokens — tags + types + text preserve as expected', () => {
    const p = parseSearchSyntax('quarterly #home in:doc report #q1');
    expect(p.tags).toEqual(['home', 'q1']);
    expect(p.types).toEqual(['document']);
    expect(p.text).toBe('quarterly report');
  });

  it('unknown in:<value> falls through to free text (user might be mid-typing)', () => {
    const p = parseSearchSyntax('in:wibble find me');
    expect(p.types).toEqual([]);
    expect(p.text).toBe('in:wibble find me');
  });

  it('whitespace is normalized — multiple spaces between tokens collapse', () => {
    expect(parseSearchSyntax('foo   #x    bar')).toEqual({
      text: 'foo bar',
      tags: ['x'],
      types: [],
    });
  });

  it('tag with hyphen is valid; trailing punctuation invalidates it', () => {
    expect(parseSearchSyntax('#open-brain').tags).toEqual(['open-brain']);
    // Trailing comma makes it not a tag token — falls to text.
    expect(parseSearchSyntax('#nope,').text).toBe('#nope,');
  });
});

describe('stringifySearchSyntax — round-trip', () => {
  it('predicates come first, then free text', () => {
    const s = stringifySearchSyntax({ text: 'find me', tags: ['x', 'y'], types: ['todo'] });
    expect(s).toBe('#x #y in:todo find me');
  });

  it('round-trip stable for canonical input', () => {
    const inputs = ['#home #reading in:todo find this', '#x', 'in:doc', 'free text only', ''];
    for (const input of inputs) {
      const parsed = parseSearchSyntax(input);
      const reparsed = parseSearchSyntax(stringifySearchSyntax(parsed));
      expect(reparsed).toEqual(parsed);
    }
  });

  it('round-trip normalizes order + canonicalizes type aliases', () => {
    // Input uses the `doc` alias; round-trip emits the canonical EntityKind name.
    const input = 'quarterly #home report in:doc';
    const stringified = stringifySearchSyntax(parseSearchSyntax(input));
    expect(stringified).toBe('#home in:document quarterly report');
  });
});

describe('toggleTagInQuery', () => {
  it('adds a tag when absent', () => {
    expect(toggleTagInQuery('find me', 'home')).toBe('#home find me');
  });

  it('removes a tag when present', () => {
    expect(toggleTagInQuery('#home #reading find me', 'home')).toBe('#reading find me');
  });

  it('tag matching is case-insensitive against the stored lowercased name', () => {
    expect(toggleTagInQuery('#home', 'HOME')).toBe('');
  });

  it('does not disturb the rest of the parse', () => {
    expect(toggleTagInQuery('#x in:todo q', 'y')).toBe('#x #y in:todo q');
  });
});

describe('removeTagFromQuery / removeTypeFromQuery', () => {
  it('removeTagFromQuery is idempotent when tag is absent', () => {
    expect(removeTagFromQuery('#a free', 'b')).toBe('#a free');
  });

  it('removeTypeFromQuery drops the matching type', () => {
    expect(removeTypeFromQuery('#a in:todo in:note q', 'todo')).toBe('#a in:note q');
  });
});
