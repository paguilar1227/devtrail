import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal } from '../primitives';
import { createProject } from '../../lib/api';
import { useDirtyCloseGuard } from '../../lib/useDirtyCloseGuard';

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const mut = useMutation({
    mutationFn: () => createProject({ name: name.trim(), description: description.trim() || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['project-counts'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const submit = () => {
    setError(null);
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    mut.mutate();
  };

  const isDirty = name.trim().length > 0 || description.trim().length > 0;
  const tryClose = useDirtyCloseGuard(isDirty, onClose, mut.isPending);

  return (
    <Modal
      title="New project"
      onClose={tryClose}
      footer={
        <>
          <button className="btn" onClick={tryClose} disabled={mut.isPending}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={mut.isPending || !name.trim()}>
            {mut.isPending ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <label className="field-label">Name</label>
      <input
        className="input"
        placeholder="e.g. Mobile Companion"
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <div style={{ height: 12 }} />
      <label className="field-label">Description</label>
      <textarea
        className="input"
        rows={3}
        placeholder="One line about what this project is for…"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      {error ? (
        <div className="page-subtle" style={{ color: 'var(--danger)', marginTop: 8 }}>
          {error}
        </div>
      ) : null}
    </Modal>
  );
}
