// Universal search-bar DSL — parses "free text #tag in:todo" into a
// structured payload the search API can consume directly, and reverses
// the parse for round-trip syncing with the home tag chip row.
//
// Grammar (whitespace-separated tokens, case-insensitive predicates):
//   #<tag>                — adds <tag> (lowercased) to .tags
//   in:<type>             — adds the resolved EntityKind to .types
//     aliases: todo|todos|note|notes|doc|docs|document|documents
//   anything else         — concatenated as free-text .text (semantic query)
//
// Unrecognized predicates (e.g. `foo:bar`, malformed `in:wibble`) fall
// through to .text verbatim — the user might be mid-typing, and dropping
// their input on the floor would be hostile.
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
}

const EMPTY: ParsedQuery = { text: '', tags: [], types: [] };

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

export function parseSearchSyntax(input: string): ParsedQuery {
  const trimmed = input.trim();
  if (!trimmed) return EMPTY;
  const tokens = trimmed.split(/\s+/);
  const tags: string[] = [];
  const types: EntityKind[] = [];
  const text: string[] = [];
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
    text.push(tok);
  }
  return { text: text.join(' '), tags, types };
}

/** Inverse of parseSearchSyntax. Predicates come first (tags, then types),
 *  free text last. Stable order so chip-row sync produces a predictable
 *  input string. */
export function stringifySearchSyntax(parsed: ParsedQuery): string {
  const tagParts = parsed.tags.map((t) => `#${t}`);
  const typeParts = parsed.types.map((t) => `in:${t}`);
  const allParts = [...tagParts, ...typeParts];
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
