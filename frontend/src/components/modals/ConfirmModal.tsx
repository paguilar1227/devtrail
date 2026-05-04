import { useState, type ReactNode } from 'react';
import { Modal } from '../primitives';
import { cls } from '../../lib/util';

interface Props {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  requireType?: string;
  onClose: () => void;
  onConfirm: () => void;
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = 'Delete forever',
  danger = true,
  requireType,
  onClose,
  onConfirm,
}: Props) {
  const [typed, setTyped] = useState('');
  const ok = !requireType || typed === requireType;
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className={cls('btn', danger ? 'btn-danger' : 'btn-primary')} disabled={!ok} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p style={{ fontSize: 13.5, lineHeight: 1.6, margin: 0, color: 'var(--fg-muted)' }}>{message}</p>
      {requireType ? (
        <>
          <div className="divider" />
          <label className="field-label">
            Type{' '}
            <span className="mono" style={{ color: 'var(--fg)', textTransform: 'none' }}>
              "{requireType}"
            </span>{' '}
            to confirm
          </label>
          <input className="input input-mono" value={typed} onChange={e => setTyped(e.target.value)} autoFocus />
        </>
      ) : null}
    </Modal>
  );
}
