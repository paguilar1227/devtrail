// src/telegram/mime-utils.ts
// MIME type inference and summarization routing utilities.
// Extracted from webhook.ts for independent testability.

/**
 * Map of file extensions to MIME types used when Telegram reports
 * a generic "application/octet-stream" for a file.
 */
export const EXTENSION_MIME_MAP: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  html: 'text/html',
  htm: 'text/html',
  xml: 'text/xml',
  md: 'text/markdown',
  rtf: 'application/rtf',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};

/**
 * Resolve the MIME type for a file. If the provided mimeType is missing or
 * the generic "application/octet-stream", we infer from the file extension.
 */
export function resolveMimeType(mimeType: string | undefined, fileName: string | undefined): string {
  const effective = mimeType ?? 'application/octet-stream';
  if (effective !== 'application/octet-stream' || !fileName) {
    return effective;
  }
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (ext && EXTENSION_MIME_MAP[ext]) {
    return EXTENSION_MIME_MAP[ext];
  }
  return 'application/octet-stream';
}

/** MIME types Gemini supports as inline binary data for summarization */
const GEMINI_SUPPORTED_BINARY = new Set([
  'application/pdf',
  'image/png', 'image/jpeg',
  'audio/mpeg', 'audio/wav',
  'video/mp4', 'video/quicktime',
]);

/** Text-based MIME types we can decode as UTF-8 for summarization */
const TEXT_TYPES = new Set([
  'text/html', 'text/plain', 'text/csv', 'text/xml', 'text/markdown',
  'application/json', 'application/rtf',
]);

export type SummarizationRoute = 'inline_data' | 'text_extraction' | 'unsupported';

/**
 * Determine which summarization path to use for a given MIME type:
 * - "inline_data": pass binary data to Gemini (PDF, images, audio, video)
 * - "text_extraction": read as UTF-8 text and summarize (HTML, plain text, CSV, etc.)
 * - "unsupported": cannot summarize, skip and warn
 */
export function getSummarizationRoute(mimeType: string): SummarizationRoute {
  if (GEMINI_SUPPORTED_BINARY.has(mimeType)) return 'inline_data';
  if (TEXT_TYPES.has(mimeType)) return 'text_extraction';
  return 'unsupported';
}
