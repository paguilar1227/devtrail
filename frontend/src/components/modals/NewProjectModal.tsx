import { Modal } from '../primitives';
import { cls } from '../../lib/util';
import type { ProjectAccent } from '../../types';

const ACCENTS: ProjectAccent[] = ['violet', 'magenta', 'indigo', 'cyan', 'neutral'];

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="New project"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary">Create</button>
        </>
      }
    >
      <label className="field-label">Name</label>
      <input className="input" placeholder="e.g. Mobile Companion" autoFocus />
      <div style={{ height: 12 }} />
      <label className="field-label">Description</label>
      <textarea className="input" rows={3} placeholder="One line about what this project is for…" />
      <div style={{ height: 12 }} />
      <label className="field-label">Accent color</label>
      <div className="row-flex gap-2">
        {ACCENTS.map(c => (
          <span
            key={c}
            className={cls('sb-proj-dot', c)}
            style={{ width: 22, height: 22, borderRadius: 6, cursor: 'default' }}
          />
        ))}
      </div>
    </Modal>
  );
}
