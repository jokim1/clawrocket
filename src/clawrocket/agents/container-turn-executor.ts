import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { getAllRegisteredGroups, getDb } from '../../db.js';
import { logger } from '../../logger.js';
import {
  runContainerAgent,
  type ContainerWebTalkConnectorBundle,
} from '../../container-runner.js';
import type { RegisteredGroup } from '../../types.js';
import {
  buildConnectorToolDefinitions,
  type ConnectorToolDefinition,
} from '../connectors/runtime.js';
import { decryptConnectorSecret } from '../connectors/connector-secret-store.js';
import {
  listConnectorsForTalkRun,
  type TalkRunConnectorRecord,
} from '../db/connector-accessors.js';
import {
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
} from '../config.js';
import type { RegisteredAgentRecord } from '../db/agent-accessors.js';
import type { ContainerCredentialConfig } from './execution-planner.js';
import type { ExecutionContext } from './agent-router.js';
import type { LlmMessage } from './llm-client.js';

interface ExecuteContainerTurnInput {
  runId: string;
  userId: string;
  agent: RegisteredAgentRecord;
  promptLabel: 'talk' | 'main';
  userMessage: string;
  signal: AbortSignal;
  allowedTools: string[];
  context: Pick<ExecutionContext, 'systemPrompt' | 'history'>;
  modelContextWindow: number;
  containerCredential: ContainerCredentialConfig;
  talkId?: string;
  threadId: string;
  triggerMessageId?: string | null;
  historyMessageIds?: string[];
  projectMountHostPath?: string | null;
}

interface ExecuteContainerTurnOutput {
  content: string;
}

interface MaterializedSourceFile {
  ref: string;
  title: string;
  relativePath: string;
  inlinePreview: string | null;
}

interface MaterializedAttachmentFile {
  id: string;
  fileName: string | null;
  relativePath: string;
}

const OUTPUT_RESERVE = 4096;
const TOOL_SCHEMA_RESERVE = 2000;
const CHARS_TO_TOKENS = 0.25;
const SMALL_SOURCE_THRESHOLD = 250;

function getContainerExecutionGroup(): {
  jid: string;
  group: RegisteredGroup;
} {
  const groups = Object.entries(getAllRegisteredGroups());
  const mainGroup = groups.find(([, group]) => group.isMain === true);
  if (!mainGroup) {
    throw new Error(
      'Container execution requires a registered main group, but none is configured.',
    );
  }
  const [jid, group] = mainGroup;
  return { jid, group };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length * CHARS_TO_TOKENS);
}

function formatMessageContent(content: LlmMessage['content']): string {
  if (typeof content === 'string') return content;
  return JSON.stringify(content, null, 2);
}

function writeFile(targetPath: string, content: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(
    targetPath,
    content.endsWith('\n') ? content : `${content}\n`,
  );
}

function renderHistoryMarkdown(history: LlmMessage[]): string {
  if (history.length === 0) {
    return 'No prior conversation history for this run.\n';
  }

  return history
    .map((message) => {
      const role = message.role.toUpperCase();
      return `## ${role}\n\n${formatMessageContent(message.content)}`;
    })
    .join('\n\n');
}

function shrinkHistoryToBudget(
  history: LlmMessage[],
  budgetTokens: number,
): LlmMessage[] {
  if (budgetTokens <= 0) {
    return [];
  }

  const selected: LlmMessage[] = [];
  let used = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    const tokens = estimateTokens(formatMessageContent(message.content));
    if (used + tokens > budgetTokens) {
      break;
    }
    used += tokens;
    selected.push(message);
  }
  selected.reverse();
  return selected;
}

function sanitizeFileNameSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function materializeTalkSourceFiles(
  baseDir: string,
  talkId: string,
): MaterializedSourceFile[] {
  const rows = getDb()
    .prepare(
      `
      SELECT source_ref, title, source_type, source_url, file_name, extracted_text
      FROM talk_context_sources
      WHERE talk_id = ? AND status = 'ready' AND extracted_text IS NOT NULL
      ORDER BY sort_order ASC, created_at ASC
    `,
    )
    .all(talkId) as Array<{
    source_ref: string;
    title: string;
    source_type: string;
    source_url: string | null;
    file_name: string | null;
    extracted_text: string;
  }>;

  return rows.map((row) => {
    const safeRef = sanitizeFileNameSegment(row.source_ref || 'source');
    const relativePath = path.join('sources', `${safeRef}.md`);
    const filePath = path.join(baseDir, relativePath);
    writeFile(
      filePath,
      [
        `# ${row.source_ref}: ${row.title}`,
        '',
        `Type: ${row.source_type}`,
        row.source_url ? `URL: ${row.source_url}` : null,
        row.file_name ? `File name: ${row.file_name}` : null,
        '',
        row.extracted_text,
      ]
        .filter(Boolean)
        .join('\n'),
    );

    const inlinePreview =
      row.source_type === 'text' &&
      estimateTokens(row.extracted_text) < SMALL_SOURCE_THRESHOLD
        ? row.extracted_text
        : null;

    return {
      ref: row.source_ref,
      title: row.title,
      relativePath,
      inlinePreview,
    };
  });
}

function listScopedAttachmentIds(input: {
  triggerMessageId?: string | null;
  historyMessageIds?: string[];
}): string[] {
  const ids = new Set<string>();
  if (input.triggerMessageId) {
    ids.add(input.triggerMessageId);
  }
  for (const messageId of input.historyMessageIds || []) {
    ids.add(messageId);
  }
  return Array.from(ids);
}

function materializeTalkAttachmentFiles(
  baseDir: string,
  talkId: string,
  messageIds: string[],
): MaterializedAttachmentFile[] {
  if (messageIds.length === 0) {
    return [];
  }

  const placeholders = messageIds.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(
      `
      SELECT id, file_name, extracted_text
      FROM talk_message_attachments
      WHERE talk_id = ?
        AND message_id IN (${placeholders})
        AND extracted_text IS NOT NULL
      ORDER BY created_at ASC
    `,
    )
    .all(talkId, ...messageIds) as Array<{
    id: string;
    file_name: string | null;
    extracted_text: string;
  }>;

  return rows.map((row) => {
    const fileStem = sanitizeFileNameSegment(
      row.file_name || `attachment-${row.id}`,
    );
    const relativePath = path.join(
      'attachments',
      `${sanitizeFileNameSegment(row.id)}-${fileStem}.md`,
    );
    const filePath = path.join(baseDir, relativePath);
    writeFile(
      filePath,
      [
        `# Attachment ${row.id}`,
        row.file_name ? `File name: ${row.file_name}` : null,
        '',
        row.extracted_text,
      ]
        .filter(Boolean)
        .join('\n'),
    );
    return {
      id: row.id,
      fileName: row.file_name,
      relativePath,
    };
  });
}

function buildClaudeMd(input: {
  systemPrompt: string;
  sourceFiles: MaterializedSourceFile[];
  attachmentFiles: MaterializedAttachmentFile[];
  hasProjectMount: boolean;
}): string {
  const sections: string[] = ['# ClawRocket Run Context'];

  if (input.systemPrompt.trim()) {
    sections.push(input.systemPrompt.trim());
  }

  sections.push(
    [
      'Use `HISTORY.md` for bounded transcript history from the current Talk/Main thread.',
      input.hasProjectMount
        ? 'A read-only project is mounted at `/workspace/project`.'
        : 'No project mount is configured for this run.',
      'This run-local `CLAUDE.md` is turn-specific context. If you later navigate into `/workspace/project`, any repo-local `CLAUDE.md` you find there is additive project guidance.',
    ].join(' '),
  );

  if (input.sourceFiles.length > 0) {
    sections.push(
      [
        '## Source Files',
        ...input.sourceFiles.map((source) =>
          [
            `- [${source.ref}] ${source.title} -> ${source.relativePath}`,
            source.inlinePreview
              ? `  Inline preview:\n${source.inlinePreview}`
              : null,
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      ].join('\n'),
    );
  }

  if (input.attachmentFiles.length > 0) {
    sections.push(
      [
        '## Attachment Files',
        ...input.attachmentFiles.map(
          (attachment) =>
            `- [${attachment.id}] ${attachment.fileName || 'attachment'} -> ${attachment.relativePath}`,
        ),
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}

function buildConnectorBundle(
  talkId: string,
): ContainerWebTalkConnectorBundle | undefined {
  const connectors = listConnectorsForTalkRun(talkId).filter(
    (connector) => connector.verificationStatus === 'verified',
  );
  if (connectors.length === 0) return undefined;

  const toolDefinitions = buildConnectorToolDefinitions(connectors);
  return {
    connectors: connectors.map((connector) => ({
      id: connector.id,
      name: connector.name,
      connectorKind: connector.connectorKind,
      config: connector.config,
      secret: decryptConnectorSecret(connector.ciphertext),
    })),
    toolDefinitions: toolDefinitions.map(
      (definition: ConnectorToolDefinition) => ({
        connectorId: definition.connectorId,
        connectorKind: definition.connectorKind,
        connectorName: definition.connectorName,
        toolName: definition.toolName,
        description: definition.description,
        inputSchema: definition.inputSchema,
      }),
    ),
    googleOAuth:
      GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET
        ? {
            clientId: GOOGLE_OAUTH_CLIENT_ID,
            clientSecret: GOOGLE_OAUTH_CLIENT_SECRET,
          }
        : undefined,
  };
}

function createContextDirectory(input: ExecuteContainerTurnInput): {
  path: string;
  connectorBundle?: ContainerWebTalkConnectorBundle;
} {
  const baseDir = fs.mkdtempSync(
    path.join(DATA_DIR, `${input.promptLabel}-container-turn-${input.runId}-`),
  );
  const sourceFiles = input.talkId
    ? materializeTalkSourceFiles(baseDir, input.talkId)
    : [];
  const attachmentFiles = input.talkId
    ? materializeTalkAttachmentFiles(
        baseDir,
        input.talkId,
        listScopedAttachmentIds({
          triggerMessageId: input.triggerMessageId,
          historyMessageIds: input.historyMessageIds,
        }),
      )
    : [];

  const claudeMdContent = buildClaudeMd({
    systemPrompt: input.context.systemPrompt,
    sourceFiles,
    attachmentFiles,
    hasProjectMount: Boolean(input.projectMountHostPath),
  });
  const claudeMdTokens = estimateTokens(claudeMdContent);
  const historyBudgetTokens = Math.max(
    0,
    input.modelContextWindow -
      OUTPUT_RESERVE -
      TOOL_SCHEMA_RESERVE -
      claudeMdTokens,
  );
  const boundedHistory = shrinkHistoryToBudget(
    input.context.history,
    historyBudgetTokens,
  );

  writeFile(path.join(baseDir, 'CLAUDE.md'), claudeMdContent);
  writeFile(
    path.join(baseDir, 'HISTORY.md'),
    renderHistoryMarkdown(boundedHistory),
  );

  return {
    path: baseDir,
    connectorBundle: input.talkId
      ? buildConnectorBundle(input.talkId)
      : undefined,
  };
}

export async function executeContainerAgentTurn(
  input: ExecuteContainerTurnInput,
): Promise<ExecuteContainerTurnOutput> {
  const { jid, group } = getContainerExecutionGroup();
  const contextDir = createContextDirectory(input);

  let activeProcess: ChildProcess | null = null;
  const onAbort = () => {
    if (!activeProcess) return;
    activeProcess.kill('SIGKILL');
  };
  input.signal.addEventListener('abort', onAbort, { once: true });

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: input.userMessage,
        model: input.agent.model_id,
        toolProfile: 'talk_main',
        allowedTools: input.allowedTools,
        groupFolder: group.folder,
        chatJid: jid,
        isMain: true,
        assistantName: input.agent.name,
        webTalkConnectorBundle: contextDir.connectorBundle,
        ephemeralContextDir: contextDir.path,
        projectMountHostPath: input.projectMountHostPath ?? null,
        secrets: input.containerCredential.secrets,
      },
      (proc) => {
        activeProcess = proc;
      },
    );

    if (output.status !== 'success') {
      throw new Error(output.error || 'Container execution failed.');
    }
    if (!output.result || !output.result.trim()) {
      throw new Error(
        'Container execution completed without a final response.',
      );
    }

    return {
      content: output.result,
    };
  } catch (error) {
    logger.error(
      {
        err: error,
        runId: input.runId,
        talkId: input.talkId,
        threadId: input.threadId,
        agentId: input.agent.id,
      },
      'Container-backed Talk/Main turn failed',
    );
    throw error;
  } finally {
    input.signal.removeEventListener('abort', onAbort);
    fs.rmSync(contextDir.path, { recursive: true, force: true });
  }
}
