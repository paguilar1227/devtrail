import { Icons } from './Icons';
import { Tag } from './primitives';
import type { SearchHit } from '../types';

export function SearchResultsList({ hits }: { hits: SearchHit[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {hits.map(h => (
        <div key={h.id} className="doc-row" style={{ gridTemplateColumns: '32px 1fr auto auto' }}>
          <div className="ic-box">
            {h.entity_kind === 'document' ? <Icons.Doc /> : h.entity_kind === 'note' ? <Icons.Note /> : <Icons.Check />}
          </div>
          <div>
            <div className="row-flex gap-2">
              <span className="strong" style={{ fontSize: 13 }}>
                {h.title}
              </span>
              <Tag kind={h.entity_kind === 'document' ? 'doc' : h.entity_kind === 'note' ? 'note' : 'todo'}>
                {h.entity_kind}
              </Tag>
              <span className="subtle mono" style={{ fontSize: 10.5 }}>
                {h.project}
              </span>
            </div>
            <div
              style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 4, lineHeight: 1.5, fontFamily: 'var(--font-mono)' }}
              dangerouslySetInnerHTML={{ __html: h.excerpt }}
            />
            <div
              className="row-flex gap-1"
              style={{ marginTop: 6, fontSize: 10, color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}
            >
              {h.retrieval_path.map(p => (
                <span key={p} className="tag" style={{ fontSize: 9.5 }}>
                  {p}
                </span>
              ))}
              <span style={{ marginLeft: 6 }}>score {h.score.toFixed(2)}</span>
            </div>
          </div>
          <button className="btn btn-ghost btn-sm">Open</button>
        </div>
      ))}
    </div>
  );
}
