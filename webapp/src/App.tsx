import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { SignInView } from './components/SignInView';
import { getSessionMe, SessionUser, UnauthorizedError } from './lib/api';
import { TalkDetailPage } from './pages/TalkDetailPage';
import { TalkListPage } from './pages/TalkListPage';

type AuthState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'authenticated'; user: SessionUser };

export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });

  const refreshSession = async () => {
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
  };

  useEffect(() => {
    void refreshSession();
  }, []);

  if (auth.status === 'loading') {
    return <main className="page-state">Checking session…</main>;
  }

  if (auth.status === 'unauthenticated') {
    return <SignInView onSignedIn={refreshSession} />;
  }

  return (
    <main className="app-shell">
      <header className="app-topbar">
        <div>
          <strong>{auth.user.displayName}</strong>
          <span>{auth.user.email}</span>
        </div>
      </header>
      <Routes>
        <Route path="/" element={<Navigate to="/app/talks" replace />} />
        <Route
          path="/app/talks"
          element={
            <TalkListPage onUnauthorized={() => setAuth({ status: 'unauthenticated' })} />
          }
        />
        <Route
          path="/app/talks/:talkId"
          element={
            <TalkDetailPage
              onUnauthorized={() => setAuth({ status: 'unauthenticated' })}
            />
          }
        />
        <Route path="*" element={<Navigate to="/app/talks" replace />} />
      </Routes>
    </main>
  );
}
