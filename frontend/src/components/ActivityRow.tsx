// Single source of truth for an activity feed row, used by both the
// Recent Activity widget on Home and the dedicated /activity page.
// Anything that should look or behave the same across both surfaces
// belongs here. Layout-level differences (size, padding, density) are
// expressed as parent-scoped CSS overrides on .stat-activity so the
// markup stays identical.

import { Icons } from './Icons';
import { cls, fmtRel } from '../lib/util';
import type { ActivityEvent } from '../types';

interface Props {
  activity: ActivityEvent;
  // Whether to show the entity kind (note/todo/document) inline next to
  // the project name. The Home widget hides it to stay compact; the
  // dedicated /activity page shows it as orientation.
  showEntityKind?: boolean;
  onClick?: () => void;
}

const KIND_LABEL: Record<ActivityEvent['kind'], string> = {
  ingest: 'Ingested',
  edit: 'Edited',
  comment: 'Commented on',
};

function KindIcon({ kind }: { kind: ActivityEvent['kind'] }) {
  if (kind === 'ingest') return <Icons.Upload size={12} />;
  if (kind === 'edit') return <Icons.Note size={12} />;
  return <Icons.Chat size={12} />;
}

export function ActivityRow({ activity, showEntityKind = false, onClick }: Props) {
  const a = activity;
  return (
    <div
      className="activity-row"
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
      <span className={cls('activity-icon', a.kind)}>
        <KindIcon kind={a.kind} />
      </span>
      <span className="text">
        {KIND_LABEL[a.kind]} <b>{a.title}</b>
        <span className="subtle activity-row-meta">
          {' · '}{showEntityKind ? `${a.entity_kind} · ` : ''}{a.project}
        </span>
      </span>
      <span className="ts">{fmtRel(a.at)}</span>
    </div>
  );
}
