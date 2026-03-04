# Upstream Patch Surface

This document defines the intended NanoClaw core touchpoints that ClawRocket is allowed to modify.

| File | Seam Purpose | Integration Region |
| --- | --- | --- |
| `src/db.ts` | Shared SQLite connection ownership and safe DB accessor for ClawRocket modules | `getDb()` + core schema/init only |
| `src/index.ts` | ClawRocket bootstrap from core runtime startup | Calls to `initClawrocketSchema()`, `registerClawrocketSchedulerMaintenanceHook()`, web bootstrap import |
| `src/config.ts` | Keep NanoClaw core config aligned with upstream | Core-only env/config constants |
| `src/task-scheduler.ts` | Maintenance hook seam without core->ClawRocket DB coupling | `registerSchedulerMaintenanceHook()` registration API and hook execution |

## Review Checklist

1. Changes outside the files above require explicit rationale.
2. Core files should include `ClawRocket integration seam` comments where hooks are applied.
3. ClawRocket-specific functionality should live under `src/clawrocket/*`.
