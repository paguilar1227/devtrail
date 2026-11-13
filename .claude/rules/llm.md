---
paths:
  - "backend/src/providers/**"
  - "backend/src/capture/**"
---

# LLM provider + capture rules

Loads when touching `providers/` or `capture/`. JSON parsing gotchas, output token budgets, model ID pinning, multimodal embeddings, URL fetcher quirks.

## LLM JSON parsing — always pipe through `extractJson()`

Anthropic and Gemini both sometimes return JSON wrapped in ` ```json … ``` ` fences **even with `responseFormat: 'json'`**. Plain `JSON.parse(response.content)` will throw. Always route LLM JSON output through `extractJson()` from `backend/src/providers/json-utils.ts` before parsing. When you add a new LLM-JSON call site, use this — don't reinvent the parsing.

## Output token budget

- **Haiku 4.5 metadata calls use `maxTokens: 8192`** for PDF-scale inputs. Raised from 2048 because PDF body extraction was truncating mid-JSON (commit `fix(metadata): raise Flash maxTokens 2048→8192 for PDF-scale inputs`).
- For entity extraction, 4096 is enough because we cap input at 50k chars.
- Anthropic "thinking" tokens count against the output budget — if you see truncated JSON despite a high `maxTokens`, the model is using budget for internal reasoning. Split the call by caller context (per `[[feedback-flash-prompt-output-budget]]` in user memory).

## Model IDs change

Verify the current ID if you get 404s. The codebase pins Haiku to `claude-haiku-4-5-20251001` explicitly. Don't trust the unpinned alias (`claude-haiku-latest`) — it can shift under you.

## Gemini Embedding 2

- Model ID: `gemini-embedding-2-preview`. Default dim is 768 — we **explicitly request 3072**.
- Multimodal: accepts `image/png`, `image/jpeg`, `audio/mpeg`, `audio/wav`, `video/mp4`, `video/quicktime`, `application/pdf`.
- The Generative Language API must be enabled on the GCP project tied to the API key.

## PDF extraction (`pdf-extract.ts`)

`pdf-parse` v2 ships a `PDFParse` **class** instead of the v1 default-import function. The codebase uses `import { PDFParse } from 'pdf-parse'` + `new PDFParse({ data: bytes }).getText()`. Don't `import pdf from 'pdf-parse'` — that's the v1 API and it won't exist.

## URL ingestion (`services/url-ingest.ts` + the URL providers)

- **YouTube:** Supadata single-call. Replaced the direct-scrape → Firecrawl → xAI fallback chain (commit `72885b1`); failure surfaces as `YOUTUBE_TRANSCRIPT_MISS:` rather than retrying.
- **X/Twitter:** xAI Grok live-search primary, Firecrawl stealth fallback. Detect failure phrases up front and surface `X_SEARCH_MISS:` rather than saving useless content.
- **YouTube snowflake IDs** — decode the post snowflake to derive a ±6hr search window so `x_search` can actually find the post.
- **PDFs by URL:** downloaded as bytes → `pdf-parse` (see above).
- **HTML:** Firecrawl markdown extraction. Reject results shorter than 300 chars or matching error/placeholder titles ("Example Domain", 404 patterns, etc.) — they're not real content.
- **Dedup:** by `source_url` first, then by `file_hash` for binary downloads.

## Stub mode for local dev

`LLM_PROVIDER=stub` (set in local `.env`) replaces both the embedding and LLM providers with deterministic in-memory fakes (`providers/stub.ts`). Sufficient for the full ingest → search → RAG pipeline running end-to-end without paid APIs. Vector quality is fake, shape is real.

Image / audio metadata in stub mode looks up `backend/tests/fixtures/stub-ocr/<sha256>.json` keyed by the file bytes. Add a fixture there to give a specific seed binary a realistic title + extracted_text. Without a fixture, the stub falls back to `"(no text content)"` placeholders.
