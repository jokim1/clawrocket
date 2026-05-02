import { Link } from 'react-router-dom';

export type EditorialPhaseId =
  | 'setup'
  | 'theme-topics'
  | 'points-outline'
  | 'draft'
  | 'polish'
  | 'ship';

type Phase = {
  id: EditorialPhaseId;
  label: string;
  path: string | null;
};

const PHASES: ReadonlyArray<Phase> = [
  { id: 'setup', label: '01 SETUP', path: '/editorial/setup' },
  {
    id: 'theme-topics',
    label: '02 THEME + TOPICS',
    path: '/editorial/theme-topics',
  },
  {
    id: 'points-outline',
    label: '03 POINTS + OUTLINE',
    path: '/editorial/points-outline',
  },
  { id: 'draft', label: '04 DRAFT', path: null },
  { id: 'polish', label: '05 POLISH', path: null },
  { id: 'ship', label: '06 SHIP', path: null },
];

export function EditorialPhaseStrip({
  activePhase,
}: {
  activePhase: EditorialPhaseId;
}) {
  return (
    <header className="editorial-phase-strip">
      <div className="editorial-phase-strip-brand">
        <span className="editorial-phase-strip-mark">ER</span>
        <span className="editorial-phase-strip-title">
          Editorial Room <span className="editorial-version">v0P</span>
        </span>
      </div>
      <nav className="editorial-phase-strip-pills">
        {PHASES.map((p) => {
          const isActive = p.id === activePhase;
          const isDisabled = !p.path;
          const className =
            'editorial-phase-pill' +
            (isActive ? ' editorial-phase-pill-active' : '') +
            (isDisabled ? ' editorial-phase-pill-disabled' : '');
          if (p.path && !isActive) {
            return (
              <Link key={p.id} to={p.path} className={className}>
                {p.label}
              </Link>
            );
          }
          return (
            <span
              key={p.id}
              className={className}
              aria-current={isActive ? 'page' : undefined}
            >
              {p.label}
            </span>
          );
        })}
      </nav>
      <div className="editorial-phase-strip-actions">
        <button type="button" className="editorial-chip-button" disabled>
          ⌘K
        </button>
        <button type="button" className="editorial-chip-button" disabled>
          HISTORY
        </button>
        <button type="button" className="editorial-chip-button" disabled>
          SAVE
        </button>
      </div>
    </header>
  );
}
