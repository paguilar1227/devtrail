// Universal search input — wraps the home search box with cursor-aware
// typeahead. Three sigil contexts trigger their own suggestion lists:
//
//   #            → tags (filtered by prefix after #)
//   in:          → todo / note / document
//   @            → mentions: docs + notes by title
//
// Sigil detection uses tokenAtCursor (searchSyntax.ts). On selection,
// `#` and `in:` REPLACE the current partial with the canonical token via
// replaceTokenAtCursor. `@` fires `onMentionSelect` (the host navigates
// to the entity); the input is also updated with the resolved canonical
// `@"name"` so the user can re-trigger by clicking the chip later.
//
// Keyboard: ↑/↓ navigate the popover, Enter selects (or submits if no
// popover open), Esc dismisses the popover, Tab also selects (consistent
// with most autocomplete UIs).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Icons } from './Icons';
import { TypeaheadPopover, type TypeaheadItem } from './TypeaheadPopover';
import {
  replaceTokenAtCursor,
  tokenAtCursor,
} from '../lib/searchSyntax';

export interface MentionTarget {
  /** Display title — shown in the popover and inserted as `@"title"` */
  title: string;
  /** Underlying entity kind so the host can route correctly. */
  kind: 'document' | 'note';
  /** Entity UUID. */
  id: string;
}

export interface TagSuggestion {
  name: string;
  total: number;
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  /** Tag suggestions for `#` typeahead — full list, component prefix-filters. */
  tags: TagSuggestion[];
  /** Mention targets for `@` typeahead — docs + notes by title. */
  mentions: MentionTarget[];
  /** Called when user picks a mention from typeahead — host navigates. */
  onMentionSelect: (target: MentionTarget) => void;
  placeholder?: string;
}

type SigilContext =
  | { kind: 'tag'; prefix: string }
  | { kind: 'type'; prefix: string }
  | { kind: 'mention'; prefix: string }
  | null;

const TYPE_OPTIONS = [
  { value: 'todo', label: 'in:todo', sub: 'todos only' },
  { value: 'note', label: 'in:note', sub: 'notes only' },
  { value: 'document', label: 'in:document', sub: 'documents only' },
];

/** Inspect the token at the cursor and decide which sigil context applies. */
function detectSigilContext(input: string, cursor: number): SigilContext {
  const token = tokenAtCursor(input, cursor);
  if (token.startsWith('#')) {
    return { kind: 'tag', prefix: token.slice(1).toLowerCase() };
  }
  if (token.startsWith('in:')) {
    return { kind: 'type', prefix: token.slice(3).toLowerCase() };
  }
  if (token.startsWith('@"')) {
    return { kind: 'mention', prefix: token.slice(2).toLowerCase() };
  }
  if (token.startsWith('@')) {
    return { kind: 'mention', prefix: token.slice(1).toLowerCase() };
  }
  return null;
}

export function SearchInput({
  value,
  onChange,
  onSubmit,
  tags,
  mentions,
  onMentionSelect,
  placeholder,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [cursor, setCursor] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  // Dismissed = the user pressed Escape on the current sigil; suppress
  // the popover until the sigil context changes (cursor moves out / value
  // changes such that the context differs). Without this, Escape would
  // be a no-op while the user is still in the sigil.
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);

  // Recompute the sigil context whenever the input value or cursor moves.
  // Track the token text so dismissedToken can match against it.
  const currentToken = useMemo(() => tokenAtCursor(value, cursor), [value, cursor]);
  const sigil = useMemo(
    () => (dismissedToken === currentToken ? null : detectSigilContext(value, cursor)),
    [value, cursor, dismissedToken, currentToken],
  );

  // Build the suggestion list per sigil. activeIndex resets when items change.
  const items = useMemo<TypeaheadItem[]>(() => {
    if (!sigil) return [];
    if (sigil.kind === 'tag') {
      return tags
        .filter((t) => t.name.toLowerCase().startsWith(sigil.prefix))
        .slice(0, 8)
        .map((t) => ({
          key: `tag-${t.name}`,
          value: `#${t.name}`,
          label: `#${t.name}`,
          sublabel: t.total.toString(),
          icon: <Icons.Tag size={12} aria-hidden />,
        }));
    }
    if (sigil.kind === 'type') {
      return TYPE_OPTIONS.filter((o) => o.value.startsWith(sigil.prefix)).map((o) => ({
        key: `type-${o.value}`,
        value: o.label,
        label: o.label,
        sublabel: o.sub,
        icon: typeIcon(o.value),
      }));
    }
    // mention
    return mentions
      .filter((m) => m.title.toLowerCase().includes(sigil.prefix))
      .slice(0, 8)
      .map((m) => ({
        key: `mention-${m.id}`,
        // Quote if the title has whitespace; matches stringifySearchSyntax.
        value: /\s|"/.test(m.title) ? `@"${m.title}"` : `@${m.title}`,
        label: m.title,
        sublabel: m.kind,
        icon: m.kind === 'document' ? <Icons.Doc size={12} aria-hidden /> : <Icons.Note size={12} aria-hidden />,
      }));
  }, [sigil, tags, mentions]);

  useEffect(() => {
    setActiveIndex(0);
  }, [items]);

  // Clear the dismiss latch when the user moves to a fresh token.
  useEffect(() => {
    if (dismissedToken !== null && dismissedToken !== currentToken) {
      setDismissedToken(null);
    }
  }, [currentToken, dismissedToken]);

  const popoverOpen = sigil !== null && items.length > 0;

  const applyItem = (item: TypeaheadItem) => {
    if (!sigil) return;
    if (sigil.kind === 'mention') {
      // For mentions, find the original target so we can fire onMentionSelect.
      const target = mentions.find((m) => m.id === item.key.slice('mention-'.length));
      if (target) onMentionSelect(target);
    }
    const next = replaceTokenAtCursor(value, cursor, item.value);
    onChange(next.value);
    // Re-focus and reposition cursor after React commits the value change.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.cursor, next.cursor);
      setCursor(next.cursor);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (popoverOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => Math.min(items.length - 1, i + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const item = items[activeIndex];
        if (item) applyItem(item);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissedToken(currentToken);
        return;
      }
    }
    if (e.key === 'Enter') {
      onSubmit();
    }
  };

  // Track cursor position on every relevant input event. Without this, the
  // sigil context lags by a render whenever the user clicks or arrow-keys
  // around (no native event fires for selection changes from clicks alone).
  const syncCursor = () => {
    const el = inputRef.current;
    if (el) setCursor(el.selectionStart ?? el.value.length);
  };

  return (
    <div className="search-input-wrapper">
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          // selectionStart is the new cursor position after the input event.
          requestAnimationFrame(syncCursor);
        }}
        onSelect={syncCursor}
        onKeyUp={syncCursor}
        onClick={syncCursor}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-autocomplete="list"
        aria-expanded={popoverOpen}
        aria-controls={popoverOpen ? 'search-typeahead' : undefined}
      />
      {popoverOpen ? (
        <TypeaheadPopover
          items={items}
          activeIndex={activeIndex}
          onSelect={applyItem}
          onHover={setActiveIndex}
          onDismiss={() => setDismissedToken(currentToken)}
          ariaLabel={
            sigil!.kind === 'tag'
              ? 'Tag suggestions'
              : sigil!.kind === 'type'
                ? 'Type suggestions'
                : 'Mention suggestions'
          }
        />
      ) : null}
    </div>
  );
}

function typeIcon(value: string): ReactNode {
  if (value === 'todo') return <Icons.Check size={12} aria-hidden />;
  if (value === 'note') return <Icons.Note size={12} aria-hidden />;
  return <Icons.Doc size={12} aria-hidden />;
}
