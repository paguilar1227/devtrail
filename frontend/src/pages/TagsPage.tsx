import { useState } from 'react';
import { Icons } from '../components/Icons';
import { TAGS } from '../lib/mock';
import type { ActionDispatch } from '../types';

interface Props {
  onAction: ActionDispatch;
}

export function TagsPage({ onAction }: Props) {
  const tags = TAGS;
  const [q, setQ] = useState('');
  const filtered = tags.filter(t => t.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="page page-narrow">
      <div className="proj-hero">
        <div>
          <h1>Tags</h1>
          <p className="page-subtle">
            {tags.length} tags across all projects. Renaming a tag updates every entity that uses it. Merging keeps both names searchable.
          </p>
        </div>
        <button className="btn">
          <Icons.Plus /> New tag
        </button>
      </div>

      <div className="todo-input-row">
        <div className="field">
          <Icons.Search />
          <input placeholder="Filter tags…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
      </div>

      <div className="row-list tags-list">
        {filtered.map(t => (
          <div key={t.name} className="tag-row">
            <span className="tag-glyph">#</span>
            <div className="tag-name strong mono">{t.name}</div>
            <div className="tag-counts">
              <span className="mono subtle">
                {t.total} <i>total</i>
              </span>
              <span className="mono subtle">
                {t.doc} <i>docs</i>
              </span>
              <span className="mono subtle">
                {t.note} <i>notes</i>
              </span>
              <span className="mono subtle">
                {t.todo} <i>todos</i>
              </span>
            </div>
            <div className="row-flex gap-1 tag-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => onAction({ kind: 'confirm-rename', payload: t })}>
                Rename
              </button>
              <button className="btn btn-ghost btn-icon">
                <Icons.More />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
