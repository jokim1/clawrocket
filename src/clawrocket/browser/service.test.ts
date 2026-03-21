import { describe, expect, it, vi } from 'vitest';

import { _testOnly } from './service.js';

function makePage(input?: {
  url?: string;
  passwordCount?: number;
  bodyText?: string;
  throwOnPasswordCount?: boolean;
  throwOnBodyText?: boolean;
}): any {
  return {
    url: vi.fn(() => input?.url ?? 'https://example.com/account'),
    locator: vi.fn((selector: string) => {
      if (selector === 'input[type="password"]') {
        return {
          count: input?.throwOnPasswordCount
            ? vi.fn().mockRejectedValue(new Error('count failed'))
            : vi.fn().mockResolvedValue(input?.passwordCount ?? 0),
        };
      }
      if (selector === 'body') {
        return {
          innerText: input?.throwOnBodyText
            ? vi.fn().mockRejectedValue(new Error('innerText failed'))
            : vi.fn().mockResolvedValue(input?.bodyText ?? ''),
        };
      }
      throw new Error(`Unexpected selector: ${selector}`);
    }),
  };
}

describe('browser service helpers', () => {
  it('detects auth from URL before reading the page DOM', async () => {
    const page = makePage({
      url: 'https://www.linkedin.com/checkpoint/challenge',
    });

    const result = await _testOnly.detectBlockedState(page);

    expect(result).toEqual({
      kind: 'auth_required',
      reason:
        'Current page URL suggests an authentication flow: https://www.linkedin.com/checkpoint/challenge',
    });
    expect(page.locator).not.toHaveBeenCalled();
  });

  it('detects auth when the page contains a password field', async () => {
    const result = await _testOnly.detectBlockedState(
      makePage({
        passwordCount: 1,
      }),
    );

    expect(result).toEqual({
      kind: 'auth_required',
      reason: 'Page contains a password field.',
    });
  });

  it('detects auth when the page body contains login or verification copy', async () => {
    const result = await _testOnly.detectBlockedState(
      makePage({
        bodyText: 'Please sign in to continue.',
      }),
    );

    expect(result).toEqual({
      kind: 'auth_required',
      reason: 'Page content suggests interactive authentication.',
    });
  });

  it('falls back to URL-only auth detection when DOM inspection throws', async () => {
    const result = await _testOnly.detectBlockedState(
      makePage({
        url: 'https://example.com/account',
        throwOnPasswordCount: true,
      }),
    );

    expect(result).toEqual({ kind: null });
  });

  it('does not classify a harmless click as risky just because the page URL contains confirm', () => {
    const result = _testOnly.classifyRisk({
      action: 'click',
      currentUrl: 'https://example.com/confirm-email',
      descriptor: {
        role: 'link',
        label: 'Go to settings',
        tag: 'a',
        href: '/settings',
        type: null,
      },
    });

    expect(result).toBeNull();
  });

  it('still classifies confirm-like targets as risky final actions', () => {
    const result = _testOnly.classifyRisk({
      action: 'click',
      currentUrl: 'https://example.com/account',
      descriptor: {
        role: 'button',
        label: 'Confirm Purchase',
        tag: 'button',
        href: null,
        type: null,
      },
    });

    expect(result).toMatch(/likely final-action control/i);
  });

  it('still classifies submit controls as risky', () => {
    const result = _testOnly.classifyRisk({
      action: 'click',
      currentUrl: 'https://example.com/account',
      descriptor: {
        role: 'button',
        label: 'Go',
        tag: 'input',
        href: null,
        type: 'submit',
      },
    });

    expect(result).toBeTruthy();
  });
});
