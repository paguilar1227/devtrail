// src/capture/media-convert.ts
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile, readFile, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);

export interface ConvertedFile {
  data: Buffer;
  mimeType: string; // guaranteed to be Gemini-supported
  originalMimeType: string;
}

// Supported MIME types for Gemini Embedding 2
const SUPPORTED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'audio/mpeg',
  'audio/wav',
  'video/mp4',
  'video/quicktime',
  'application/pdf',
]);

// Check if ffmpeg is available on the system.
// The result is cached after the first check to avoid repeated process spawns.
// Call resetFfmpegCache() in tests to force a fresh check.
let _ffmpegAvailableCache: boolean | null = null;

export function resetFfmpegCache(): void {
  _ffmpegAvailableCache = null;
}

async function isFfmpegAvailable(): Promise<boolean> {
  if (_ffmpegAvailableCache !== null) return _ffmpegAvailableCache;
  try {
    await execFileAsync('ffmpeg', ['-version']);
    _ffmpegAvailableCache = true;
  } catch {
    _ffmpegAvailableCache = false;
  }
  return _ffmpegAvailableCache;
}

async function convertWithFfmpeg(
  data: Buffer,
  inputExt: string,
  outputExt: string,
  outputMime: string,
): Promise<Buffer> {
  const id = randomUUID();
  const inputPath = join(tmpdir(), `ob2-${id}-input.${inputExt}`);
  const outputPath = join(tmpdir(), `ob2-${id}-output.${outputExt}`);

  try {
    await writeFile(inputPath, data);
    await execFileAsync('ffmpeg', ['-y', '-i', inputPath, outputPath]);
    return await readFile(outputPath);
  } finally {
    await unlink(inputPath).catch(() => undefined);
    await unlink(outputPath).catch(() => undefined);
  }
}

async function convertImage(data: Buffer, targetMime: string): Promise<Buffer> {
  // Dynamically import sharp so the module can be loaded even if sharp is absent (tests mock it)
  const sharp = (await import('sharp')).default;
  if (targetMime === 'image/jpeg') {
    return sharp(data).jpeg().toBuffer();
  }
  return sharp(data).png().toBuffer();
}

export async function convertForEmbedding(
  data: Buffer,
  mimeType: string,
): Promise<ConvertedFile> {
  const originalMimeType = mimeType;

  // Already supported — pass through unchanged
  if (SUPPORTED_MIME_TYPES.has(mimeType)) {
    return { data, mimeType, originalMimeType };
  }

  const category = mimeType.split('/')[0]; // 'image', 'audio', 'video', 'text', …

  // ── Image conversion (via sharp) ──────────────────────────────────────────
  if (category === 'image') {
    const targetMime =
      mimeType === 'image/heic' ? 'image/jpeg' : 'image/png';
    try {
      const converted = await convertImage(data, targetMime);
      return { data: converted, mimeType: targetMime, originalMimeType };
    } catch (err) {
      console.warn(`[media-convert] sharp conversion failed for ${mimeType}:`, err);
      // Return original data with a supported label as graceful fallback
      return { data, mimeType: 'image/png', originalMimeType };
    }
  }

  // ── Audio conversion (via ffmpeg) ─────────────────────────────────────────
  if (category === 'audio') {
    const available = await isFfmpegAvailable();
    if (!available) {
      console.warn(
        `[media-convert] ffmpeg not available; skipping audio conversion for ${mimeType}. Embedding text only.`,
      );
      // Signal to the caller that media should be skipped by returning null-like sentinel
      return { data: Buffer.alloc(0), mimeType: 'audio/wav', originalMimeType };
    }

    const inputExt = mimeType === 'audio/ogg' || mimeType === 'audio/x-opus'
      ? 'ogg'
      : mimeType.split('/')[1] ?? 'audio';

    try {
      const converted = await convertWithFfmpeg(data, inputExt, 'wav', 'audio/wav');
      return { data: converted, mimeType: 'audio/wav', originalMimeType };
    } catch (err) {
      console.warn(`[media-convert] ffmpeg audio conversion failed for ${mimeType}:`, err);
      return { data: Buffer.alloc(0), mimeType: 'audio/wav', originalMimeType };
    }
  }

  // ── Video conversion (via ffmpeg) ─────────────────────────────────────────
  if (category === 'video') {
    const available = await isFfmpegAvailable();
    if (!available) {
      console.warn(
        `[media-convert] ffmpeg not available; skipping video conversion for ${mimeType}. Embedding text only.`,
      );
      return { data: Buffer.alloc(0), mimeType: 'video/mp4', originalMimeType };
    }

    const inputExt = mimeType.split('/')[1] ?? 'video';

    try {
      const converted = await convertWithFfmpeg(data, inputExt, 'mp4', 'video/mp4');
      return { data: converted, mimeType: 'video/mp4', originalMimeType };
    } catch (err) {
      console.warn(`[media-convert] ffmpeg video conversion failed for ${mimeType}:`, err);
      return { data: Buffer.alloc(0), mimeType: 'video/mp4', originalMimeType };
    }
  }

  // ── Text / unsupported — throw so callers can decide to embed text only ───
  throw new Error(`[media-convert] Unsupported MIME type for embedding: ${mimeType}`);
}
