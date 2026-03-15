/**
 * web-tools.ts — Shared web fetch and web search tool implementations.
 *
 * Used by both Talk executor and Main executor.
 */

// ---------------------------------------------------------------------------
// Web Fetch Tool
// ---------------------------------------------------------------------------

const WEB_FETCH_TIMEOUT_MS = 15_000;
const MAX_WEB_FETCH_CHARS = 32_000;

export async function executeWebFetch(
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ result: string; isError?: boolean }> {
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!url) {
    return { result: 'Error: url parameter required', isError: true };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { result: `Invalid URL: ${url}`, isError: true };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { result: `Only HTTP/HTTPS URLs are supported.`, isError: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort('web_fetch_timeout'),
    WEB_FETCH_TIMEOUT_MS,
  );
  const onAbort = () => controller.abort(signal.reason || 'aborted');
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'ClawRocket/1.0 (web-fetch tool)',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return {
        result: `HTTP ${response.status} ${response.statusText} fetching ${url}`,
        isError: true,
      };
    }

    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();

    let extracted: string;
    if (
      contentType.includes('text/html') ||
      contentType.includes('application/xhtml')
    ) {
      extracted = htmlToText(text);
    } else {
      extracted = text;
    }

    if (extracted.length > MAX_WEB_FETCH_CHARS) {
      const overflow = extracted.length - MAX_WEB_FETCH_CHARS;
      extracted = `${extracted.slice(0, MAX_WEB_FETCH_CHARS)}\n…truncated ${overflow} characters`;
    }

    return { result: extracted };
  } catch (err) {
    if (signal.aborted) throw err;
    const message = err instanceof Error ? err.message : 'Web fetch failed';
    return { result: `Error fetching ${url}: ${message}`, isError: true };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Minimal HTML-to-text: strips tags, decodes common entities,
 * strips script/style blocks, collapses whitespace.
 */
function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br\s*\/?)>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n/g, '\n\n');
  return text.trim();
}

// ---------------------------------------------------------------------------
// Web Search Tool
// ---------------------------------------------------------------------------

const WEB_SEARCH_TIMEOUT_MS = 10_000;
const MAX_SEARCH_RESULTS = 5;

export async function executeWebSearch(
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ result: string; isError?: boolean }> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    return { result: 'Error: query parameter required', isError: true };
  }

  const apiKey = process.env.BRAVE_SEARCH_API_KEY || '';
  if (!apiKey) {
    return {
      result:
        'Web search is not configured. Set BRAVE_SEARCH_API_KEY environment variable to enable web search.',
      isError: true,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort('web_search_timeout'),
    WEB_SEARCH_TIMEOUT_MS,
  );
  const onAbort = () => controller.abort(signal.reason || 'aborted');
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    const searchUrl = new URL('https://api.search.brave.com/res/v1/web/search');
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('count', String(MAX_SEARCH_RESULTS));

    const response = await fetch(searchUrl.toString(), {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
    });

    if (!response.ok) {
      return {
        result: `Search API returned HTTP ${response.status}: ${response.statusText}`,
        isError: true,
      };
    }

    const data = (await response.json()) as {
      web?: {
        results?: Array<{
          title?: string;
          url?: string;
          description?: string;
        }>;
      };
    };

    const results = data.web?.results || [];
    if (results.length === 0) {
      return { result: `No results found for: ${query}` };
    }

    const formatted = results
      .slice(0, MAX_SEARCH_RESULTS)
      .map(
        (r, i) =>
          `${i + 1}. ${r.title || '(no title)'}\n   ${r.url || ''}\n   ${r.description || ''}`,
      )
      .join('\n\n');

    return { result: formatted };
  } catch (err) {
    if (signal.aborted) throw err;
    const message = err instanceof Error ? err.message : 'Web search failed';
    return { result: `Error searching: ${message}`, isError: true };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------------------
// Tool Definitions (for inclusion in LLM context)
// ---------------------------------------------------------------------------

import type { LlmToolDefinition } from '../agents/llm-client.js';

export const WEB_TOOL_DEFINITIONS: LlmToolDefinition[] = [
  {
    name: 'web_fetch',
    description:
      'Fetch a web page by URL and return its text content. Supports HTTP/HTTPS. HTML is automatically converted to plain text.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'The full URL to fetch (must start with http:// or https://)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'web_search',
    description:
      'Search the web for information. Returns a list of results with titles, URLs, and descriptions. Requires BRAVE_SEARCH_API_KEY to be configured.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query',
        },
      },
      required: ['query'],
    },
  },
];
