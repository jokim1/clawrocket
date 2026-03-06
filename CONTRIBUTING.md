# Contributing

## Source Changes

Accepted source changes generally fall into these buckets:

- bug fixes
- security fixes
- ClawRocket web/talk/runtime improvements
- upstream-safe maintenance and simplification
- documentation that reflects the current implementation

When changing NanoClaw-core files, follow [docs/UPSTREAM-PATCH-SURFACE.md](docs/UPSTREAM-PATCH-SURFACE.md).

## Skills

Skills are still the preferred way to add optional integrations or large product branches that do not belong in the shared base.

A [skill](https://code.claude.com/docs/en/skills) should contain the instructions Claude follows to transform an installation. A skill-focused PR should avoid unnecessary source-file edits outside the skill itself.

## Testing

Before submitting a code change, run the relevant checks:

```bash
npm run typecheck
npm run test
npm --prefix webapp run typecheck
npm --prefix webapp run test
```
