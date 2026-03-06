# Upstream Patch Surface

This document defines the NanoClaw-core files ClawRocket is expected to touch directly.

## Allowed Core Touchpoints

| File | Why It Is A Seam | Current ClawRocket Use |
| --- | --- | --- |
| `src/db.ts` | Shared SQLite connection and core DB initialization ownership | ClawRocket schema access depends on the same DB handle |
| `src/index.ts` | Core process startup and shutdown orchestration | ClawRocket schema bootstrap, web bootstrap, singleton coordination wiring |
| `src/config.ts` | Shared core config/env constants | Core runtime configuration stays aligned with upstream |
| `src/task-scheduler.ts` | Scheduler maintenance hook seam | ClawRocket scheduler maintenance registration |

## Working Rules

1. Prefer `src/clawrocket/*` for all ClawRocket-specific behavior.
2. Changes outside the files above need explicit rationale.
3. Core-file edits should stay narrow and commentable as integration seams.
4. Do not move Talk runtime, auth, or web-specific logic back into NanoClaw-core files unless the boundary itself is being intentionally redesigned.
