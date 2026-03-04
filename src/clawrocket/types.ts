export type UserRole = 'owner' | 'admin' | 'member';
export type TalkAccessRole = 'viewer' | 'editor';
export type TalkMessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type TalkRunStatus =
  | 'queued'
  | 'running'
  | 'cancelled'
  | 'completed'
  | 'failed';
