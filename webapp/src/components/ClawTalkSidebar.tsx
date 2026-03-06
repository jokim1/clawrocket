import { NavLink } from 'react-router-dom';

import type { Talk } from '../lib/api';

type Props = {
  talks: Talk[];
  loading: boolean;
  error: string | null;
  canManageSettings: boolean;
};

function ClawTalkMark(): JSX.Element {
  return (
    <span className="clawtalk-sidebar-brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M6.5 4.5c1.4 0 2.5 1.2 2.5 2.6V10l1.8-2.4c.7-.9 2-1.1 2.9-.4.9.7 1.1 2 .4 2.9l-.9 1.2h3.3c2.5 0 4.5 2 4.5 4.5v.8c0 1.4-1.1 2.5-2.5 2.5H9.6c-2.8 0-5.1-2.3-5.1-5.1V7.1c0-1.4.9-2.6 2-2.6Z" />
      </svg>
    </span>
  );
}

export function ClawTalkSidebar({
  talks,
  loading,
  error,
  canManageSettings,
}: Props): JSX.Element {
  return (
    <aside className="clawtalk-sidebar" aria-label="Primary navigation">
      <div className="clawtalk-sidebar-brand">
        <ClawTalkMark />
        <div>
          <strong>ClawTalk</strong>
          <span>Talk workspace</span>
        </div>
      </div>

      <nav className="clawtalk-sidebar-nav" aria-label="App sections">
        <NavLink
          to="/app/talks"
          end
          className={({ isActive }) =>
            `clawtalk-sidebar-link${isActive ? ' active' : ''}`
          }
        >
          Home
        </NavLink>
        {canManageSettings ? (
          <NavLink
            to="/app/settings"
            className={({ isActive }) =>
              `clawtalk-sidebar-link${isActive ? ' active' : ''}`
            }
          >
            Settings
          </NavLink>
        ) : null}
      </nav>

      <div className="clawtalk-sidebar-section">
        <div className="clawtalk-sidebar-section-label">Talks</div>
        <div className="clawtalk-sidebar-talks" aria-label="Talk list">
          {loading ? (
            <p className="clawtalk-sidebar-empty">Loading talks…</p>
          ) : error ? (
            <p className="clawtalk-sidebar-empty">{error}</p>
          ) : talks.length === 0 ? (
            <p className="clawtalk-sidebar-empty">No talks yet.</p>
          ) : (
            talks.map((talk) => (
              <NavLink
                key={talk.id}
                to={`/app/talks/${talk.id}`}
                className={({ isActive }) =>
                  `clawtalk-talk-link${isActive ? ' active' : ''}`
                }
              >
                <span className="clawtalk-talk-link-title">{talk.title}</span>
              </NavLink>
            ))
          )}
        </div>
      </div>
    </aside>
  );
}
