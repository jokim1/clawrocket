import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { ClawTalkSidebar } from './components/ClawTalkSidebar';
import { SignInView } from './components/SignInView';
import {
  getSessionMe,
  listTalks,
  logout as logoutSession,
  SessionUser,
  Talk,
  UnauthorizedError,
} from './lib/api';
import { AiAgentsPage } from './pages/AiAgentsPage';
import { TalkDetailPage } from './pages/TalkDetailPage';
import { TalkListPage } from './pages/TalkListPage';
import { SettingsPage } from './pages/SettingsPage';

type AuthState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'authenticated'; user: SessionUser };

export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [talks, setTalks] = useState<Talk[]>([]);
  const [talksLoading, setTalksLoading] = useState(true);
  const [talksError, setTalksError] = useState<string | null>(null);

  const refreshSession = useCallback(async () => {
    try {
      const user = await getSessionMe();
      setAuth({ status: 'authenticated', user });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        setAuth({ status: 'unauthenticated' });
        return;
      }
      setAuth({ status: 'unauthenticated' });
    }
  }, []);

  const handleUnauthorized = useCallback(() => {
    setAuth({ status: 'unauthenticated' });
  }, []);

  const handleSignOut = useCallback(async () => {
    if (signOutBusy) return;
    setSignOutBusy(true);
    try {
      await logoutSession();
    } finally {
      setAuth({ status: 'unauthenticated' });
      setSignOutBusy(false);
    }
  }, [signOutBusy]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const refreshTalks = useCallback(async () => {
    try {
      const rows = await listTalks();
      setTalks(rows);
      setTalksError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setTalksError(err instanceof Error ? err.message : 'Failed to load talks');
    } finally {
      setTalksLoading(false);
    }
  }, [handleUnauthorized]);

  useEffect(() => {
    if (auth.status !== 'authenticated') {
      setTalks([]);
      setTalksLoading(true);
      setTalksError(null);
      return;
    }
    void refreshTalks();
  }, [auth.status, refreshTalks]);

  const handleTalkCreated = useCallback((talk: Talk) => {
    setTalks((current) => {
      const next = current.filter((item) => item.id !== talk.id);
      return [talk, ...next];
    });
    setTalksError(null);
  }, []);

  if (auth.status === 'loading') {
    return <main className="page-state">Checking session…</main>;
  }

  if (auth.status === 'unauthenticated') {
    return <SignInView onSignedIn={refreshSession} />;
  }

  const canManageSettings =
    auth.user.role === 'owner' || auth.user.role === 'admin';

  return (
    <main className="app-shell">
      <ClawTalkSidebar
        talks={talks}
        loading={talksLoading}
        error={talksError}
        userRole={auth.user.role}
        canManageSettings={canManageSettings}
      />
      <div className="app-main">
        <header className="app-main-topbar">
          <div className="app-user-meta">
            <strong>{auth.user.displayName}</strong>
            <span>{auth.user.email}</span>
          </div>
          <button
            type="button"
            className="secondary-btn"
            onClick={handleSignOut}
            disabled={signOutBusy}
          >
            Sign out
          </button>
        </header>
        <div className="app-main-content">
          <Routes>
            <Route path="/" element={<Navigate to="/app/talks" replace />} />
            <Route
              path="/app/talks"
              element={
                <TalkListPage
                  onUnauthorized={handleUnauthorized}
                  externalData={{
                    talks,
                    loading: talksLoading,
                    error: talksError,
                  }}
                  onTalkCreated={handleTalkCreated}
                />
              }
            />
            <Route
              path="/app/talks/:talkId"
              element={
                <TalkDetailPage
                  onUnauthorized={handleUnauthorized}
                  userRole={auth.user.role}
                />
              }
            />
            <Route
              path="/app/agents"
              element={
                <AiAgentsPage
                  onUnauthorized={handleUnauthorized}
                  userRole={auth.user.role}
                />
              }
            />
            <Route
              path="/app/settings"
              element={
                canManageSettings ? (
                  <SettingsPage
                    onUnauthorized={handleUnauthorized}
                    userRole={auth.user.role}
                  />
                ) : (
                  <Navigate to="/app/talks" replace />
                )
              }
            />
            <Route path="*" element={<Navigate to="/app/talks" replace />} />
          </Routes>
        </div>
      </div>
    </main>
  );
}
