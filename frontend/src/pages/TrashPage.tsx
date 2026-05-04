import { Icons } from '../components/Icons';
import { FilterChip } from '../components/primitives';

interface TrashItem {
  kind: 'project' | 'document' | 'note' | 'todo';
  title: string;
  at: string;
  sub: string;
}

const ITEMS: TrashItem[] = [
  { kind: 'project', title: 'MCP E2E Test v2', at: '3d ago', sub: 'delete me when done — run 2' },
  { kind: 'document', title: 'old-cli-spec-v1.pdf', at: '1d ago', sub: 'ClaudePit · failed embedding' },
  { kind: 'note', title: '[scratchpad] cookies vs tokens', at: '6d ago', sub: 'ClaudePit' },
  { kind: 'todo', title: 'Try out llamafile', at: '10d ago', sub: 'Inbox' },
];

export function TrashPage() {
  return (
    <div className="page page-narrow">
      <div className="proj-hero">
        <div>
          <h1>Archived</h1>
          <p className="page-subtle">
            Soft-deleted items. Restore brings them back; permanent delete requires typing the title to confirm. Items here are excluded
            from chat retrieval but remain searchable here.
          </p>
        </div>
        <button className="btn btn-danger">Empty archive</button>
      </div>
      <div className="filter-bar">
        <FilterChip active>
          All <span style={{ marginLeft: 4 }}>{ITEMS.length}</span>
        </FilterChip>
        <FilterChip>
          Projects <span style={{ marginLeft: 4 }}>1</span>
        </FilterChip>
        <FilterChip>Documents</FilterChip>
        <FilterChip>Notes</FilterChip>
        <FilterChip>Todos</FilterChip>
      </div>
      <div className="row-list">
        {ITEMS.map((it, i) => (
          <div key={i} className="row" style={{ gridTemplateColumns: '32px 1fr auto auto auto' }}>
            <div className="ic-box" style={{ width: 28, height: 28 }}>
              {it.kind === 'project' ? (
                <Icons.Folders size={13} />
              ) : it.kind === 'document' ? (
                <Icons.Doc size={13} />
              ) : it.kind === 'note' ? (
                <Icons.Note size={13} />
              ) : (
                <Icons.Check size={13} />
              )}
            </div>
            <div>
              <div className="strong">{it.title}</div>
              <div className="subtle mono" style={{ fontSize: 10.5, marginTop: 2 }}>
                {it.kind} · {it.sub} · archived {it.at}
              </div>
            </div>
            <button className="btn btn-ghost btn-sm">Restore</button>
            <button className="btn btn-danger btn-sm">Delete forever</button>
          </div>
        ))}
      </div>
    </div>
  );
}
