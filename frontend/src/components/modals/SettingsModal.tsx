// Settings — overlay over the current page so dismissing it returns
// the user to where they were. Routed-page version was removed because
// closing it left users stranded one nav-click away from their work.
import { Icons } from '../Icons';
import { Modal } from '../primitives';
import { logout } from '../../lib/api';
import { cls } from '../../lib/util';
import type { Theme } from '../../types';

interface Props {
  theme: Theme;
  onTheme: (t: Theme) => void;
  onClose: () => void;
}

const APP_VERSION = '2.5';

export function SettingsModal({ theme, onTheme, onClose }: Props) {
  return (
    <Modal title="Settings" size="lg" onClose={onClose}>
      <div className="settings-card">
        <div className="settings-row">
          <div>
            <div className="settings-row-h">Appearance</div>
            <div className="page-subtle">Switch between dark and light themes. Shortcut · ⌘⇧L</div>
          </div>
          <div className="thm-toggle">
            <button
              className={cls(theme === 'dark' && 'active')}
              onClick={() => onTheme('dark')}
              aria-label="Dark theme"
            >
              <Icons.Moon size={13} />
            </button>
            <button
              className={cls(theme === 'light' && 'active')}
              onClick={() => onTheme('light')}
              aria-label="Light theme"
            >
              <Icons.Sun size={13} />
            </button>
          </div>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-row">
          <div>
            <div className="settings-row-h">Account</div>
            <div className="page-subtle">Signed in as you@example.com</div>
          </div>
          <button className="btn btn-danger" onClick={logout}>
            Log out
          </button>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-row">
          <div>
            <div className="settings-row-h">About</div>
            <div className="page-subtle">Open Brain v{APP_VERSION}</div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
