/**
 * PDF text extraction via pdf-parse v2 (class-based API built on pdfjs-dist).
 */

import { PDFParse } from 'pdf-parse';

/** Extract text content from a PDF buffer. Returns the concatenated text and page count. */
export async function extractPdfText(data: Buffer): Promise<{ text: string; pageCount: number }> {
  const parser = new PDFParse({ data: new Uint8Array(data) });
  try {
    const result = await parser.getText();
    return {
      text: result.text.trim(),
      pageCount: result.total,
    };
  } finally {
    await parser.destroy();
  }
}
