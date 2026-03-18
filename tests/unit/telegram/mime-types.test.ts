// tests/unit/telegram/mime-types.test.ts — Section 16: MIME type handling
import { describe, it, expect } from 'vitest';
import { resolveMimeType, getSummarizationRoute } from '../../../src/telegram/mime-utils.js';

describe('Section 16: MIME Type Inference', () => {
  it('16.1 (undefined, "file.pdf") → "application/pdf"', () => {
    expect(resolveMimeType(undefined, 'file.pdf')).toBe('application/pdf');
  });

  it('16.2 (undefined, "page.html") → "text/html"', () => {
    expect(resolveMimeType(undefined, 'page.html')).toBe('text/html');
  });

  it('16.3 (undefined, "photo.jpg") → "image/jpeg"', () => {
    expect(resolveMimeType(undefined, 'photo.jpg')).toBe('image/jpeg');
  });

  it('16.4 (undefined, "mystery.xyz") → "application/octet-stream"', () => {
    expect(resolveMimeType(undefined, 'mystery.xyz')).toBe('application/octet-stream');
  });

  it('16.5 ("application/pdf", "file.pdf") → "application/pdf"', () => {
    expect(resolveMimeType('application/pdf', 'file.pdf')).toBe('application/pdf');
  });

  it('16.6 ("application/octet-stream", "file.pdf") → "application/pdf" (infer from extension)', () => {
    expect(resolveMimeType('application/octet-stream', 'file.pdf')).toBe('application/pdf');
  });
});

describe('Section 16: Summarization Routing', () => {
  it('16.7 mimeType "text/html" → text extraction path (not inline data)', () => {
    expect(getSummarizationRoute('text/html')).toBe('text_extraction');
  });

  it('16.8 mimeType "application/pdf" → inline data path', () => {
    expect(getSummarizationRoute('application/pdf')).toBe('inline_data');
  });

  it('16.9 mimeType "application/zip" → unsupported path', () => {
    expect(getSummarizationRoute('application/zip')).toBe('unsupported');
  });
});
