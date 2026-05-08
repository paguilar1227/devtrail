import { Icons } from './Icons';
import { Tag } from './primitives';
import type { SearchHit } from '../types';

export function SearchResultsList({ hits }: { hits: SearchHit[] }) {
  return (
    <div className="search-hits">
      {hits.map(h => (
        <div key={h.id} className="doc-row search-hit">
          <div className="ic-box">
            {h.entity_kind === 'document' ? <Icons.Doc /> : h.entity_kind === 'note' ? <Icons.Note /> : <Icons.Check />}
          </div>
          <div>
            <div className="row-flex gap-2 search-hit-head">
              <span className="search-hit-title">{h.title}</span>
              <Tag kind={h.entity_kind === 'document' ? 'doc' : h.entity_kind === 'note' ? 'note' : 'todo'}>
                {h.entity_kind}
              </Tag>
              <span className="search-hit-project subtle">{h.project}</span>
            </div>
            <div
              className="search-hit-excerpt"
              dangerouslySetInnerHTML={{ __html: h.excerpt }}
            />
            <div className="row-flex gap-1 search-hit-paths">
              {h.retrieval_path.map(p => (
                <span key={p} className="tag search-hit-path">{p}</span>
              ))}
              <span className="search-hit-score">score {h.score.toFixed(2)}</span>
            </div>
          </div>
          <button className="btn btn-ghost btn-sm">Open</button>
        </div>
      ))}
    </div>
  );
}
