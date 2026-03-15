// tests/unit/capture/media-convert.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock sharp ────────────────────────────────────────────────────────────────
const mockSharpInstance = {
  png: vi.fn().mockReturnThis(),
  jpeg: vi.fn().mockReturnThis(),
  toBuffer: vi.fn().mockResolvedValue(Buffer.from('converted-image')),
};
const mockSharp = vi.fn(() => mockSharpInstance);

vi.mock('sharp', () => ({ default: mockSharp }));

// ── Mock child_process so ffmpeg calls are intercepted ───────────────────────
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

// ── Mock fs/promises so tmp file I/O is intercepted ──────────────────────────
vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(Buffer.from('converted-audio')),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

// Pull in mocks after vi.mock declarations
import { execFile } from 'child_process';
import { convertForEmbedding, resetFfmpegCache } from '../../../src/capture/media-convert.js';

const execFileMock = vi.mocked(execFile);

// Helper: make execFile invoke its callback with (null, '', '')
function makeExecFileSucceed() {
  execFileMock.mockImplementation((_cmd, _args, callback: any) => {
    callback(null, '', '');
    return {} as any;
  });
}

function makeExecFileFail(message = 'not found') {
  execFileMock.mockImplementation((_cmd, _args, callback: any) => {
    callback(new Error(message), '', '');
    return {} as any;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the ffmpeg availability cache so each test controls the result independently
  resetFfmpegCache();
});

// ── Passthrough tests ─────────────────────────────────────────────────────────
describe('convertForEmbedding — supported MIME types pass through unchanged', () => {
  const supported = [
    'image/png',
    'image/jpeg',
    'audio/mpeg',
    'audio/wav',
    'video/mp4',
    'video/quicktime',
    'application/pdf',
  ];

  for (const mime of supported) {
    it(`passes through ${mime} without conversion`, async () => {
      // ffmpeg check should NOT be called for supported types
      const data = Buffer.from('original');
      const result = await convertForEmbedding(data, mime);

      expect(result.data).toBe(data); // same reference — no copy
      expect(result.mimeType).toBe(mime);
      expect(result.originalMimeType).toBe(mime);
      expect(execFileMock).not.toHaveBeenCalled();
      expect(mockSharp).not.toHaveBeenCalled();
    });
  }
});

// ── Image conversion tests ────────────────────────────────────────────────────
describe('convertForEmbedding — image conversion via sharp', () => {
  it('converts image/webp → image/png', async () => {
    const data = Buffer.from('webp-bytes');
    const result = await convertForEmbedding(data, 'image/webp');

    expect(mockSharp).toHaveBeenCalledWith(data);
    expect(mockSharpInstance.png).toHaveBeenCalled();
    expect(result.mimeType).toBe('image/png');
    expect(result.originalMimeType).toBe('image/webp');
    expect(result.data.toString()).toBe('converted-image');
  });

  it('converts image/gif → image/png', async () => {
    const data = Buffer.from('gif-bytes');
    const result = await convertForEmbedding(data, 'image/gif');

    expect(result.mimeType).toBe('image/png');
    expect(result.originalMimeType).toBe('image/gif');
  });

  it('converts image/heic → image/jpeg', async () => {
    const data = Buffer.from('heic-bytes');
    const result = await convertForEmbedding(data, 'image/heic');

    expect(mockSharpInstance.jpeg).toHaveBeenCalled();
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.originalMimeType).toBe('image/heic');
  });

  it('falls back gracefully when sharp throws', async () => {
    mockSharpInstance.toBuffer.mockRejectedValueOnce(new Error('sharp error'));
    const data = Buffer.from('bad-image');
    const result = await convertForEmbedding(data, 'image/webp');

    // Should return original data with a supported MIME label
    expect(result.data).toBe(data);
    expect(result.mimeType).toBe('image/png');
    expect(result.originalMimeType).toBe('image/webp');
  });
});

// ── Audio conversion tests ────────────────────────────────────────────────────
describe('convertForEmbedding — audio conversion via ffmpeg', () => {
  it('converts audio/ogg → audio/wav when ffmpeg is available', async () => {
    // First call: ffmpeg -version (availability check), second: actual conversion
    makeExecFileSucceed();
    const data = Buffer.from('ogg-bytes');
    const result = await convertForEmbedding(data, 'audio/ogg');

    expect(result.mimeType).toBe('audio/wav');
    expect(result.originalMimeType).toBe('audio/ogg');
    expect(result.data.toString()).toBe('converted-audio');
  });

  it('converts audio/x-opus → audio/wav when ffmpeg is available', async () => {
    makeExecFileSucceed();
    const data = Buffer.from('opus-bytes');
    const result = await convertForEmbedding(data, 'audio/x-opus');

    expect(result.mimeType).toBe('audio/wav');
    expect(result.originalMimeType).toBe('audio/x-opus');
  });

  it('returns empty buffer and logs warning when ffmpeg is unavailable', async () => {
    makeExecFileFail('ffmpeg: not found');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const data = Buffer.from('ogg-bytes');
    const result = await convertForEmbedding(data, 'audio/ogg');

    expect(result.data.length).toBe(0);
    expect(result.mimeType).toBe('audio/wav');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ffmpeg not available'),
    );
    warnSpy.mockRestore();
  });
});

// ── Video conversion tests ────────────────────────────────────────────────────
describe('convertForEmbedding — video conversion via ffmpeg', () => {
  it('converts unknown video → video/mp4 when ffmpeg is available', async () => {
    makeExecFileSucceed();
    const data = Buffer.from('video-bytes');
    const result = await convertForEmbedding(data, 'video/webm');

    expect(result.mimeType).toBe('video/mp4');
    expect(result.originalMimeType).toBe('video/webm');
  });

  it('returns empty buffer when ffmpeg is unavailable for video', async () => {
    makeExecFileFail('ffmpeg: not found');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await convertForEmbedding(Buffer.from('video'), 'video/webm');

    expect(result.data.length).toBe(0);
    expect(result.mimeType).toBe('video/mp4');
    warnSpy.mockRestore();
  });
});

// ── Unsupported type ─────────────────────────────────────────────────────────
describe('convertForEmbedding — unsupported types throw', () => {
  it('throws for text/plain', async () => {
    await expect(
      convertForEmbedding(Buffer.from('hello'), 'text/plain'),
    ).rejects.toThrow('Unsupported MIME type');
  });

  it('throws for application/json', async () => {
    await expect(
      convertForEmbedding(Buffer.from('{}'), 'application/json'),
    ).rejects.toThrow('Unsupported MIME type');
  });
});
