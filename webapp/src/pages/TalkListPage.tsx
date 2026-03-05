import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { createTalk, listTalks, Talk, UnauthorizedError } from '../lib/api';

export function TalkListPage({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const [talks, setTalks] = useState<Talk[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const rows = await listTalks();
        if (!cancelled) {
          setTalks(rows);
          setError(null);
        }
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load talks');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized]);

  const handleCreateTalk = async (event: FormEvent) => {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title) {
      setCreateError('Talk title is required.');
      return;
    }

    setCreateBusy(true);
    setCreateError(null);
    try {
      const talk = await createTalk(title);
      navigate(`/app/talks/${talk.id}`);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setCreateError(err instanceof Error ? err.message : 'Failed to create talk');
    } finally {
      setCreateBusy(false);
    }
  };

  if (loading) {
    return <p className="page-state">Loading talks…</p>;
  }

  if (error) {
    return (
      <section className="page-state">
        <h2>Talks Unavailable</h2>
        <p>{error}</p>
      </section>
    );
  }

  return (
    <section className="page-shell">
      <header className="page-header">
        <h1>Talks</h1>
      </header>

      <form className="talk-create" onSubmit={handleCreateTalk}>
        <input
          type="text"
          value={newTitle}
          onChange={(event) => {
            setNewTitle(event.target.value);
            if (createError) setCreateError(null);
          }}
          placeholder="New Talk title"
          maxLength={160}
          disabled={createBusy}
        />
        <button type="submit" className="primary-btn" disabled={createBusy}>
          {createBusy ? 'Creating…' : 'New Talk'}
        </button>
      </form>

      {createError ? (
        <div className="inline-banner inline-banner-error" role="alert">
          {createError}
        </div>
      ) : null}

      {talks.length === 0 ? (
        <p className="page-state">No talks yet.</p>
      ) : (
        <ul className="talk-list">
          {talks.map((talk) => (
            <li key={talk.id}>
              <Link to={`/app/talks/${talk.id}`}>
                <div className="talk-list-main">
                  <strong>{talk.title}</strong>
                  <div className="talk-agent-row">
                    {talk.agents.map((agent) => (
                      <span key={agent} className="talk-agent-chip">
                        {agent}
                      </span>
                    ))}
                  </div>
                </div>
                <span>{new Date(talk.updatedAt).toLocaleString()}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
