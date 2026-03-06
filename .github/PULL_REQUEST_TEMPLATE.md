## Summary

Describe the user-visible or maintainer-visible change.

## Type of Change

- [ ] Core runtime / upstream-sensitive maintenance
- [ ] ClawRocket web / Talks / settings
- [ ] Bug fix or security fix
- [ ] Documentation or operational docs
- [ ] Skill-only change

## Scope Notes

- [ ] I reviewed [docs/UPSTREAM-PATCH-SURFACE.md](../docs/UPSTREAM-PATCH-SURFACE.md) before changing core NanoClaw-sensitive files
- [ ] This change keeps ClawRocket-specific behavior under `src/clawrocket/*` where practical
- [ ] This PR removes or updates stale docs if behavior changed

## Validation

- [ ] `npm run typecheck`
- [ ] `npm run test`
- [ ] `npm --prefix webapp run typecheck` (if webapp affected)
- [ ] `npm --prefix webapp run test` (if webapp affected)

## Notes

Call out rollout concerns, follow-up work, or intentionally deferred items.
