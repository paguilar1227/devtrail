import { Icons } from './Icons';
import { Tag } from './primitives';
import type { SearchHit } from '../types';

interface Props {
  hits: SearchHit[];
  onOpen: (hit: SearchHit) => void;
}

// Card-level open: any click on the row opens the hit, EXCEPT when the
// user is actively selecting text (drag-to-copy). The selection check on
// click preserves "select an excerpt to copy" while making the rest of
// the card a hit target.
function hasActiveSelection() {
  const sel = window.getSelection();
  return !!sel && sel.toString().length > 0;
}

export function SearchResultsList({ hits, onOpen }: Props) {
  return (
    <div className="search-hits">
      {hits.map(h => (
        <div
          key={h.id}
          className="doc-row search-hit"
          onClick={() => {
            if (hasActiveSelection()) return;
            onOpen(h);
          }}
          role="button"
          tabIndex={-1}
        >
          <div className="ic-box">
            {h.entity_kind === 'document' ? <Icons.Doc /> : h.entity_kind === 'note' ? <Icons.Note /> : <Icons.Check />}
          </div>
          <div>
            <div className="row-flex gap-2 search-hit-head">
              <button
                type="button"
                className="search-hit-title"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(h);
                }}
              >
                {h.title}
              </button>
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
        </div>
      ))}
    </div>
  );
}
