# Changelog

All notable changes to NanoClaw will be documented in this file.

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
