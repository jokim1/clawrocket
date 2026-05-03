import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';

import { SignInView } from './components/SignInView';
import {
  getSessionMe,
  logout as logoutSession,
  SessionUser,
  UnauthorizedError,
} from './lib/session-api';
import { DraftWorkspacePage } from './pages/DraftWorkspacePage';
import { EditorialSetupPage } from './pages/EditorialSetupPage';
import { PointsOutlineWorkspacePage } from './pages/PointsOutlineWorkspacePage';
import { ThemeTopicsWorkspacePage } from './pages/ThemeTopicsWorkspacePage';

// editorialboard.ai is the Editorial Room. Single product, single routing
// tree, no ClawTalk shell. Per docs/CLOUD_TARGET.md, root redirects into the
// editorial flow; the 6-pill phase strip inside each page is the navigation.
//
// The legacy /app/* tree (MainChannel, TalkList, TalkDetail, Settings, etc.)
// was deleted in PR-1 of the PURGE.

type AuthState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'authenticated'; user: SessionUser };

export function App(): JSX.Element {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });

  const refreshSession = useCallback(async (): Promise<void> => {
    try {
      const user = await getSessionMe();
      setAuth({ status: 'authenticated', user });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        setAuth({ status: 'unauthenticated' });
      } else {
        // Hard transport / parse error — treat as signed-out so the user
        // sees the sign-in view rather than a blank screen.
        setAuth({ status: 'unauthenticated' });
      }
    }
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const handleUnauthorized = useCallback((): void => {
    setAuth({ status: 'unauthenticated' });
  }, []);

  const handleSignedIn = useCallback(async (): Promise<void> => {
    await refreshSession();
  }, [refreshSession]);

  const handleSignOut = useCallback(async (): Promise<void> => {
    try {
      await logoutSession();
    } catch {
      // Even if the server call fails, force the client into a signed-out
      // state — the cookies are already going to be invalidated server-side
      // on the next refresh attempt.
    }
    setAuth({ status: 'unauthenticated' });
  }, []);

  if (auth.status === 'loading') {
    return (
      <div className="app-loading" role="status" aria-live="polite">
        Loading…
      </div>
    );
  }

  if (auth.status === 'unauthenticated') {
    return <SignInView onSignedIn={handleSignedIn} />;
  }

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/editorial/setup" replace />} />
      <Route
        path="/editorial"
        element={<Navigate to="/editorial/setup" replace />}
      />
      <Route
        path="/editorial/setup"
        element={<EditorialSetupPage onUnauthorized={handleUnauthorized} />}
      />
      <Route
        path="/sign-out"
        element={<SignOutRoute onDone={handleSignOut} />}
      />
      <Route
        path="/editorial/theme-topics"
        element={
          <ThemeTopicsWorkspacePage onUnauthorized={handleUnauthorized} />
        }
      />
      <Route
        path="/editorial/points-outline"
        element={
          <PointsOutlineWorkspacePage onUnauthorized={handleUnauthorized} />
        }
      />
      <Route
        path="/editorial/draft"
        element={<DraftWorkspacePage onUnauthorized={handleUnauthorized} />}
      />
      <Route
        path="/editorial/*"
        element={<Navigate to="/editorial/setup" replace />}
      />
      <Route path="*" element={<Navigate to="/editorial/setup" replace />} />
    </Routes>
  );
}

function SignOutRoute({
  onDone,
}: {
  onDone: () => Promise<void>;
}): JSX.Element {
  const navigate = useNavigate();
  useEffect(() => {
    void (async () => {
      await onDone();
      navigate('/', { replace: true });
    })();
  }, [navigate, onDone]);
  return (
    <div className="app-loading" role="status" aria-live="polite">
      Signing out…
    </div>
  );
}

export default App;
