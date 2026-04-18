/**
 * PDF text extraction via pdf-parse (not Gemini Flash).
 *
 * pdf-parse ships a CommonJS build that auto-runs a test on import — we use
 * createRequire to load it lazily and avoid the test-on-import side-effect.
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/** Extract text content from a PDF buffer. Returns the raw text. */
export async function extractPdfText(data: Buffer): Promise<{ text: string; pageCount: number }> {
  // Lazy import — pdf-parse has a top-level test file it tries to read on import
  // when required directly. Loading inside the function delays the module resolution.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse: (buf: Buffer) => Promise<{ text: string; numpages: number }> =
    require('pdf-parse/lib/pdf-parse.js');

  const result = await pdfParse(data);
  return {
    text: result.text.trim(),
    pageCount: result.numpages,
  };
}
