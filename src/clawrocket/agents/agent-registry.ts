/**
 * Agent Registry — service layer over agent-accessors.
 *
 * Provides higher-level operations for agent management:
 * - Create/update agents with validation
 * - Resolve the main agent
 * - List available agents for a Talk
 */

import { getDb } from '../../db.js';
import {
  createRegisteredAgent,
  deleteRegisteredAgent,
  getRegisteredAgent,
  getRegisteredAgentSnapshot,
  getFallbackSteps,
  listEnabledAgents,
  listRegisteredAgents,
  setFallbackSteps,
  updateRegisteredAgent,
  type RegisteredAgentRecord,
  type RegisteredAgentSnapshot,
  type AgentFallbackStep,
} from '../db/agent-accessors.js';

// ---------------------------------------------------------------------------
// Main Agent Resolution
// ---------------------------------------------------------------------------

const MAIN_AGENT_SETTING_KEY = 'system.mainAgentId';

/**
 * Returns the main agent ID from settings_kv.
 */
export function getMainAgentId(): string {
  const row = getDb()
    .prepare(`SELECT value FROM settings_kv WHERE key = ?`)
    .get(MAIN_AGENT_SETTING_KEY) as { value: string } | undefined;

  if (!row?.value) {
    throw new Error('Main agent not configured. Check settings_kv for system.mainAgentId.');
  }
  return row.value;
}

/**
 * Returns the main agent record.
 */
export function getMainAgent(): RegisteredAgentRecord {
  const id = getMainAgentId();
  const agent = getRegisteredAgent(id);
  if (!agent) {
    throw new Error(`Main agent '${id}' not found in registered_agents.`);
  }
  return agent;
}

/**
 * Returns the main agent as a snapshot (API-friendly format).
 */
export function getMainAgentSnapshot(): RegisteredAgentSnapshot {
  const id = getMainAgentId();
  const snapshot = getRegisteredAgentSnapshot(id);
  if (!snapshot) {
    throw new Error(`Main agent '${id}' not found in registered_agents.`);
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// Talk Agent Resolution
// ---------------------------------------------------------------------------

export interface TalkAgentAssignment {
  assignmentId: string;
  agentId: string;
  agentName: string;
  personaRole: string | null;
  isPrimary: boolean;
  sortOrder: number;
}

/**
 * List agents assigned to a Talk, ordered by sort_order.
 */
export function listTalkAgents(talkId: string): TalkAgentAssignment[] {
  const rows = getDb()
    .prepare(
      `
    SELECT
      ta.id AS assignment_id,
      ta.registered_agent_id AS agent_id,
      ra.name AS agent_name,
      ta.persona_role,
      ta.is_primary,
      ta.sort_order
    FROM talk_agents ta
    JOIN registered_agents ra ON ra.id = ta.registered_agent_id
    WHERE ta.talk_id = ?
    ORDER BY ta.sort_order ASC
  `,
    )
    .all(talkId) as Array<{
    assignment_id: string;
    agent_id: string;
    agent_name: string;
    persona_role: string | null;
    is_primary: number;
    sort_order: number;
  }>;
  return rows.map((row) => ({
    assignmentId: row.assignment_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    personaRole: row.persona_role,
    isPrimary: !!row.is_primary,
    sortOrder: row.sort_order,
  }));
}

/**
 * Resolve the primary agent for a Talk.
 * Returns the agent marked as primary, or the first assigned agent.
 */
export function resolvePrimaryAgent(talkId: string): RegisteredAgentRecord | undefined {
  const row = getDb()
    .prepare(
      `
    SELECT ra.*
    FROM talk_agents ta
    JOIN registered_agents ra ON ra.id = ta.registered_agent_id
    WHERE ta.talk_id = ?
    ORDER BY ta.is_primary DESC, ta.sort_order ASC
    LIMIT 1
  `,
    )
    .get(talkId) as RegisteredAgentRecord | undefined;

  return row;
}

/**
 * Resolve a specific agent for a Talk by @mention name.
 * Used for explicit @agent routing.
 */
export function resolveAgentByName(
  talkId: string,
  agentName: string,
): RegisteredAgentRecord | undefined {
  const row = getDb()
    .prepare(
      `
    SELECT ra.*
    FROM talk_agents ta
    JOIN registered_agents ra ON ra.id = ta.registered_agent_id
    WHERE ta.talk_id = ?
      AND LOWER(ra.name) = LOWER(?)
    LIMIT 1
  `,
    )
    .get(talkId, agentName) as RegisteredAgentRecord | undefined;

  return row;
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export {
  createRegisteredAgent,
  deleteRegisteredAgent,
  getRegisteredAgent,
  getRegisteredAgentSnapshot,
  getFallbackSteps,
  listEnabledAgents,
  listRegisteredAgents,
  setFallbackSteps,
  updateRegisteredAgent,
  type RegisteredAgentRecord,
  type RegisteredAgentSnapshot,
  type AgentFallbackStep,
};
