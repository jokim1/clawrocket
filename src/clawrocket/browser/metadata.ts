import type { BrowserBlockedKind, BrowserSessionState } from './service.js';
import type {
  ExecutionBackend,
  ExecutionCredentialSource,
} from '../agents/execution-planner.js';

export interface BrowserBlockArtifact {
  attachmentId?: string | null;
  path?: string | null;
  fileName?: string | null;
  contentType?: string | null;
  label?: string | null;
}

export interface BrowserPendingToolCall {
  toolName: string;
  args: Record<string, unknown>;
}

export interface BrowserBlockMetadata {
  kind: BrowserBlockedKind;
  sessionId: string | null;
  siteKey: string;
  accountLabel: string | null;
  url: string;
  title: string;
  message: string;
  riskReason: string | null;
  setupCommand: string | null;
  artifacts: BrowserBlockArtifact[];
  confirmationId: string | null;
  pendingToolCall: BrowserPendingToolCall | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserResumeMetadata {
  kind:
    | 'auth_completed'
    | 'confirmation_approved'
    | 'confirmation_rejected'
    | 'human_step_completed';
  resumedAt: string;
  resumedBy: string | null;
  sessionId: string | null;
  confirmationId: string | null;
  note: string | null;
  pendingToolCall: BrowserPendingToolCall | null;
}

export interface ExecutionDecisionMetadata {
  backend: ExecutionBackend;
  authPath: 'api_key' | 'subscription' | 'none';
  credentialSource: ExecutionCredentialSource;
  plannerReason: string;
  providerId: string;
  modelId: string;
}

export interface CarriedBrowserSessionMetadata {
  sessionId: string;
  siteKey: string;
  accountLabel: string | null;
  lastKnownState: BrowserSessionState;
  blockedKind: BrowserBlockedKind | null;
  lastKnownUrl: string;
  lastKnownTitle: string;
  lastUpdatedAt: string;
}
