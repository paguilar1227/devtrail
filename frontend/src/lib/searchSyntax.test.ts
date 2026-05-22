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
  tokenAtCursor,
  replaceTokenAtCursor,
} from './searchSyntax';

describe('parseSearchSyntax — basics', () => {
  it('empty / whitespace → EMPTY', () => {
    expect(parseSearchSyntax('')).toEqual({ text: '', tags: [], types: [], mentions: [] });
    expect(parseSearchSyntax('   ')).toEqual({ text: '', tags: [], types: [], mentions: [] });
  });

  it('plain text is preserved as .text', () => {
    expect(parseSearchSyntax('quarterly report')).toEqual({
      text: 'quarterly report',
      tags: [],
      types: [],
      mentions: [],
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
      mentions: [],
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
    const s = stringifySearchSyntax({ text: 'find me', tags: ['x', 'y'], types: ['todo'], mentions: [] });
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

describe('parseSearchSyntax — mentions (@name)', () => {
  it('bare @name moves to .mentions, case preserved', () => {
    const p = parseSearchSyntax('@Books');
    expect(p.mentions).toEqual(['Books']);
    expect(p.text).toBe('');
  });

  it('quoted @"multi word" allows whitespace in the name', () => {
    const p = parseSearchSyntax('@"Gift ideas — dad birthday"');
    expect(p.mentions).toEqual(['Gift ideas — dad birthday']);
    expect(p.text).toBe('');
  });

  it('mentions dedupe case-insensitively but preserve first-seen casing', () => {
    expect(parseSearchSyntax('@Books @books @BOOKS').mentions).toEqual(['Books']);
  });

  it('unterminated quoted mention (mid-typing) is captured, not dropped', () => {
    const p = parseSearchSyntax('@"q1 rep');
    expect(p.mentions).toEqual(['q1 rep']);
    expect(p.text).toBe('');
  });

  it('@ alone or @"" falls through to text', () => {
    expect(parseSearchSyntax('@').text).toBe('@');
    expect(parseSearchSyntax('@""').text).toBe('@""');
  });

  it('email-style `foo@bar` is NOT a mention (the @ is mid-token)', () => {
    const p = parseSearchSyntax('email@gmail.com');
    expect(p.mentions).toEqual([]);
    expect(p.text).toBe('email@gmail.com');
  });

  it('mixed predicates + mentions + text parse independently', () => {
    const p = parseSearchSyntax('#home @Books in:todo find this');
    expect(p.tags).toEqual(['home']);
    expect(p.types).toEqual(['todo']);
    expect(p.mentions).toEqual(['Books']);
    expect(p.text).toBe('find this');
  });
});

describe('stringifySearchSyntax — mentions', () => {
  it('quoting is applied only when the name contains whitespace', () => {
    expect(
      stringifySearchSyntax({ text: '', tags: [], types: [], mentions: ['Books'] }),
    ).toBe('@Books');
    expect(
      stringifySearchSyntax({ text: '', tags: [], types: [], mentions: ['Q1 report'] }),
    ).toBe('@"Q1 report"');
  });

  it('round-trip stable for mentions + mixed predicates', () => {
    const input = '#home in:todo @Books @"Q1 report" find me';
    const stringified = stringifySearchSyntax(parseSearchSyntax(input));
    expect(parseSearchSyntax(stringified)).toEqual(parseSearchSyntax(input));
  });
});

describe('tokenAtCursor — cursor-aware sigil detection', () => {
  it('returns empty when cursor at position 0', () => {
    expect(tokenAtCursor('', 0)).toBe('');
    expect(tokenAtCursor('foo', 0)).toBe('');
  });

  it('returns the partial token between last whitespace and cursor', () => {
    expect(tokenAtCursor('hello #ho', 9)).toBe('#ho');
    expect(tokenAtCursor('hello #ho', 7)).toBe('#');
    expect(tokenAtCursor('in:to', 5)).toBe('in:to');
  });

  it('returns empty when cursor sits right after a whitespace', () => {
    expect(tokenAtCursor('hello ', 6)).toBe('');
  });

  it('captures the full @"partial inside a quoted mention', () => {
    expect(tokenAtCursor('foo @"Q1 re', 11)).toBe('@"Q1 re');
  });

  it('plain bare @partial works mid-typing', () => {
    expect(tokenAtCursor('foo @Boo', 8)).toBe('@Boo');
  });
});

describe('replaceTokenAtCursor', () => {
  it('replaces current partial with the replacement + trailing space', () => {
    const r = replaceTokenAtCursor('hello #ho', 9, '#home');
    expect(r.value).toBe('hello #home ');
    expect(r.cursor).toBe(12);
  });

  it('skips trailing space when the tail already starts with one', () => {
    // Input: 'foo @Bo bar'. Token at cursor=7 is '@Bo' (3 chars). Replace
    // with '@"Books — wishlist"'. The existing ' bar' already starts with
    // whitespace, so no double-space is introduced.
    const r = replaceTokenAtCursor('foo @Bo bar', 7, '@"Books — wishlist"');
    expect(r.value).toBe('foo @"Books — wishlist" bar');
    expect(r.cursor).toBe(4 + '@"Books — wishlist"'.length);
  });
});
