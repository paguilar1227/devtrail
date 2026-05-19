import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { cls } from '../lib/util';
import { Icons } from './Icons';
import { toggleTag, type TagFilter } from '../lib/tagFilter';

interface TagOption {
  name: string;
  total: number;
}

interface Props {
  /** Full personal-scope tag list, NOT pre-sliced — the component
   *  decides how many to show via `visibleCap`. */
  options: TagOption[];
  filter: TagFilter;
  onChange: (next: TagFilter) => void;
  visibleCap?: number;
}

// Chip row + AND/OR toggle + Clear. Roving-tabindex over the chip set
// (per WAI-ARIA toolbar pattern). Mode + Clear sit OUTSIDE the toolbar
// so they don't break the roving model — they're reachable via normal
// Tab navigation.
export function HomeTagFilter({ options, filter, onChange, visibleCap = 15 }: Props) {
  const [showAll, setShowAll] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);

  const chips = useMemo(() => {
    const visible = (showAll ? options : options.slice(0, visibleCap)).map((o) => ({
      name: o.name,
      total: o.total,
      known: true,
    }));
    const visibleNames = new Set(visible.map((c) => c.name));
    const orphans = filter.tags
      .filter((t) => !visibleNames.has(t))
      .map((name) => ({ name, total: 0, known: false }));
    return [...orphans, ...visible];
  }, [options, showAll, visibleCap, filter.tags]);

  const overflowCount = !showAll && options.length > visibleCap ? options.length - visibleCap : 0;
  // Toggle chip is visible whenever there's something to expand OR collapse —
  // i.e. options.length > visibleCap regardless of showAll state. Without
  // this, expand was one-way (the chip vanished after clicking it).
  const showToggleChip = options.length > visibleCap;
  const totalFocusable = chips.length + (showToggleChip ? 1 : 0);

  // Clamp activeIndex when the chip set shrinks (e.g. user clears tags
  // while focus was on an orphan that disappears). Without this, tabIndex=0
  // ends up on no chip, breaking Tab entry to the toolbar.
  useEffect(() => {
    if (totalFocusable === 0) {
      setActiveIndex(0);
      return;
    }
    setActiveIndex((i) => Math.max(0, Math.min(i, totalFocusable - 1)));
  }, [totalFocusable]);

  const focusAt = (i: number) => {
    const clamped = Math.max(0, Math.min(i, totalFocusable - 1));
    setActiveIndex(clamped);
    buttonsRef.current[clamped]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        focusAt(activeIndex + 1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        focusAt(activeIndex - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusAt(0);
        break;
      case 'End':
        e.preventDefault();
        focusAt(totalFocusable - 1);
        break;
    }
  };

  const onClickChip = (name: string) => onChange(toggleTag(filter, name));
  const onClear = () => onChange({ tags: [], mode: 'or' });
  const setMode = (mode: 'or' | 'and') => {
    if (filter.mode !== mode) onChange({ ...filter, mode });
  };

  const isSelected = (name: string) => filter.tags.includes(name);
  const hasActiveFilter = filter.tags.length > 0;
  const showModeToggle = filter.tags.length >= 2;

  return (
    <div className={cls('home-tag-filter', showAll && 'expanded')} data-tag-filter>
      <div
        className="home-tag-filter-chips"
        role="toolbar"
        aria-label="Filter by tags"
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
      >
        {chips.map((chip, i) => (
          <button
            key={chip.name}
            ref={(el) => {
              buttonsRef.current[i] = el;
            }}
            type="button"
            className={cls('home-filter-chip', isSelected(chip.name) && 'active', !chip.known && 'orphan')}
            aria-pressed={isSelected(chip.name)}
            tabIndex={i === activeIndex ? 0 : -1}
            onClick={() => onClickChip(chip.name)}
            onFocus={() => setActiveIndex(i)}
          >
            #{chip.name}
            {chip.known && chip.total > 0 ? (
              <span className="home-filter-chip-count">{chip.total}</span>
            ) : null}
          </button>
        ))}
        {showToggleChip ? (
          <button
            key="__more"
            ref={(el) => {
              buttonsRef.current[chips.length] = el;
            }}
            type="button"
            className="home-filter-chip home-filter-chip-more"
            tabIndex={chips.length === activeIndex ? 0 : -1}
            aria-label={showAll ? `Collapse to top ${visibleCap} tags` : `Show all ${options.length} tags`}
            onClick={() => setShowAll((v) => !v)}
            onFocus={() => setActiveIndex(chips.length)}
          >
            {showAll ? '− show less' : `+${overflowCount} more`}
          </button>
        ) : null}
      </div>

      {showModeToggle ? (
        <div className="home-tag-filter-mode" role="radiogroup" aria-label="Filter mode">
          <button
            type="button"
            role="radio"
            className={cls('home-tag-filter-mode-btn', filter.mode === 'or' && 'active')}
            aria-checked={filter.mode === 'or'}
            onClick={() => setMode('or')}
          >
            OR
          </button>
          <button
            type="button"
            role="radio"
            className={cls('home-tag-filter-mode-btn', filter.mode === 'and' && 'active')}
            aria-checked={filter.mode === 'and'}
            onClick={() => setMode('and')}
          >
            AND
          </button>
        </div>
      ) : null}

      {hasActiveFilter ? (
        <button
          type="button"
          className="home-tag-filter-clear"
          onClick={onClear}
          aria-label="Clear tag filter"
        >
          <Icons.X size={11} aria-hidden /> Clear
        </button>
      ) : null}
    </div>
  );
}

interface FilterEmptyProps {
  entity: 'todos' | 'notes' | 'documents';
  filter: TagFilter;
}

export function FilterEmpty({ entity, filter }: FilterEmptyProps) {
  const tags = filter.tags.map((t) => `#${t}`).join(filter.mode === 'and' ? ' AND ' : ' or ');
  return (
    <div className="pcol-empty">
      No {entity} with {filter.tags.length === 1 ? 'tag' : 'tags'} {tags}.
    </div>
  );
}
