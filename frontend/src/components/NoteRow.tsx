// Compact note row, mirrors TodoRow's role: shared between the Home
// personal-notes column and the personal notes drawer.

import { fmtRel } from '../lib/util';
import { Tag } from './primitives';

interface Props {
  // Structural minimum the row renders — a full Note satisfies it, and a
  // search hit (which carries no timestamps) can populate title + sub.
  note: { title: string; created_at?: string; updated_at?: string };
  onClick?: () => void;
  /** Override the sub-line (e.g. a search-match snippet). When set, the
   *  right-side timestamp is omitted since hits carry no edited time. */
  sub?: string;
  /** Tags to render as chips under the sub-line. Lets the drawer show
   *  provenance so a #tag filter's completeness is obvious. */
  tags?: string[];
}

export function NoteRow({ note, onClick, sub, tags }: Props) {
  const at = note.updated_at ?? note.created_at;
  return (
    <div
      className="prow prow-note"
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      } : undefined}
    >
      <div>
        <div className="ti" title={note.title}>{note.title}</div>
        <div className="ti-sub">{sub ?? (at ? `edited ${fmtRel(at)}` : '')}</div>
        {tags && tags.length > 0 ? (
          <div className="prow-tags">
            {tags.map((t) => <Tag key={t}>{t}</Tag>)}
          </div>
        ) : null}
      </div>
      {sub == null && at ? <span className="ats">{fmtRel(at)}</span> : null}
    </div>
  );
}
