import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { listTalks, Talk, UnauthorizedError } from '../lib/api';

export function TalkListPage({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}): JSX.Element {
  const [talks, setTalks] = useState<Talk[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      {talks.length === 0 ? (
        <p className="page-state">No talks yet.</p>
      ) : (
        <ul className="talk-list">
          {talks.map((talk) => (
            <li key={talk.id}>
              <Link to={`/app/talks/${talk.id}`}>
                <strong>{talk.title}</strong>
                <span>{new Date(talk.updatedAt).toLocaleString()}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
