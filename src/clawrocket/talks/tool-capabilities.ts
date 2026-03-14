/**
 * @deprecated — SCHEDULED FOR DELETION
 * Replaced by: TOOL_FAMILY_MAP in db/agent-accessors.ts
 * This file is kept temporarily while server.ts is being rewired.
 * Do not add new code here.
 */

const TOOL_SCOPE_MAP = {
  gmail_read: ['gmail.readonly'],
  gmail_send: ['gmail.send'],
  google_drive_search: ['drive.readonly'],
  google_drive_read: ['drive.readonly'],
  google_drive_list_folder: ['drive.readonly'],
  google_docs_read: ['documents.readonly'],
  google_docs_batch_update: ['documents'],
  google_sheets_read_range: ['spreadsheets.readonly'],
  google_sheets_batch_update: ['spreadsheets'],
} as const satisfies Record<string, readonly string[]>;

export function requiredScopesForTool(toolId: string): string[] {
  return [...(TOOL_SCOPE_MAP[toolId as keyof typeof TOOL_SCOPE_MAP] ?? [])];
}
