import { extractTextFromHtml } from './source-ingestion.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_EXTRACTED_CHARS = 50_000;
const TRUNCATION_MARKER = '\n\n[…truncated — content exceeds extraction limit]';

// ---------------------------------------------------------------------------
// MIME type allow-list
// ---------------------------------------------------------------------------

export const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10 MB
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class AttachmentExtractionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AttachmentExtractionError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Truncation helper
// ---------------------------------------------------------------------------

function truncate(text: string): string {
  if (text.length <= MAX_EXTRACTED_CHARS) return text;
  return text.slice(0, MAX_EXTRACTED_CHARS) + TRUNCATION_MARKER;
}

// ---------------------------------------------------------------------------
// Text-based extraction (plain text, markdown, CSV)
// ---------------------------------------------------------------------------

function extractTextDirect(buffer: Buffer): string {
  return truncate(buffer.toString('utf-8'));
}

// ---------------------------------------------------------------------------
// HTML extraction
// ---------------------------------------------------------------------------

function extractHtml(buffer: Buffer): string {
  const html = buffer.toString('utf-8');
  const text = extractTextFromHtml(html);
  return truncate(text);
}

// ---------------------------------------------------------------------------
// PDF extraction (lazy-loaded)
// ---------------------------------------------------------------------------

async function extractPdf(buffer: Buffer, fileName: string): Promise<string> {
  try {
    // Dynamic import so the dependency is optional at module load time
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParseMod = await import('pdf-parse');
    const pdfParse = (pdfParseMod as any).default ?? pdfParseMod;
    const data = await pdfParse(buffer, { max: 0 }); // max: 0 → all pages
    const text = data.text?.trim();
    if (!text || text.length < 10) {
      return `[Scanned PDF — no extractable text layer found in "${fileName}". OCR is not currently supported.]`;
    }
    return truncate(text);
  } catch (err) {
    throw new AttachmentExtractionError(
      'pdf_extraction_failed',
      `Failed to extract text from PDF "${fileName}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// DOCX extraction (lazy-loaded)
// ---------------------------------------------------------------------------

async function extractDocx(buffer: Buffer, fileName: string): Promise<string> {
  try {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value?.trim();
    if (!text) {
      return `[Empty DOCX document: "${fileName}"]`;
    }
    return truncate(text);
  } catch (err) {
    throw new AttachmentExtractionError(
      'docx_extraction_failed',
      `Failed to extract text from DOCX "${fileName}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Excel extraction (lazy-loaded)
// ---------------------------------------------------------------------------

const MAX_EXCEL_SHEETS = 10;

async function extractExcel(buffer: Buffer, fileName: string): Promise<string> {
  try {
    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);

    const parts: string[] = [];
    let sheetCount = 0;

    for (const worksheet of workbook.worksheets) {
      if (sheetCount >= MAX_EXCEL_SHEETS) {
        parts.push(
          `\n[…${workbook.worksheets.length - MAX_EXCEL_SHEETS} additional sheet(s) omitted]`,
        );
        break;
      }

      parts.push(`\n## Sheet: ${worksheet.name}\n`);

      worksheet.eachRow((row, rowNumber) => {
        const cells = (row.values as unknown[])
          .slice(1) // ExcelJS row.values is 1-indexed, index 0 is empty
          .map((v) => {
            if (v === null || v === undefined) return '';
            if (
              typeof v === 'object' &&
              'result' in (v as Record<string, unknown>)
            ) {
              return String((v as { result: unknown }).result ?? '');
            }
            return String(v);
          });
        parts.push(`| ${cells.join(' | ')} |`);

        // Add header separator after first row
        if (rowNumber === 1) {
          parts.push(`| ${cells.map(() => '---').join(' | ')} |`);
        }
      });

      sheetCount += 1;
    }

    const text = parts.join('\n').trim();
    if (!text) {
      return `[Empty spreadsheet: "${fileName}"]`;
    }
    return truncate(text);
  } catch (err) {
    throw new AttachmentExtractionError(
      'excel_extraction_failed',
      `Failed to extract data from spreadsheet "${fileName}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Router: dispatch to the appropriate extractor
// ---------------------------------------------------------------------------

export async function extractAttachmentText(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<string> {
  switch (mimeType) {
    case 'text/plain':
    case 'text/markdown':
    case 'text/csv':
      return extractTextDirect(buffer);

    case 'text/html':
      return extractHtml(buffer);

    case 'application/pdf':
      return extractPdf(buffer, fileName);

    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return extractDocx(buffer, fileName);

    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return extractExcel(buffer, fileName);

    default:
      // Best-effort: treat as UTF-8 text
      return truncate(buffer.toString('utf-8'));
  }
}
