import { randomUUID } from 'crypto';

import {
  createMessageAttachment,
  getMessageAttachmentById,
  getTalkForUser,
  listMessageAttachments,
  listTalkAttachments,
  updateAttachmentExtraction,
  type AttachmentSnapshot,
} from '../../db/index.js';
import { canEditTalk } from '../middleware/acl.js';
import type { ApiEnvelope, AuthContext } from '../types.js';

import { saveAttachmentFile } from '../../talks/attachment-storage.js';
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_SIZE,
  extractAttachmentText,
} from '../../talks/attachment-extraction.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notFoundResponse(message: string): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 404,
    body: { ok: false, error: { code: 'not_found', message } },
  };
}

function forbiddenResponse(message: string): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 403,
    body: { ok: false, error: { code: 'forbidden', message } },
  };
}

function badRequest(
  code: string,
  message: string,
): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 400,
    body: { ok: false, error: { code, message } },
  };
}

// ---------------------------------------------------------------------------
// POST /talks/:talkId/attachments
// ---------------------------------------------------------------------------

export async function uploadTalkAttachmentRoute(input: {
  auth: AuthContext;
  talkId: string;
  file: {
    name: string;
    data: Buffer;
    type: string;
  };
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ attachment: AttachmentSnapshot }>;
}> {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');

  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbiddenResponse(
      'You do not have permission to upload to this talk.',
    );
  }

  const { file } = input;

  // Browsers sometimes send empty or generic MIME types (e.g. application/octet-stream).
  // Fall back to extension-based inference so valid files aren't rejected.
  const EXTENSION_MIME_MAP: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.pdf': 'application/pdf',
    '.docx':
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx':
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };

  let mimeType = file.type;
  if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeType)) {
    const ext = file.name.includes('.')
      ? `.${file.name.split('.').pop()!.toLowerCase()}`
      : '';
    const inferred = EXTENSION_MIME_MAP[ext];
    if (inferred) {
      mimeType = inferred;
    }
  }

  // Validate MIME type
  if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeType)) {
    return badRequest(
      'unsupported_file_type',
      `File type "${mimeType}" is not supported. Allowed: ${[...ALLOWED_ATTACHMENT_MIME_TYPES].join(', ')}`,
    );
  }

  // Validate file size
  if (file.data.length > MAX_ATTACHMENT_SIZE) {
    return badRequest(
      'file_too_large',
      `File exceeds maximum size of ${MAX_ATTACHMENT_SIZE / (1024 * 1024)} MB`,
    );
  }

  const attachmentId = `att_${randomUUID()}`;

  // Save raw file to disk
  const storageKey = await saveAttachmentFile(
    attachmentId,
    input.talkId,
    file.data,
    file.name,
  );

  // Create DB record
  const attachment = createMessageAttachment({
    id: attachmentId,
    talkId: input.talkId,
    fileName: file.name,
    fileSize: file.data.length,
    mimeType,
    storageKey,
    createdBy: input.auth.userId,
  });

  // Extract text synchronously (files are ≤10 MB, extraction is fast enough)
  try {
    const extractedText = await extractAttachmentText(
      file.data,
      mimeType,
      file.name,
    );
    updateAttachmentExtraction({
      attachmentId,
      extractedText,
      extractionStatus: 'extracted',
    });
    // Re-read to get updated status
    const updated = getMessageAttachmentById(attachmentId, input.talkId);
    if (updated) {
      return {
        statusCode: 201,
        body: {
          ok: true,
          data: {
            attachment: {
              id: updated.id,
              messageId: updated.message_id,
              fileName: updated.file_name,
              fileSize: updated.file_size,
              mimeType: updated.mime_type,
              extractionStatus: updated.extraction_status,
              extractionError: updated.extraction_error,
              extractedTextLength: updated.extracted_text?.length ?? null,
              createdAt: updated.created_at,
            },
          },
        },
      };
    }
  } catch (err) {
    updateAttachmentExtraction({
      attachmentId,
      extractionError:
        err instanceof Error ? err.message : 'Unknown extraction error',
      extractionStatus: 'failed',
    });
  }

  return {
    statusCode: 201,
    body: { ok: true, data: { attachment } },
  };
}

// ---------------------------------------------------------------------------
// GET /talks/:talkId/attachments
// ---------------------------------------------------------------------------

export function listTalkAttachmentsRoute(input: {
  auth: AuthContext;
  talkId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ attachments: AttachmentSnapshot[] }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: { attachments: listTalkAttachments(input.talkId) },
    },
  };
}
