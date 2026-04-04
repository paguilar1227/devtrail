-- Migration 003: Add extracted_text column for media text extraction
-- Stores text extracted from media (OCR, PDF parsing, audio transcription)
-- via Gemini Flash multimodal, separate from user-provided content.

ALTER TABLE captures ADD COLUMN IF NOT EXISTS extracted_text text;
