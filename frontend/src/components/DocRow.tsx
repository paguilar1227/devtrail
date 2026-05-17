// Compact document row, mirrors NoteRow / TodoRow: shared between the Home
// personal-documents column and the personal documents drawer.
//
// Type icon matches the project DocumentsTab so users see the same glyph
// for the same kind of doc whether browsing personal or project-scoped.

import { Icons } from './Icons';
import { fmtRel } from '../lib/util';
import type { DocumentItem } from '../types';

interface Props {
  doc: DocumentItem;
  onClick?: () => void;
}

function TypeIcon({ type }: { type: DocumentItem['type'] }) {
  if (type === 'binary') return <Icons.Doc />;
  if (type === 'url') return <Icons.Globe />;
  return <Icons.Note />;
}

export function DocRow({ doc, onClick }: Props) {
  return (
    <div
      className="prow prow-doc"
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
      <span className="prow-doc-icon"><TypeIcon type={doc.type} /></span>
      <div>
        <div className="ti" title={doc.title}>{doc.title}</div>
        <div className="ti-sub">
          {doc.mime || doc.type}
          {doc.size ? ` · ${doc.size}` : ''}
        </div>
      </div>
      <span className="ats">{fmtRel(doc.created_at)}</span>
    </div>
  );
}
