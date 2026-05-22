// Universal search-bar DSL — parses "free text #tag in:todo @name" into
// a structured payload the search API can consume, and reverses the
// parse for round-trip syncing with the home tag chip row.
//
// Grammar (whitespace-separated tokens, case-insensitive predicates):
//   #<tag>                — adds <tag> (lowercased) to .tags
//   in:<type>             — adds the resolved EntityKind to .types
//     aliases: todo|todos|note|notes|doc|docs|document|documents
//   @<bare-word>          — adds <bare-word> to .mentions (case preserved
//                           for display; consumer normalizes for resolve)
//   @"multi word name"    — same but allows whitespace in the name
//   anything else         — concatenated as free-text .text (semantic query)
//
// Unrecognized predicates (e.g. `foo:bar`, malformed `in:wibble`) fall
// through to .text verbatim — the user might be mid-typing, and dropping
// their input on the floor would be hostile. Same applies to `@` with no
// name and `@"unterminated` — preserved as text rather than swallowed.
//
// Order is preserved in parse so stringify(parse(s)) is stable up to
// whitespace normalization (single spaces, no leading/trailing).

import type { EntityKind } from '@open-brain/shared';

export interface ParsedQuery {
  /** Free-text portion — the actual semantic query passed to the API. */
  text: string;
  /** Tags from `#tag` predicates, lowercased + deduped, in insertion order. */
  tags: string[];
  /** EntityKinds from `in:` predicates, deduped, in insertion order. */
  types: EntityKind[];
  /** Mention names from `@name` / `@"name"` predicates, case preserved,
   *  deduped case-insensitively, in insertion order. Consumer resolves
   *  to entity IDs (documents / notes) — the parser stays unaware of
   *  the underlying data graph. */
  mentions: string[];
}

const EMPTY: ParsedQuery = { text: '', tags: [], types: [], mentions: [] };

/** Map a user-typed `in:<value>` to a canonical EntityKind. Returns null
 *  if the value isn't a recognized alias — caller falls back to free text. */
function resolveTypeAlias(value: string): EntityKind | null {
  switch (value.toLowerCase()) {
    case 'todo':
    case 'todos':
      return 'todo';
    case 'note':
    case 'notes':
      return 'note';
    case 'doc':
    case 'docs':
    case 'document':
    case 'documents':
      return 'document';
    default:
      return null;
  }
}

const TAG_TOKEN = /^#([a-z0-9][a-z0-9-]*)$/i;
const IN_TOKEN = /^in:([a-z]+)$/i;
const MENTION_BARE = /^@([^\s"]+)$/;
const MENTION_QUOTED = /^@"([^"]*)"$/;
// Unterminated quoted mention: requires AT LEAST one char after `@"` so
// `@""` (empty closed) and `@"` (just the opener) don't match here —
// both fall through to free text instead of becoming an empty mention.
const MENTION_UNTERMINATED = /^@"([^"]+)$/;

/**
 * Whitespace-aware tokenizer that keeps `@"multi word"` as a single token.
 * Quote tracking only engages immediately after a `@` — `email@host "foo"`
 * still tokenizes as two tokens, not one mention.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let inMentionQuote = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inMentionQuote) {
      cur += ch;
      if (ch === '"') inMentionQuote = false;
      continue;
    }
    if (ch === '"' && cur === '@') {
      cur += ch;
      inMentionQuote = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) tokens.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

export function parseSearchSyntax(input: string): ParsedQuery {
  const trimmed = input.trim();
  if (!trimmed) return EMPTY;
  const tokens = tokenize(trimmed);
  const tags: string[] = [];
  const types: EntityKind[] = [];
  const mentions: string[] = [];
  const text: string[] = [];
  const seenMention = new Set<string>(); // lowercased keys for case-insensitive dedup
  for (const tok of tokens) {
    const tag = tok.match(TAG_TOKEN);
    if (tag) {
      const name = tag[1]!.toLowerCase();
      if (!tags.includes(name)) tags.push(name);
      continue;
    }
    const inMatch = tok.match(IN_TOKEN);
    if (inMatch) {
      const kind = resolveTypeAlias(inMatch[1]!);
      if (kind) {
        if (!types.includes(kind)) types.push(kind);
        continue;
      }
      // Unknown in:<value> — fall through to free text below.
    }
    // Mention parse: quoted first (richer), then bare, then unterminated.
    const quoted = tok.match(MENTION_QUOTED);
    if (quoted) {
      const name = quoted[1]!.trim();
      if (name.length > 0) {
        const key = name.toLowerCase();
        if (!seenMention.has(key)) {
          seenMention.add(key);
          mentions.push(name);
        }
        continue;
      }
      // Empty quoted (@"") — fall through.
    }
    const bare = tok.match(MENTION_BARE);
    if (bare) {
      const name = bare[1]!;
      const key = name.toLowerCase();
      if (!seenMention.has(key)) {
        seenMention.add(key);
        mentions.push(name);
      }
      continue;
    }
    // Unterminated mention (user mid-typing `@"foo`) — capture what we
    // have so far so typeahead resolution can still happen as they type.
    // Detected only when there's actual content after the opening quote.
    const unterm = tok.match(MENTION_UNTERMINATED);
    if (unterm && unterm[1]!.length > 0) {
      const name = unterm[1]!;
      const key = name.toLowerCase();
      if (!seenMention.has(key)) {
        seenMention.add(key);
        mentions.push(name);
      }
      continue;
    }
    text.push(tok);
  }
  return { text: text.join(' '), tags, types, mentions };
}

/** Quote a mention name if it needs it (whitespace or other separators). */
function formatMention(name: string): string {
  return /\s|"/.test(name) ? `@"${name.replace(/"/g, '\\"')}"` : `@${name}`;
}

/** Inverse of parseSearchSyntax. Predicates come first (tags, types,
 *  mentions), free text last. Stable order so chip-row sync produces a
 *  predictable input string. */
export function stringifySearchSyntax(parsed: ParsedQuery): string {
  const tagParts = parsed.tags.map((t) => `#${t}`);
  const typeParts = parsed.types.map((t) => `in:${t}`);
  const mentionParts = parsed.mentions.map(formatMention);
  const allParts = [...tagParts, ...typeParts, ...mentionParts];
  if (parsed.text) allParts.push(parsed.text);
  return allParts.join(' ');
}

/** Toggle a tag in the parsed query (add if absent, remove if present).
 *  Used when a chip is clicked — preserves the rest of the parse. */
export function toggleTagInQuery(input: string, tag: string): string {
  const parsed = parseSearchSyntax(input);
  const lower = tag.toLowerCase();
  const next: ParsedQuery = {
    ...parsed,
    tags: parsed.tags.includes(lower)
      ? parsed.tags.filter((t) => t !== lower)
      : [...parsed.tags, lower],
  };
  return stringifySearchSyntax(next);
}

/** Remove a single tag from the parsed query (idempotent — no-op if absent). */
export function removeTagFromQuery(input: string, tag: string): string {
  const parsed = parseSearchSyntax(input);
  const lower = tag.toLowerCase();
  return stringifySearchSyntax({ ...parsed, tags: parsed.tags.filter((t) => t !== lower) });
}

/** Remove a single entity type from the parsed query. */
export function removeTypeFromQuery(input: string, type: EntityKind): string {
  const parsed = parseSearchSyntax(input);
  return stringifySearchSyntax({ ...parsed, types: parsed.types.filter((t) => t !== type) });
}

/** Cursor-aware token-at-position detection — figures out which token (if
 *  any) the user is currently typing into. Quote-aware: `@"foo bar`
 *  (mid-typing) is treated as one token even though it contains whitespace.
 *
 *  Uses the same tokenizer logic as parseSearchSyntax (quote-mode after `@"`)
 *  and returns the prefix of the token that ends at or contains the cursor. */
export function tokenAtCursor(input: string, cursor: number): string {
  if (cursor <= 0) return '';
  // Re-tokenize while tracking positions; find the token whose range
  // contains the cursor. If the cursor sits exactly on a whitespace
  // boundary, no token is active → return ''.
  let cur = '';
  let tokenStart = 0;
  let inMentionQuote = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (i === cursor) {
      // Cursor is inside (or at start of) current token.
      return cur;
    }
    if (inMentionQuote) {
      cur += ch;
      if (ch === '"') inMentionQuote = false;
      continue;
    }
    if (ch === '"' && cur === '@') {
      cur += ch;
      inMentionQuote = true;
      continue;
    }
    if (/\s/.test(ch)) {
      // Token boundary hit BEFORE cursor — reset and keep going.
      cur = '';
      tokenStart = i + 1;
      continue;
    }
    cur += ch;
  }
  // Loop finished without reaching cursor — cursor is at/after the last
  // char. Return the last token built (or '' if it ended in whitespace).
  if (cursor >= tokenStart) return cur;
  return '';
}

/** Replace the token at cursor with a new value, preserving everything
 *  else. Returns the new input + the new cursor position. Used by
 *  typeahead-selection handlers — clicking a suggestion completes the
 *  current token cleanly. Appends a trailing space only when there
 *  isn't already a whitespace at the cursor (so inserting mid-input
 *  doesn't accumulate double spaces). */
export function replaceTokenAtCursor(
  input: string,
  cursor: number,
  replacement: string,
): { value: string; cursor: number } {
  const token = tokenAtCursor(input, cursor);
  const tokenStart = cursor - token.length;
  const before = input.slice(0, tokenStart);
  const after = input.slice(cursor);
  // Skip trailing space when the existing tail ALREADY starts with whitespace
  // (avoids double-space mid-input). At end-of-input we DO add a space so
  // the user can keep typing more tokens without manually inserting one.
  const trailing = /^\s/.test(after) ? '' : ' ';
  const value = `${before}${replacement}${trailing}${after}`;
  return { value, cursor: tokenStart + replacement.length + trailing.length };
}
