import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { SignInView } from './components/SignInView';
import {
  getSessionMe,
  logout as logoutSession,
  SessionUser,
  UnauthorizedError,
} from './lib/api';
import { TalkDetailPage } from './pages/TalkDetailPage';
import { TalkListPage } from './pages/TalkListPage';

type AuthState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'authenticated'; user: SessionUser };

export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });
  const [signOutBusy, setSignOutBusy] = useState(false);

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

  if (auth.status === 'loading') {
    return <main className="page-state">Checking session…</main>;
  }

  if (auth.status === 'unauthenticated') {
    return <SignInView onSignedIn={refreshSession} />;
  }

  return (
    <main className="app-shell">
      <header className="app-topbar">
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
      <Routes>
        <Route path="/" element={<Navigate to="/app/talks" replace />} />
        <Route
          path="/app/talks"
          element={<TalkListPage onUnauthorized={handleUnauthorized} />}
        />
        <Route
          path="/app/talks/:talkId"
          element={<TalkDetailPage onUnauthorized={handleUnauthorized} />}
        />
        <Route path="*" element={<Navigate to="/app/talks" replace />} />
      </Routes>
    </main>
  );
}
