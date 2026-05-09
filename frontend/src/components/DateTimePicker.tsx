// Hand-rolled date+time picker. Replaces <input type="datetime-local">
// because the native popup is browser-styled and impossible to reconcile
// with the rest of the UI.
//
// Behavior:
//   - Trigger button shows the formatted current value (or "No due date")
//     and toggles a popover.
//   - Popover contains: month nav + 7-col date grid (Sun-Sat), time row
//     (hour 1-12, minute 00-59, AM/PM toggle), and footer buttons:
//     Clear, Today, Done.
//   - The internal state is a draft that only commits on Done. Clear
//     and Done close the popover; Esc cancels and returns focus to the
//     trigger; mousedown outside also cancels.
//   - Keyboard nav on the grid: ←→ ±1 day, ↑↓ ±7 days, Enter commits.
//     Tab cycles through trigger → grid → time controls → footer.
//   - On open, focus moves to the selected day cell (or today's cell
//     when value is null). On close, focus returns to the trigger.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icons } from './Icons';
import { cls } from '../lib/util';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
// Single-letter weekday headers — Sun first to match the grid logic.
const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

interface Props {
  value: string | null;
  onChange: (iso: string | null) => void;
  disabled?: boolean;
}

interface Parts {
  date: Date;            // anchored at local midnight on the picked day
  hour: number;          // 1..12
  minute: number;        // 0..59
  ampm: 'am' | 'pm';
}

function partsFromIso(iso: string | null): Parts {
  if (iso) {
    const d = new Date(iso);
    let h = d.getHours();
    const ampm: 'am' | 'pm' = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return {
      date: new Date(d.getFullYear(), d.getMonth(), d.getDate()),
      hour: h,
      minute: d.getMinutes(),
      ampm,
    };
  }
  // Default for new picks: today at 9:00 AM. A blank canvas pre-set to
  // a reasonable working-hour beats rolling against midnight.
  const now = new Date();
  return {
    date: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
    hour: 9,
    minute: 0,
    ampm: 'am',
  };
}

function isoFromParts(p: Parts): string {
  const h24 = p.ampm === 'pm' ? (p.hour % 12) + 12 : p.hour % 12;
  const out = new Date(
    p.date.getFullYear(), p.date.getMonth(), p.date.getDate(),
    h24, p.minute, 0, 0,
  );
  return out.toISOString();
}

function formatTrigger(iso: string | null): string {
  if (!iso) return 'No due date';
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function buildGrid(view: Date): Date[] {
  // 6 rows × 7 cols. Start from the Sunday of the week that contains
  // the 1st of the month — gives consistent height regardless of
  // month length.
  const first = new Date(view.getFullYear(), view.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push(d);
  }
  return cells;
}

export function DateTimePicker({ value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const [draft, setDraft] = useState<Parts>(() => partsFromIso(value));
  const [view, setView] = useState<Date>(() => partsFromIso(value).date);

  // Re-seed draft from prop whenever the popover opens. Keeps the
  // draft transient — closing without Done discards local edits.
  useEffect(() => {
    if (open) {
      const p = partsFromIso(value);
      setDraft(p);
      setView(p.date);
    }
  }, [open, value]);

  // Close on outside click / Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Move focus to the selected day cell on open. Falls back to "today"
  // if the selected day isn't in the visible grid (shouldn't happen but
  // keeps the keyboard path resilient).
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      const cell =
        popRef.current?.querySelector<HTMLButtonElement>('.dtp-day.selected') ??
        popRef.current?.querySelector<HTMLButtonElement>('.dtp-day:not(.dim)');
      cell?.focus();
    });
  }, [open]);

  const today = new Date();
  const grid = useMemo(() => buildGrid(view), [view]);

  const moveMonth = (delta: number) =>
    setView((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));

  const setDayDraft = (d: Date) => {
    setDraft((p) => ({ ...p, date: new Date(d.getFullYear(), d.getMonth(), d.getDate()) }));
  };

  const commit = () => {
    onChange(isoFromParts(draft));
    setOpen(false);
    triggerRef.current?.focus();
  };

  const clear = () => {
    onChange(null);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const goToToday = () => {
    const t = new Date();
    setView(new Date(t.getFullYear(), t.getMonth(), 1));
    setDayDraft(t);
  };

  const onGridKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const handled = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' '];
    if (!handled.includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Enter' || e.key === ' ') {
      commit();
      return;
    }
    const delta =
      e.key === 'ArrowLeft' ? -1 :
      e.key === 'ArrowRight' ? 1 :
      e.key === 'ArrowUp' ? -7 : 7;
    const next = new Date(draft.date);
    next.setDate(next.getDate() + delta);
    setDayDraft(next);
    if (next.getMonth() !== view.getMonth() || next.getFullYear() !== view.getFullYear()) {
      setView(new Date(next.getFullYear(), next.getMonth(), 1));
    }
    requestAnimationFrame(() => {
      popRef.current?.querySelector<HTMLButtonElement>('.dtp-day.selected')?.focus();
    });
  };

  const onHourChange = (raw: string) => {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return;
    setDraft((p) => ({ ...p, hour: Math.max(1, Math.min(12, n)) }));
  };
  const onMinuteChange = (raw: string) => {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return;
    setDraft((p) => ({ ...p, minute: Math.max(0, Math.min(59, n)) }));
  };

  return (
    <div className="dtp-wrap">
      <button
        ref={triggerRef}
        type="button"
        className={cls('dtp-trigger', !value && 'empty')}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icons.Calendar size={13} />
        <span className="dtp-trigger-text">{formatTrigger(value)}</span>
        <Icons.ChevronDown size={11} />
      </button>
      {open ? (
        <div
          ref={popRef}
          className="dtp-pop"
          role="dialog"
          aria-modal="false"
          aria-label="Pick due date and time"
        >
          <div className="dtp-head">
            <button
              type="button"
              className="dtp-nav"
              onClick={() => moveMonth(-1)}
              aria-label="Previous month"
            >
              <Icons.ChevronLeft size={11} />
            </button>
            <div className="dtp-month">
              {MONTHS[view.getMonth()]} {view.getFullYear()}
            </div>
            <button
              type="button"
              className="dtp-nav"
              onClick={() => moveMonth(1)}
              aria-label="Next month"
            >
              <Icons.ChevronRight size={11} />
            </button>
          </div>
          <div className="dtp-weekdays" aria-hidden="true">
            {WEEKDAY_LABELS.map((d, i) => <span key={i}>{d}</span>)}
          </div>
          <div className="dtp-grid" onKeyDown={onGridKey} role="grid">
            {grid.map((d, i) => {
              const sel = isSameDay(d, draft.date);
              const dim = d.getMonth() !== view.getMonth();
              const isToday = isSameDay(d, today);
              return (
                <button
                  key={i}
                  type="button"
                  role="gridcell"
                  className={cls('dtp-day', sel && 'selected', dim && 'dim', isToday && 'today')}
                  tabIndex={sel ? 0 : -1}
                  onClick={() => setDayDraft(d)}
                  onDoubleClick={commit}
                  aria-label={d.toDateString()}
                  aria-selected={sel}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
          <div className="dtp-time">
            <span className="dtp-time-label">Time</span>
            <input
              type="number"
              className="dtp-num"
              min={1}
              max={12}
              value={draft.hour}
              onChange={(e) => onHourChange(e.target.value)}
              aria-label="Hour"
            />
            <span className="dtp-colon">:</span>
            <input
              type="number"
              className="dtp-num"
              min={0}
              max={59}
              value={draft.minute.toString().padStart(2, '0')}
              onChange={(e) => onMinuteChange(e.target.value)}
              aria-label="Minute"
            />
            <div className="dtp-ampm" role="radiogroup" aria-label="AM/PM">
              {(['am', 'pm'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={draft.ampm === m}
                  className={cls('dtp-ampm-b', draft.ampm === m && 'active')}
                  onClick={() => setDraft((p) => ({ ...p, ampm: m }))}
                >
                  {m.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div className="dtp-foot">
            <button type="button" className="dtp-foot-btn" onClick={clear}>Clear</button>
            <button type="button" className="dtp-foot-btn" onClick={goToToday}>Today</button>
            <button type="button" className="dtp-foot-btn primary" onClick={commit}>Done</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
