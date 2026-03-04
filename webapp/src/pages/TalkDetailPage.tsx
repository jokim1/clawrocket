import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import {
  ApiError,
  getTalk,
  listTalkMessages,
  Talk,
  TalkMessage,
  UnauthorizedError,
} from '../lib/api';

type DetailState =
  | { kind: 'loading' }
  | { kind: 'ready'; talk: Talk; messages: TalkMessage[] }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

export function TalkDetailPage({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}): JSX.Element {
  const { talkId = '' } = useParams<{ talkId: string }>();
  const [state, setState] = useState<DetailState>({ kind: 'loading' });
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });

    const load = async () => {
      try {
        const [talk, messages] = await Promise.all([
          getTalk(talkId),
          listTalkMessages(talkId),
        ]);
        if (!cancelled) {
          setState({ kind: 'ready', talk, messages });
        }
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          if (!cancelled) setState({ kind: 'unavailable' });
          return;
        }
        if (!cancelled) {
          setState({
            kind: 'error',
            message: err instanceof Error ? err.message : 'Failed to load talk',
          });
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized, talkId]);

  useEffect(() => {
    if (state.kind !== 'ready') return;
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [state]);

  if (state.kind === 'loading') {
    return <p className="page-state">Loading talk…</p>;
  }

  if (state.kind === 'unavailable') {
    return (
      <section className="page-state">
        <h2>Talk Unavailable</h2>
        <p>You no longer have access to this talk, or it does not exist.</p>
        <Link to="/app/talks">Back to talks</Link>
      </section>
    );
  }

  if (state.kind === 'error') {
    return (
      <section className="page-state">
        <h2>Talk Error</h2>
        <p>{state.message}</p>
        <Link to="/app/talks">Back to talks</Link>
      </section>
    );
  }

  return (
    <section className="page-shell">
      <header className="page-header">
        <div>
          <h1>{state.talk.title}</h1>
          <p>Read-only timeline (send/cancel arrives in the next step).</p>
        </div>
        <Link to="/app/talks">Back</Link>
      </header>

      <div className="timeline" aria-label="Talk timeline">
        {state.messages.length === 0 ? (
          <p className="page-state">No messages yet.</p>
        ) : (
          state.messages.map((message) => (
            <article key={message.id} className={`message message-${message.role}`}>
              <header>
                <strong>{message.role}</strong>
                <time>{new Date(message.createdAt).toLocaleString()}</time>
              </header>
              <p>{message.content}</p>
            </article>
          ))
        )}
        <div ref={endRef} />
      </div>
    </section>
  );
}
