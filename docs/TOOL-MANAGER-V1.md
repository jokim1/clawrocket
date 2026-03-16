# Next PR: Google Drive Picker + Drive/Gmail Tool Execution Slice

## Summary
Ship the first real end-to-end Tool Manager workflow:

- Drive scope is configured in the `Tools` tab
- users bind Drive folders/files through a Google Drive picker
- Google tools use a dedicated OAuth flow separate from app login
- agents can search/read Drive only within bound scope
- Gmail send uses the confirmation pause/resume flow
- Google-native Docs/Sheets are read through Drive export first, not first-class Docs/Sheets tools

This slice is optimized for: "find the file in the bound folder and email it."

## Key Changes

### 1. Google tools OAuth and credential lifecycle
- `Connect Google` and `Grant Google permissions` open a popup-based OAuth flow.
- `POST /api/v1/me/google-account/connect` returns an authorization URL for the initial Drive-scoped grant.
- `POST /api/v1/me/google-account/expand-scopes` returns an authorization URL for incremental scope grants.
- `GET /api/v1/me/google-account/callback` completes the popup flow, persists encrypted Google access/refresh tokens and actual granted scopes, posts a result back to `window.opener`, and closes.
- If there is no opener, the callback redirects back to the originating Talk URL with a short-lived success/error query flag.

OAuth state remains opaque. Flow metadata is stored server-side in `oauth_state.context_json`, including:
- `kind: "google_tools"`
- `userId`
- `requestedScopes`

Credential handling:
- store encrypted access token, refresh token, expiry, Google subject, email, display name, and granted scopes
- add `getValidGoogleToolAccessToken(userId, requiredScopes)` to decrypt credentials, refresh near-expired tokens, persist rotated token material, and return a valid access token
- refresh is single-flight per `userId` using an in-memory promise map
- if refresh fails with revocation or `invalid_grant`, delete the stored credential and surface reauth-required state
- `DELETE /api/v1/me/google-account` disconnects the user's Google tools credential without deleting Talk bindings

Scopes in this slice:
- Drive tools: `drive.readonly`
- Gmail send: `gmail.send`
- Gmail mailbox read/search is out of scope

### 2. Tools tab Drive binding UX
Drive scope stays in `Tools`, not `Saved Sources`.

Behavior:
- replace raw Drive ID entry with Google Picker-based binding
- add explicit `Bind folders` and `Bind files` actions
- picker sessions are additive, not replacement
- multi-select is allowed inside the chosen mode
- dedupe bindings by `(bindingKind, externalId)`
- removals remain explicit from the bound resource list

Picker token source:
- `GET /api/v1/me/google-account/picker-token`
- returns a fresh short-lived Google access token only when the user has a valid credential with `drive.readonly`
- frontend uses the token only to open the picker and does not persist it
- response requirements:
  - `Cache-Control: no-store`
  - same-origin only usage
  - aggressive rate limit
  - no token logging

### 3. Drive and Gmail executable tool slice
Implement these tool families end-to-end:

Drive:
- `google_drive_search(query, maxResults=10)`
- `google_drive_read(fileId, exportFormat?)`
- `google_drive_list_folder(folderId?, maxResults=20)`

Gmail:
- `gmail_send_email`

Only executable tools appear in runtime declaration and prompt injection for this slice. Non-executable Gmail read/Docs/Sheets tools stay out of the effective tool surface.

Drive behavior:
- search/list/read are restricted to bound folders/files only
- omitted `folderId` lists all bound root folders
- deleted or unshared bound resources return structured inaccessible-resource errors rather than raw Google API errors
- `google_drive_read` strategy:
  - plain text / supported downloadable files: read directly
  - Google Docs: export as `text/plain`
  - Google Sheets: export as `.xlsx` and reuse the existing spreadsheet extraction path already present in the repo
  - unsupported/binary files: metadata-only summary

Per-file normalized content caps:
- max 20,000 characters per file
- spreadsheet extraction capped at 200 non-empty rows total
- truncation/omission notices always included

`gmail_send_email` schema:
- `to: string[]`
- `cc?: string[]`
- `bcc?: string[]`
- `subject: string`
- `bodyText: string`
- `attachmentRefs?: string[]`

Attachment behavior in this slice:
- support only `talk:<attachmentId>`
- do not support `drive:<fileId>` attachments yet
- when the agent wants to include a Drive file, it should send a Drive link in the email body instead

Prompt guidance:
- list bound Drive resource names
- state that access outside bindings is not allowed
- state that Gmail send requires user approval
- explicitly state that the agent can send email in this slice but cannot read the mailbox

### 4. Confirmation runtime, continuation, and audit
`gmail_send_email` uses the existing confirmation model:

- create `TalkActionConfirmation`
- persist `TalkRunContinuation` with provider-native conversation state, current route step/provider/model, and the confirmation reference
- mark run `awaiting_confirmation`
- emit the confirmation event through the Talk event stream

On approve:
- load the saved continuation
- resume the same provider/route-step tool loop
- execute Gmail send
- finalize confirmation as `approved_executed` or `approved_failed`

On reject:
- load the saved continuation
- inject a structured tool error result
- resume the same provider/route-step tool loop
- allow the agent another turn to recover, explain, or choose a different action
- a new mutating action creates a new confirmation

Confirmation previews must show:
- `To`
- `CC`
- `BCC`
- `Subject`
- `Body`
- attachment summary

Audit:
- create real `TalkAuditEntry` rows for executed Gmail sends
- store encrypted raw args plus UI-safe summaries
- show summary entries in Talk run history

### 5. Verified implementation assumptions
- The existing spreadsheet extraction path already supports `.xlsx` via `extractAttachmentText(buffer, mimeType, fileName)` in `src/clawrocket/talks/attachment-extraction.ts`.
- Existing OAuth state storage already supports `return_to`; Google tools flow-specific metadata should remain server-side in `oauth_state.context_json`.
- Existing token-refresh single-flight patterns in the repo can be reused for Google tools refresh keyed by `userId`.

## Test Plan
Cover:

- OAuth:
  - connect returns authorization URL
  - popup callback persists encrypted credential and actual granted scopes
  - popup success/error message refreshes the Tools tab
  - redirect fallback returns to the same Talk and refreshes state
  - incremental scope grant updates scopes from Google's actual response only
  - disconnect removes the stored Google credential but preserves Talk bindings

- Token lifecycle:
  - valid token is reused
  - expired token refreshes successfully
  - concurrent refresh attempts for one user collapse to one refresh operation
  - refresh failure / revoked token deletes credential and surfaces reauth-required state
  - partial consent case: Drive granted, Gmail send denied -> Drive tools available, Gmail send unavailable

- Tools tab:
  - picker-token endpoint returns a token only when Drive scope exists
  - picker-token response is `no-store`
  - folder/file picker sessions add bindings additively
  - duplicate selections do not create duplicate bindings
  - bindings appear in Tools and update the summary correctly

- Executor:
  - Drive search only returns bound-scope results
  - Drive read exports Docs as text and Sheets through the existing `.xlsx` extraction path
  - large files are truncated with omission notices
  - deleted/unshared bound resources return safe structured errors
  - unsupported files return metadata summaries
  - Gmail send creates confirmation, pauses, resumes, and finalizes correctly

- Confirmation and audit:
  - approve -> send success -> `approved_executed`
  - approve -> Gmail API failure -> `approved_failed`
  - reject -> tool error result and resumed run
  - audit entry created only for actual execution attempts
  - confirmation preview includes `BCC` when present
  - cancellation behavior from the merged lifecycle hardening remains intact

- End to end:
  - connect Google
  - grant Drive and Gmail send scopes
  - bind `Accounting` folder with the picker
  - ask the agent to find a file there and email it
  - agent searches bound scope, reads the file, drafts the email, asks for approval
  - user approves
  - email sends and audit summary appears in run history

## Assumptions
- Drive scope lives in `Tools`, not `Saved Sources`
- binding UX uses Google Picker, not manual IDs or a custom Drive browser
- this slice implements Drive tools plus Gmail send only
- Gmail mailbox read/search is out of scope and should not be presented as usable
- Google-native Docs/Sheets are read through Drive export first
- `.xlsx` extraction reuses the spreadsheet extraction path already in the repo
- only `talk:<attachmentId>` email attachments are supported in this slice
- disconnecting Google tools removes the user credential but preserves Talk bindings
- non-user-triggered runs do not receive Google user-scoped tools
