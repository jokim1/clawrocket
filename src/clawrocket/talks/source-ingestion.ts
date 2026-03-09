/**
 * Source ingestion pipeline for context tab URL and file sources.
 *
 * Handles:
 *  - URL fetching with SSRF protection (connect-time enforcement)
 *  - HTML → text extraction
 *  - Status updates via updateSourceExtraction
 */

import { URL } from 'url';
import net from 'net';
import dns from 'dns/promises';
import http from 'http';
import https from 'https';

import { updateSourceExtraction } from '../db/index.js';
import { logger } from '../../logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_EXTRACTED_TEXT = 50_000;
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
const ALLOWED_CONTENT_TYPES = new Set([
  'text/plain',
  'text/html',
  'application/pdf',
]);

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

/**
 * Returns true if an IP address is in a blocked range (loopback, private,
 * link-local, multicast, or unspecified).
 */
function isBlockedIp(ip: string): boolean {
  // IPv4
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;

    // 127.0.0.0/8
    if (a === 127) return true;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) return true;
    // 224.0.0.0/4 (multicast)
    if (a >= 224 && a <= 239) return true;
    // 0.0.0.0
    if (a === 0) return true;

    return false;
  }

  // IPv6
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    // ::1 loopback
    if (
      normalized === '::1' ||
      normalized === '0000:0000:0000:0000:0000:0000:0000:0001'
    ) {
      return true;
    }
    // :: unspecified
    if (normalized === '::') return true;
    // fe80::/10 link-local
    if (normalized.startsWith('fe80:') || normalized.startsWith('fe80')) {
      return true;
    }
    // fc00::/7 unique-local
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
      return true;
    }
    // ff00::/8 multicast
    if (normalized.startsWith('ff')) return true;
    // IPv4-mapped ::ffff:x.x.x.x
    const v4Match = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4Match) return isBlockedIp(v4Match[1]);

    return false;
  }

  // Unknown format → block
  return true;
}

/**
 * Resolves a hostname and validates that no resolved address is in a blocked
 * IP range. Returns the first safe address.
 */
async function resolveAndValidateHost(hostname: string): Promise<string> {
  // If it's already an IP literal, validate directly
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new SourceIngestionError(
        'ssrf_blocked',
        `Address ${hostname} is in a blocked IP range.`,
      );
    }
    return hostname;
  }

  // Lowercase check for "localhost"
  if (hostname.toLowerCase() === 'localhost') {
    throw new SourceIngestionError(
      'ssrf_blocked',
      `Hostname "localhost" is blocked.`,
    );
  }

  const result = await dns.lookup(hostname, { all: true });
  if (result.length === 0) {
    throw new SourceIngestionError(
      'dns_resolution_failed',
      `Could not resolve hostname: ${hostname}`,
    );
  }

  for (const entry of result) {
    if (isBlockedIp(entry.address)) {
      throw new SourceIngestionError(
        'ssrf_blocked',
        `Resolved address ${entry.address} for ${hostname} is in a blocked IP range.`,
      );
    }
  }

  return result[0].address;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class SourceIngestionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SourceIngestionError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// URL fetching with SSRF protection
// ---------------------------------------------------------------------------

interface FetchResult {
  body: string;
  contentType: string;
  finalUrl: string;
}

/**
 * Makes a single HTTP/HTTPS request using Node's native modules with a
 * custom DNS `lookup` callback that returns only the pre-validated IP.
 *
 * This is the connect-time SSRF enforcement: the resolved IP is bound to
 * the actual socket, preventing DNS rebinding. For HTTPS, TLS SNI and
 * certificate validation use the original hostname automatically because
 * the hostname stays in the URL — only the DNS resolution is overridden.
 */
function nodeRequest(
  url: URL,
  resolvedIp: string,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;

    const customLookup: net.LookupFunction = (_hostname, _options, cb) => {
      const family: 4 | 6 = net.isIPv6(resolvedIp) ? 6 : 4;
      cb(null, resolvedIp, family);
    };

    const req = mod.request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'RocketClaw-SourceIngestion/1.0',
          Accept: 'text/html, text/plain, application/pdf, */*',
        },
        timeout: FETCH_TIMEOUT_MS,
        lookup: customLookup as net.LookupFunction,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let destroyed = false;

        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            destroyed = true;
            res.destroy();
            reject(
              new SourceIngestionError(
                'response_too_large',
                `Response exceeds ${MAX_RESPONSE_BYTES} byte limit.`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          if (destroyed) return;
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });

        res.on('error', (err) => {
          if (!destroyed) reject(err);
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(
        new SourceIngestionError(
          'fetch_timeout',
          `Request to ${url.toString()} timed out after ${FETCH_TIMEOUT_MS}ms.`,
        ),
      );
    });

    req.on('error', (err) => {
      reject(
        new SourceIngestionError(
          'fetch_error',
          `Failed to fetch ${url.toString()}: ${String(err)}`,
        ),
      );
    });

    req.end();
  });
}

/**
 * Fetches a URL with SSRF-safe connect-time enforcement.
 *
 * Each hop (initial + redirects) is validated:
 *  1. Scheme must be http or https
 *  2. All resolved IPs must not be in a blocked range
 *  3. The validated IP is bound to the socket via a custom DNS lookup,
 *     preventing DNS rebinding while preserving TLS SNI/certificate validation
 *
 * Returns the raw text body and content type.
 */
export async function safeFetchUrl(inputUrl: string): Promise<FetchResult> {
  let currentUrl = inputUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(currentUrl);

    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
      throw new SourceIngestionError(
        'invalid_scheme',
        `URL scheme "${parsed.protocol}" is not allowed. Only http and https are supported.`,
      );
    }

    // SSRF: resolve DNS and validate all IPs. The returned IP is then
    // bound to the actual socket via nodeRequest's custom lookup callback,
    // preventing DNS rebinding.
    const resolvedIp = await resolveAndValidateHost(parsed.hostname);

    const result = await nodeRequest(parsed, resolvedIp);

    // Handle redirects manually so we validate each hop
    if (result.status >= 300 && result.status < 400) {
      const location = Array.isArray(result.headers['location'])
        ? result.headers['location'][0]
        : result.headers['location'];
      if (!location) {
        throw new SourceIngestionError(
          'redirect_error',
          `Redirect response (${result.status}) missing Location header.`,
        );
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    if (result.status < 200 || result.status >= 300) {
      throw new SourceIngestionError(
        'fetch_http_error',
        `HTTP ${result.status} from ${currentUrl}`,
      );
    }

    // Validate content type
    const rawContentType =
      (Array.isArray(result.headers['content-type'])
        ? result.headers['content-type'][0]
        : result.headers['content-type']) ?? '';
    const mimeType = rawContentType.split(';')[0].trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(mimeType)) {
      throw new SourceIngestionError(
        'unsupported_content_type',
        `Content type "${mimeType}" is not supported. Allowed: ${[...ALLOWED_CONTENT_TYPES].join(', ')}.`,
      );
    }

    const body = result.body.toString('utf-8');
    return { body, contentType: mimeType, finalUrl: currentUrl };
  }

  throw new SourceIngestionError(
    'too_many_redirects',
    `Exceeded ${MAX_REDIRECTS} redirects.`,
  );
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

/**
 * Extracts plain text from HTML by stripping tags and normalizing whitespace.
 * Simple regex-based approach for v1 — no DOM parser needed.
 */
export function extractTextFromHtml(html: string): string {
  let text = html;

  // Remove script and style blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');

  // Convert certain block elements to newlines
  text = text.replace(
    /<\/?(?:p|div|br|h[1-6]|li|tr|td|th|blockquote|pre|hr)[^>]*>/gi,
    '\n',
  );

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode common HTML entities
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

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n[ ]+/g, '\n');
  text = text.replace(/[ ]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

/**
 * Extracts text from fetched content based on content type.
 */
function extractText(body: string, contentType: string): string {
  switch (contentType) {
    case 'text/html':
      return extractTextFromHtml(body);
    case 'text/plain':
      return body.trim();
    case 'application/pdf':
      // PDF text extraction not implemented in v1.
      // The raw binary body is useless as text — we'd need a PDF parser.
      // For now, return an error message. A future version should use
      // a PDF-to-text library.
      return '[PDF content — text extraction not yet supported in v1]';
    default:
      return body.trim();
  }
}

// ---------------------------------------------------------------------------
// Ingestion entry point
// ---------------------------------------------------------------------------

/**
 * Fetches a URL source, extracts text, and updates the database record.
 * This is designed to be called from a background queue/worker.
 *
 * On success: source status → ready, extracted text stored.
 * On failure: extraction_error written; if last-good content exists,
 * status stays ready; otherwise status → failed.
 */
export async function ingestUrlSource(
  sourceId: string,
  url: string,
): Promise<void> {
  try {
    const result = await safeFetchUrl(url);
    const extracted = extractText(result.body, result.contentType);

    updateSourceExtraction({
      sourceId,
      extractedText: extracted,
      extractionError: null,
      mimeType: result.contentType,
    });

    logger.info(
      `[source-ingestion] URL source ${sourceId} ingested successfully ` +
        `(${extracted.length} chars, type=${result.contentType}).`,
    );
  } catch (err) {
    const message =
      err instanceof SourceIngestionError
        ? `${err.code}: ${err.message}`
        : String(err);

    updateSourceExtraction({
      sourceId,
      extractedText: null,
      extractionError: message,
    });

    logger.warn(
      `[source-ingestion] URL source ${sourceId} ingestion failed: ${message}`,
    );
  }
}

/**
 * Processes an uploaded file's content and stores extracted text.
 * For v1, we handle text-based formats directly. PDF extraction is deferred.
 */
export function ingestFileSource(
  sourceId: string,
  fileContent: string | Buffer,
  mimeType: string,
  fileName: string,
): void {
  try {
    const textContent =
      typeof fileContent === 'string'
        ? fileContent
        : fileContent.toString('utf-8');

    let extracted: string;
    switch (mimeType) {
      case 'text/plain':
      case 'text/markdown':
        extracted = textContent.trim();
        break;
      case 'text/html':
        extracted = extractTextFromHtml(textContent);
        break;
      case 'application/pdf':
        extracted = '[PDF content — text extraction not yet supported in v1]';
        break;
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        extracted = '[DOCX content — text extraction not yet supported in v1]';
        break;
      default:
        extracted = textContent.trim();
        break;
    }

    updateSourceExtraction({
      sourceId,
      extractedText: extracted,
      extractionError: null,
      mimeType,
    });

    logger.info(
      `[source-ingestion] File source ${sourceId} (${fileName}) ingested ` +
        `(${extracted.length} chars, type=${mimeType}).`,
    );
  } catch (err) {
    const message = String(err);

    updateSourceExtraction({
      sourceId,
      extractedText: null,
      extractionError: message,
    });

    logger.warn(
      `[source-ingestion] File source ${sourceId} (${fileName}) ingestion failed: ${message}`,
    );
  }
}
