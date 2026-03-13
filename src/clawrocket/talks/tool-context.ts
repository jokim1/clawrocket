import {
  getUserGoogleCredential,
  initializeTalkToolGrants,
  listTalkAttachments,
  listTalkContextSources,
  listTalkDataConnectors,
  listTalkResourceBindings,
  listTalkToolGrants,
  listToolRegistryEntries,
  resolveTalkAgent,
} from '../db/index.js';
import { requiredScopesForTool } from './tool-capabilities.js';

export function buildTalkToolContextBlock(input: {
  talkId: string;
  requestedBy: string;
  targetAgentId?: string | null;
}): string | null {
  let grants = listTalkToolGrants(input.talkId);
  if (grants.length === 0) {
    initializeTalkToolGrants(input.talkId, input.requestedBy);
    grants = listTalkToolGrants(input.talkId);
  }

  const resolved = resolveTalkAgent(input.talkId, input.targetAgentId);
  const toolCapable = Boolean(
    resolved?.steps.some(
      (step) =>
        step.talkUsable &&
        step.hasCredential &&
        step.provider.enabled === 1 &&
        step.model.enabled === 1 &&
        step.model.supports_tools === 1,
    ),
  );

  const registry = listToolRegistryEntries();
  const grantSet = new Set(
    grants.filter((grant) => grant.enabled).map((grant) => grant.toolId),
  );
  const enabledEntries = registry.filter(
    (entry) => entry.enabled && grantSet.has(entry.id),
  );

  if (enabledEntries.length === 0) {
    return null;
  }

  const bindings = listTalkResourceBindings(input.talkId).filter(
    (binding) =>
      binding.bindingKind === 'google_drive_folder' ||
      binding.bindingKind === 'google_drive_file',
  );
  const boundNames = bindings.map((binding) => binding.displayName).slice(0, 8);
  const googleCredential = getUserGoogleCredential(input.requestedBy);
  const scopeSet = new Set(googleCredential?.scopes || []);
  const sourcesCount = listTalkContextSources(input.talkId).length;
  const attachmentsCount = listTalkAttachments(input.talkId).length;
  const connectorCount = listTalkDataConnectors(input.talkId).length;

  const lines: string[] = [];
  if (!toolCapable) {
    lines.push(
      'This agent cannot use Talk tools on the current route. Do not assume tool access unless the route supports it.',
    );
  }

  const hasWeb = enabledEntries.some(
    (entry) => entry.id === 'web_search' || entry.id === 'web_fetch',
  );
  if (hasWeb) {
    lines.push('Public web search and fetch are available.');
  }

  const hasDriveFamily = enabledEntries.some(
    (entry) =>
      entry.id.startsWith('google_drive') ||
      entry.id.startsWith('google_docs') ||
      entry.id.startsWith('google_sheets'),
  );
  if (hasDriveFamily) {
    if (bindings.length > 0) {
      lines.push(
        `You may search within bound Google Drive resources: ${boundNames.join(', ')}.`,
      );
      lines.push('Do not assume access outside bound resources.');
    } else {
      lines.push(
        'Google Drive, Docs, and Sheets are unavailable until a file or folder is bound to this Talk.',
      );
    }
  }

  const missingScopes = enabledEntries.flatMap((entry) =>
    requiredScopesForTool(entry.id).filter((scope) => !scopeSet.has(scope)),
  );
  if (missingScopes.length > 0) {
    lines.push(
      'Some granted Google capabilities still require additional Google permissions before they can be used.',
    );
  }

  if (enabledEntries.some((entry) => entry.id === 'gmail_send')) {
    lines.push(
      'Email sends require user approval before execution. Compose them as final drafts.',
    );
  }
  if (
    enabledEntries.some(
      (entry) =>
        entry.id === 'google_docs_batch_update' ||
        entry.id === 'google_sheets_batch_update',
    )
  ) {
    lines.push(
      'Document and sheet writes require user approval before execution. Prepare precise, reviewable edits.',
    );
  }
  if (sourcesCount > 0 && grantSet.has('saved_sources')) {
    lines.push('Saved Talk sources are available when needed.');
  }
  if (attachmentsCount > 0 && grantSet.has('attachments')) {
    lines.push('Talk attachments may be read when needed.');
  }
  if (connectorCount > 0 && grantSet.has('data_connectors')) {
    lines.push(
      'Attached data connectors are available when supported by the route.',
    );
  }

  return lines.length > 0 ? `## Tool Context\n${lines.join('\n')}` : null;
}
