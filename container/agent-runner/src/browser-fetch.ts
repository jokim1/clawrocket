import { execFile } from 'child_process';

interface BrowserFetchInput {
  url: string;
  timeoutMs?: number;
}

interface BrowserFetchOutput {
  status: 'success' | 'error';
  finalUrl?: string;
  pageTitle?: string | null;
  extractedText?: string;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const CHROMIUM_BIN =
  process.env.AGENT_BROWSER_EXECUTABLE_PATH ||
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  '/usr/bin/chromium';
const FALLBACK_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function extractPreferredHtml(html: string): string {
  const selectors = [
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<body\b[^>]*>([\s\S]*?)<\/body>/i,
  ];
  for (const pattern of selectors) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }
  return html;
}

function extractTextFromHtml(html: string): string {
  let text = extractPreferredHtml(html);
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  text = text.replace(
    /<\/?(?:p|div|br|h[1-6]|li|tr|td|th|blockquote|pre|hr|section|article)[^>]*>/gi,
    '\n',
  );
  text = text.replace(/<[^>]+>/g, ' ');
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n[ ]+/g, '\n');
  text = text.replace(/[ ]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) return null;
  return match[1].replace(/\s+/g, ' ').trim();
}

function dumpDom(url: string, timeoutMs: number): Promise<string> {
  const args = [
    '--headless',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--hide-scrollbars',
    '--user-agent=' + FALLBACK_USER_AGENT,
    '--virtual-time-budget=8000',
    '--dump-dom',
    url,
  ];

  return new Promise((resolve, reject) => {
    execFile(
      CHROMIUM_BIN,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 12 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              stderr?.trim() ||
                err.message ||
                'Chromium failed to render the page.',
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function main(): Promise<void> {
  try {
    const raw = await readStdin();
    const parsed = JSON.parse(raw) as BrowserFetchInput;
    if (!parsed || typeof parsed.url !== 'string' || !parsed.url.trim()) {
      throw new Error('A URL is required for browser ingestion.');
    }
    const timeoutMs =
      typeof parsed.timeoutMs === 'number' && Number.isFinite(parsed.timeoutMs)
        ? Math.max(1_000, parsed.timeoutMs)
        : DEFAULT_TIMEOUT_MS;

    const html = await dumpDom(parsed.url, timeoutMs);
    const extractedText = extractTextFromHtml(html);
    const output: BrowserFetchOutput = {
      status: 'success',
      finalUrl: parsed.url,
      pageTitle: extractTitle(html),
      extractedText,
    };
    process.stdout.write(JSON.stringify(output));
  } catch (err) {
    const output: BrowserFetchOutput = {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
    process.stdout.write(JSON.stringify(output));
    process.exitCode = 1;
  }
}

void main();
