// Compact note row, mirrors TodoRow's role: shared between the Home
// personal-notes column and the personal notes drawer.

import { fmtRel } from '../lib/util';
import type { Note } from '../types';

interface Props {
  note: Note;
  onClick?: () => void;
}

export function NoteRow({ note, onClick }: Props) {
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
        <div className="ti">{note.title}</div>
        <div className="ti-sub">edited {fmtRel(at)}</div>
      </div>
      <span className="ats">{fmtRel(at)}</span>
    </div>
  );
}
