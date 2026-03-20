import { describe, expect, it } from 'vitest';

import { ALWAYS_ALLOWED_CONTEXT_TOOLS } from './agent-router.js';

describe('agent-router', () => {
  it('always permits read_state as a talk-internal context tool', () => {
    expect(ALWAYS_ALLOWED_CONTEXT_TOOLS.has('read_state')).toBe(true);
  });
});
