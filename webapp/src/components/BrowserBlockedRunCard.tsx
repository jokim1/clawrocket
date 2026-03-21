import { useMemo, useState } from 'react';

import {
  ApiError,
  UnauthorizedError,
  approveBrowserConfirmation,
  rejectBrowserConfirmation,
  resumeBrowserBlockedRun,
  startBrowserSetupSession,
  startBrowserTakeover,
  type BrowserBlock,
  type BrowserBlockArtifact,
  type ExecutionDecision,
} from '../lib/api';

type BrowserBlockedRunCardProps = {
  runId: string;
  browserBlock: BrowserBlock;
  executionDecision?: ExecutionDecision | null;
  talkId?: string | null;
  onUnauthorized: () => void;
  onStateChanged?: () => Promise<void> | void;
};

type ActionState =
  | 'idle'
  | 'setup'
  | 'takeover'
  | 'resume'
  | 'approve'
  | 'reject';

type NoticeState =
  | {
      tone: 'success' | 'error';
      message: string;
    }
  | null;

function getBrowserBlockHeading(kind: BrowserBlock['kind']): string {
  switch (kind) {
    case 'auth_required':
      return 'Browser authentication required';
    case 'confirmation_required':
      return 'Browser approval required';
    case 'human_step_required':
      return 'Browser needs a manual step';
  }
}

function getDecisionSummary(
  executionDecision: ExecutionDecision | null | undefined,
): string | null {
  if (!executionDecision) return null;
  const backend =
    executionDecision.backend === 'container' ? 'container' : 'direct';
  const auth =
    executionDecision.authPath === 'subscription'
      ? 'subscription'
      : executionDecision.authPath === 'api_key'
        ? 'API key'
        : 'no auth';
  return `${backend} via ${auth}`;
}

function buildTalkAttachmentContentUrl(
  talkId: string,
  attachmentId: string,
): string {
  return `/api/v1/talks/${encodeURIComponent(talkId)}/attachments/${encodeURIComponent(attachmentId)}/content`;
}

function describeArtifact(
  artifact: BrowserBlockArtifact,
  talkId?: string | null,
): { label: string; href: string | null; detail: string | null } {
  const label = artifact.label || artifact.fileName || 'Artifact';
  if (talkId && artifact.attachmentId) {
    return {
      label,
      href: buildTalkAttachmentContentUrl(talkId, artifact.attachmentId),
      detail: artifact.contentType || null,
    };
  }

  return {
    label,
    href: null,
    detail: artifact.path || artifact.contentType || null,
  };
}

function normalizeMutationError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Browser action failed.';
}

export function BrowserBlockedRunCard({
  runId,
  browserBlock,
  executionDecision,
  talkId,
  onUnauthorized,
  onStateChanged,
}: BrowserBlockedRunCardProps) {
  const [actionState, setActionState] = useState<ActionState>('idle');
  const [notice, setNotice] = useState<NoticeState>(null);
  const decisionSummary = useMemo(
    () => getDecisionSummary(executionDecision),
    [executionDecision],
  );

  const runAction = async (
    state: ActionState,
    handler: () => Promise<string | null | void>,
  ) => {
    setActionState(state);
    setNotice(null);
    try {
      const message = await handler();
      if (message) {
        setNotice({ tone: 'success', message });
      }
      await onStateChanged?.();
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setNotice({
        tone: 'error',
        message: normalizeMutationError(error),
      });
    } finally {
      setActionState('idle');
    }
  };

  const handleSetupSession = () => {
    void runAction('setup', async () => {
      const result = await startBrowserSetupSession({
        siteKey: browserBlock.siteKey,
        accountLabel: browserBlock.accountLabel,
        url: browserBlock.url || null,
      });
      return (
        result.message ||
        'Browser setup session opened. Complete the step locally, then resume the run.'
      );
    });
  };

  const handleTakeover = () => {
    if (!browserBlock.sessionId) return;
    void runAction('takeover', async () => {
      await startBrowserTakeover(browserBlock.sessionId!);
      return 'Browser opened for local takeover. Finish the step, then resume the run.';
    });
  };

  const handleResumeRun = () => {
    void runAction('resume', async () => {
      await resumeBrowserBlockedRun({ runId });
      return 'Run resumed.';
    });
  };

  const handleApprove = () => {
    if (!browserBlock.confirmationId) return;
    void runAction('approve', async () => {
      await approveBrowserConfirmation({
        confirmationId: browserBlock.confirmationId!,
      });
      return 'Browser action approved.';
    });
  };

  const handleReject = () => {
    if (!browserBlock.confirmationId) return;
    if (
      typeof window !== 'undefined' &&
      !window.confirm('Reject this pending browser action?')
    ) {
      return;
    }
    void runAction('reject', async () => {
      await rejectBrowserConfirmation({
        confirmationId: browserBlock.confirmationId!,
      });
      return 'Browser action rejected.';
    });
  };

  return (
    <section className="browser-block-card" aria-label={getBrowserBlockHeading(browserBlock.kind)}>
      <div className="browser-block-card-header">
        <div>
          <h3>{getBrowserBlockHeading(browserBlock.kind)}</h3>
          <p className="browser-block-site">
            {browserBlock.siteKey}
            {browserBlock.accountLabel ? ` · ${browserBlock.accountLabel}` : ''}
          </p>
        </div>
        <span className={`browser-block-kind browser-block-kind-${browserBlock.kind}`}>
          {browserBlock.kind.replace(/_/g, ' ')}
        </span>
      </div>

      <p className="browser-block-message">{browserBlock.message}</p>

      <dl className="browser-block-details">
        <div>
          <dt>URL</dt>
          <dd>{browserBlock.url}</dd>
        </div>
        <div>
          <dt>Page</dt>
          <dd>{browserBlock.title || 'Untitled page'}</dd>
        </div>
        {browserBlock.pendingToolCall ? (
          <div>
            <dt>Pending tool</dt>
            <dd>{browserBlock.pendingToolCall.toolName}</dd>
          </div>
        ) : null}
        {browserBlock.riskReason ? (
          <div>
            <dt>Reason</dt>
            <dd>{browserBlock.riskReason}</dd>
          </div>
        ) : null}
        {decisionSummary ? (
          <div>
            <dt>Execution</dt>
            <dd>
              {decisionSummary}
              {executionDecision?.credentialSource
                ? ` · ${executionDecision.credentialSource}`
                : ''}
            </dd>
          </div>
        ) : null}
      </dl>

      {executionDecision?.plannerReason ? (
        <p className="browser-block-planner-reason">
          {executionDecision.plannerReason}
        </p>
      ) : null}

      {browserBlock.artifacts.length > 0 ? (
        <ul className="browser-block-artifacts">
          {browserBlock.artifacts.map((artifact, index) => {
            const resolved = describeArtifact(artifact, talkId);
            return (
              <li key={`${artifact.attachmentId || artifact.path || index}`}>
                {resolved.href ? (
                  <a href={resolved.href} target="_blank" rel="noreferrer">
                    {resolved.label}
                  </a>
                ) : (
                  <span>{resolved.label}</span>
                )}
                {resolved.detail ? <code>{resolved.detail}</code> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {browserBlock.setupCommand ? (
        <div className="browser-block-setup-command">
          <span>Fallback setup command</span>
          <code>{browserBlock.setupCommand}</code>
        </div>
      ) : null}

      <div className="browser-block-actions">
        {browserBlock.kind === 'confirmation_required' ? (
          <>
            <button
              type="button"
              className="primary-btn"
              onClick={handleApprove}
              disabled={
                actionState !== 'idle' || !browserBlock.confirmationId
              }
            >
              {actionState === 'approve' ? 'Approving…' : 'Approve action'}
            </button>
            <button
              type="button"
              className="secondary-btn"
              onClick={handleReject}
              disabled={
                actionState !== 'idle' || !browserBlock.confirmationId
              }
            >
              {actionState === 'reject' ? 'Rejecting…' : 'Reject action'}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="primary-btn"
              onClick={handleResumeRun}
              disabled={actionState !== 'idle'}
            >
              {actionState === 'resume' ? 'Resuming…' : 'Resume run'}
            </button>
            <button
              type="button"
              className="secondary-btn"
              onClick={handleSetupSession}
              disabled={actionState !== 'idle'}
            >
              {actionState === 'setup'
                ? 'Opening browser…'
                : browserBlock.kind === 'auth_required'
                  ? 'Authenticate browser'
                  : 'Open browser'}
            </button>
          </>
        )}
        {browserBlock.sessionId ? (
          <button
            type="button"
            className="secondary-btn"
            onClick={handleTakeover}
            disabled={actionState !== 'idle'}
          >
            {actionState === 'takeover' ? 'Opening takeover…' : 'Take over browser'}
          </button>
        ) : null}
      </div>

      {notice ? (
        <div
          className={`inline-banner ${
            notice.tone === 'error'
              ? 'inline-banner-error'
              : 'inline-banner-success'
          }`}
          role={notice.tone === 'error' ? 'alert' : 'status'}
        >
          {notice.message}
        </div>
      ) : null}
    </section>
  );
}
