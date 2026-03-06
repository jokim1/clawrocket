import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { createTalk, listTalks, Talk, UnauthorizedError } from '../lib/api';

type ExternalTalkData = {
  talks: Talk[];
  loading: boolean;
  error: string | null;
};

export function TalkListPage({
  onUnauthorized,
  externalData,
  onTalkCreated,
}: {
  onUnauthorized: () => void;
  externalData?: ExternalTalkData;
  onTalkCreated?: (talk: Talk) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const [talks, setTalks] = useState<Talk[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (externalData) {
      return;
    }

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
  }, [externalData, onUnauthorized]);

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
      onTalkCreated?.(talk);
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

  const effectiveTalks = externalData ? externalData.talks : talks;
  const effectiveLoading = externalData ? externalData.loading : loading;
  const effectiveError = externalData ? externalData.error : error;

  if (effectiveLoading) {
    return <p className="page-state">Loading talks…</p>;
  }

  if (effectiveError) {
    return (
      <section className="page-state">
        <h2>Talks Unavailable</h2>
        <p>{effectiveError}</p>
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

      {effectiveTalks.length === 0 ? (
        <p className="page-state">No talks yet.</p>
      ) : (
        <ul className="talk-list">
          {effectiveTalks.map((talk) => (
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
