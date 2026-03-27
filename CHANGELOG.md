# Changelog

All notable changes to NanoClaw will be documented in this file.

## [1.2.3](https://github.com/jokim1/clawrocket/compare/v1.2.2...v1.2.3)

- Updated the repo and CI/deploy workflows to target Node.js 24 LTS.
- Added a repo-managed production Node runtime path so deploys can install and
  run the service on Node 24 without depending on the host's global Node
  package staying current.
- Fixed Browser Profiles settings so duplicate adds do not silently reuse an
  existing profile, and browser profile errors now render with error styling.
- Added a Browser Profiles escape hatch to disconnect blocking browser sessions,
  and reconciled stale blocked sessions to `disconnected` on startup so dead
  browser state no longer permanently prevents profile edits.

## [1.2.2](https://github.com/jokim1/clawrocket/compare/v1.2.1...v1.2.2)

- Added Chrome-profile discovery in Browser Profiles settings, including
  auto-detection of Chrome user-data directories and real Chrome subprofiles.
- Added per-subprofile browser profile selection so browser sessions can launch
  against a specific Chrome profile like `Default` or `Profile 4` instead of
  relying on Chrome's last-used profile.

## [1.2.1](https://github.com/jokim1/clawrocket/compare/v1.2.0...v1.2.1)

- Fixed ClawTalk sidebar unread indicators so stale local message counts no longer
  show blue badges when a talk has no newer messages.

## [1.2.0](https://github.com/qwibitai/nanoclaw/compare/v1.1.6...v1.2.0)

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).
